---
up: "[[📋 PRD Index]]"
prev: "[[PRD-30 - Guest Participation]]"
---

# PRD-31: Caller Authentication

**Status:** Deferred — not scheduled  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`, `server.ts`  
**Epic:** Follow-up to [[PRD-16 - 360X Referral Collaboration Workspace]] — deliberately outside it

---

## Why this document exists

This PRD exists so that "the application has no authentication" is a **named, tracked piece of work**
rather than a comment buried in a schema file or a paragraph inside a feature that did not do it.

It was created by an explicit decision taken while refining [[PRD-20 - Shared Queues & Queue View]].
PRD-20's draft claimed to own the authentication fix, because PRD-20 is where queue membership
becomes a least-privilege boundary and a boundary needs something to authenticate against. That claim
was reassigned: authentication is **deferred out of the PRD-16 epic**, PRD-20 ships queue scoping as
a server-side default without it, and the work lands here.

Nothing in this document is scheduled. It is a correctly-stated problem with its consequences
recorded, which is the whole point.

---

## The current state, stated precisely

`identityService.tryGetActingUser()` reads the `actingUserId` cookie and falls back to
`getDefaultActingUser()` — the first active user — when the cookie is absent. There is no credential
anywhere in the request path.

Consequences, none of them hypothetical:

1. **Every internal page and API is served to an unauthenticated caller as a real staff member.** Not
   as an anonymous or limited principal — as whichever user id the cookie names, or as the first
   active user by default.
2. **The acting-user selector is an impersonation mechanism by design.** Anybody can pick any user
   from the dropdown. PRD-17 recorded this deliberately: signing the cookie would protect nothing and
   would imply a security property that does not exist.
3. **PRD-20's queue scoping is a least-privilege default, not an access control.** The predicate is
   real — every query is constrained by membership server-side, before any user filter, and an
   out-of-scope slug is refused rather than filtered — but the identity it scopes against is
   forgeable, so somebody who wants another queue's rows can claim to be a member of it.
4. **PRD-22's visibility boundary and PRD-23's document gates rest on the same identity.** They are
   correct relative to the identity they are given; they are not stronger than it.

What is already hardened, and should not be confused with authentication:

- PRD-30's guest sessions are a separate identity with their own `HttpOnly` cookie, and internal
  routes refuse a guest cookie. That closes the one externally-reachable path PRD-30 opened. It does
  not make internal routes authenticated.

---

## The consequence that matters operationally

**Deploying this application to a publicly reachable host is gated on this PRD.**

PRD-30 hands an invitation URL to an external organization, which is the first feature in the system
that assumes a reachable host. On localhost the whole identity model is a simulation and that is
fine. The moment the host is reachable, items 1–3 above are live, and item 1 means unauthenticated
PHI access.

This sentence is repeated in the schema comment above `queues` in `src/db/schema.ts` and in PRD-20's
authentication section, so an engineer meets it where they are working rather than only here.

---

## Scope sketch

Not a specification — the shape of the work, so a later refinement does not start from nothing.

**In scope:**
- A real credential and session for internal users, replacing the `actingUserId` cookie as the
  identity of record
- A login surface, and a logout that actually ends a session
- Signed, expiring session cookies, `HttpOnly` and `Secure`
- Keeping the acting-user selector as a **development-only** affordance behind an explicit flag, or
  removing it — it is an impersonation mechanism and cannot coexist with authentication unsupervised
- An audit event for sign-in, sign-out and failed attempts, using the existing PRD-25 catalogue
- A migration path for the seeded demo roster, which has no credentials today

**Explicitly to decide, not assumed:**
- Whether identity is local (password hashes on `users`) or federated (OIDC against an IdP, which is
  what a real deployment would do and what an EHR-adjacent buyer would expect)
- Whether `allQueuesAccess` and `jobRole` stay as they are, or whether real authentication is the
  moment to introduce actual authorization roles. `jobRole` is descriptive today and no code may
  branch on it for access (PRD-17); that rule exists precisely so this decision stays open.
- Session lifetime, and whether concurrent sessions per user are allowed

**Out of scope:**
- Guest identity — PRD-30 owns it and it is already a separate, credentialed path
- Multi-tenancy or organization-scoped identity
- Anything that would change the 360X protocol behaviour; transport identity is PRD-29's

---

## Acceptance sketch

- No internal route resolves an identity from an unsigned, client-settable value
- An unauthenticated request to any internal page or API is refused, not defaulted to a real user
- `tryGetActingUser()`'s fallback to "the first active user" no longer exists in any form
- PRD-20's queue scoping, PRD-22's visibility boundary and PRD-23's document gates are unchanged in
  logic and become real boundaries by virtue of the identity beneath them
- The acting-user selector is absent, or present only behind an explicit development flag that is off
  by default and asserted off in a test

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]] — this is a follow-up, outside it
- [[PRD-17 - Identity & Acting User]] — created the cookie and recorded it as a simulation
- [[PRD-20 - Shared Queues & Queue View]] — reassigned this work here; owns the scoping predicate
- [[PRD-22 - Referral Conversation]] — visibility boundary resting on this identity
- [[PRD-23 - Document Collection]] — document access gates resting on this identity
- [[PRD-30 - Guest Participation]] — the separate guest identity, and the reason reachability matters
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-16  
**Last Updated:** 2026-09-16  
**Version:** 1.0

**v1.0.** Created by the decision taken while refining PRD-20, to defer authentication out of the
PRD-16 epic and make it a named follow-up rather than an unowned comment.
