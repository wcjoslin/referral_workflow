---
up: "[[📋 PRD Index]]"
prev: "[[PRD-29 - 360X Protocol Gateway]]"
---

# PRD-30: Guest Participation & Secure Invitations

**Status:** Ready for Dev — Phase 2a  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

A referral has two sides, and until now only one of them can see anything. The receiving
organization's only window into a referral is whatever Direct messages arrive in their inbox. If they
have a question, they telephone. If the coordinator has a question, they telephone back. The source
document identifies precisely this as the most differentiated pattern in the adjacent market: Unite
Us lets users at partner organizations communicate based on a shared referral, which "removes the
separate task of locating contacts and gives the receiving organization a direct way to request
information."

This PRD lets a party be invited into a single workspace and act inside it. That is what makes the
protocol gateway (PRD-29) meaningful — without guest access, the gateway only serves the licensed
side, and the counterparty still needs their own 360X implementation to participate.

The design constraint that matters most here is scope. An invitation grants access to **one
workspace**, for **one referral**, for **one patient**, with an expiry. It is not an account. A guest
cannot browse other workspaces, cannot see a queue, cannot see internal comments, cannot see another
patient, and has no presence in the application outside the workspace they were invited to. This is
how the epic can extend the source document's position — external parties become acting participants
— without taking on federated identity, and without turning a referral invitation into a standing
door into PHI.

A guest is deliberately **not** a row in `users`. Internal staff and external guests have different
lifecycles, different scoping and different audit requirements, and merging them is how an external
party accidentally ends up in an internal picker.

### Goal

The primary goal of this feature is to:
1. Let a coordinator **invite a party into one workspace** with a scoped, expiring, revocable link
2. Give that guest a **workspace view containing only what they are entitled to see**, with internal
   material structurally absent rather than hidden
3. Let a guest **act** — post shared comments, upload documents, and make the 360X assertions their
   party role permits
4. Make every guest action and every guest **read** auditable, since access to PHI by an external
   party is the thing a compliance reviewer will ask about first

### Scope

**PHASED, because three of this PRD's four content areas belong to PRDs that do not exist.** Shared
comments are PRD-22, shared documents are PRD-23 and assertions are PRD-29; none is built. Rather
than stub three subsystems, the security-critical machinery ships first and the content areas are
wired as each PRD lands. The split is explicit so a reader can tell a deferral from an omission.

**In Scope — Phase 2a (ships now):**
- Invitations: create, deliver by email, accept, expire, revoke, re-issue
- A guest identity distinct from `users`, scoped to one workspace and bound to one party
- A guest workspace view of what exists today: header, patient, both organizations, the protocol
  timeline, and the guest's own party and protocol mode
- **The single guard.** Every guest route resolves through `requireGuest()`; no guest route accepts a
  workspace id from the client
- Access enforcement, expiry and revocation checked per request, taking effect mid-session
- Audit of invitation, re-issue, revocation, acceptance and denial
- Internal routes rejecting a guest session cookie

**In Scope — Phase 2b (wired when its prerequisite lands):**
- Shared comments and posting one — **PRD-22**
- Shared documents, upload, and the per-view audit event (AC10) — **PRD-23**
- Available assertions and submitting one — **PRD-29**
- The guest-facing activity feed (AC12) — **PRD-25**

`buildGuestPayload()` returns these as empty collections in 2a, with the fields present so the shape
does not change when they are filled. A test asserts they are empty *and* present, so 2b is a wiring
change rather than a shape change.

**Out of Scope:**
- Passwords, SSO, guest self-registration, guest profile management
- A guest account spanning multiple workspaces or a guest "inbox" of their referrals — each
  invitation is independent, and a cross-workspace guest portal is a later phase
- Internal comments, work status, queues, assignment, participants, analytics, other patients —
  none of these are reachable by a guest by any route
- Artifact rendering and delivery — PRD-29
- Patient or caregiver access — explicitly excluded by the epic
- Rate limiting and abuse protection beyond token expiry; a production deployment needs more and the
  PRD should say so

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to invite the receiving organization into this referral so that they can respond without me phoning them

**AC1:** A Manager participant can invite a party by choosing the party and supplying a recipient
email address; the party's Direct address is offered as the default recipient.  
**AC2:** The invitation is delivered through the existing SMTP transport and contains a single-use
tokenized link, the patient's name, the referring organization, and an expiry date.  
**AC3:** The invitation link resolves to the workspace without a password.  
**AC4:** Creating an invitation emits `workspace.guest_invited`; accepting it emits
`workspace.guest_accepted` with the accepting party.

### As an invited specialist, I want to see the referral and respond, so that I can accept or decline without implementing a protocol

**AC5:** The guest view shows the workspace header, the protocol timeline, shared comments, shared
documents, and the assertions available to their party role — and nothing else.  
**AC6:** The guest view contains no internal comment, work status, owner, queue, participant, or
other-patient data — asserted by inspecting the served payload, not by CSS.  
**AC7 (Phase 2b — PRD-22):** A guest can post a comment, and it is created with `Shared`
visibility with no option to choose `Internal`. In 2a the endpoint does not exist; the payload
carries `sharedComments: []` so the field is real before the feature is.  
**AC8 (Phase 2b — PRD-23):** A guest can upload a document, created `Shared` and never
transmitted until 360X context is attached.  
**AC9 (Phase 2b — PRD-29):** A guest can submit an assertion permitted for their party role,
flowing through the gateway identically to a licensed user's.

### As a compliance reviewer, I want every external access to PHI recorded so that I can answer who saw what

**AC10 (Phase 2b — PRD-23):** Every guest document view writes an audit event naming the guest,
the party, the document and the time. There are no documents to view in 2a.  
**AC11:** Every guest action records the guest, the party they acted for, and the invitation used.
This holds in 2a for the actions 2a has — acceptance and denied access — and is satisfied by
`formatGuestActor()` plus the invitation id in the event metadata, so 2b's actions inherit it.  
**AC12 (Phase 2b — PRD-25):** The workspace activity feed distinguishes guest actions from
internal ones, and the feed shown *to* the guest omits internal events. 2a ships the `guest:<id>`
actor prefix the feed will resolve, so the events are already distinguishable in the log.

### As a care coordinator, I want to cut off access when the referral is done or the invitation was a mistake, so that access does not outlive its purpose

**AC13:** Revoking an invitation takes effect on the next request, including for a guest with the page
already open, who receives a clear "access ended" state rather than a broken page.  
**AC14:** An expired invitation cannot be used, and the expired link explains how to request a new
one rather than 404ing silently.  
**AC15:** Re-issuing an invitation invalidates the previous token.  
**AC16:** A default expiry is configured centrally and every invitation has one — an invitation with
no expiry cannot be created.

### As an engineer, I want guest scoping enforced in one place, so that no future route can accidentally widen it

**AC17:** All guest routes resolve through a single guard that maps a token to exactly one
`(workspaceId, partyId)` pair, and no guest route accepts a workspace id from the client.  
**AC18:** A guest request carrying a valid token but a mismatched workspace in the path is rejected,
not served.  
**AC19:** A guest identity can never be inserted into `users`, and no internal picker
(owner, participant, mention) returns a guest.

---

## Technical Specifications

### Dependencies

- [[PRD-24 - Parties & Participants]] — an invitation invites a party (hard prerequisite)
- [[PRD-18 - Workspace Entity & Dual Status]], [[PRD-19 - Workspace Shell]] — the workspace to scope to
- [[PRD-29 - 360X Protocol Gateway]] — the assertion path a guest uses
- [[PRD-22 - Referral Conversation]] — shared comments
- [[PRD-23 - Document Collection]] — shared documents and upload
- `nodemailer` via the existing SMTP transport for invitation delivery
- Node `crypto` for token generation — no new dependency

### Engineering Constraints

- **THE APPLICATION HAS NO AUTHENTICATION ON INTERNAL ROUTES, AND THIS PRD IS WHAT MAKES THAT
  DANGEROUS.** `tryGetActingUser()` reads the `actingUserId` cookie and, when it is absent,
  *falls back to `getDefaultActingUser()`* — the first active user. So any unauthenticated request
  to `/workspaces/:id`, `/api/workspaces/:id` or the dashboard is served as a real staff member.
  PRD-17 recorded that cookie as a simulation rather than a credential, which was defensible while
  every user was internal staff on localhost.

  This PRD hands a URL to an external organization. A guest who follows their invitation link and
  then edits the path to `/workspaces/3` receives the full internal view of a different patient —
  owner, work status, internal fields and all. The guest guard below protects guest routes; **nothing
  protects internal routes from guests.**

  What this PRD does about it, which is a mitigation and not a fix:
  - Internal page and API routes **reject any request carrying a guest session cookie**, closing the
    specific path this PRD opens.
  - The guest session cookie is `HttpOnly`, unlike the acting-user cookie, which is deliberately
    readable by client script.

  What it does not do: make internal routes authenticated. That is a real gate on deploying guest
  access anywhere reachable from the internet, and it is PRD-20's boundary to build. Recorded here,
  in this PRD, because this is the PRD that changes the threat model.
- **One guard, one scope.** Every guest route goes through a single `requireGuest()` middleware that
  resolves the token to one `(workspaceId, partyId)` and attaches it to the request. No guest handler
  reads a workspace id from the path or body. This is the single most important constraint in the PRD;
  it is what makes AC17–AC19 enforceable rather than aspirational.
- **Omit, do not hide.** The guest payload is built by a dedicated function that constructs only
  guest-visible fields. It must not be the internal payload with fields deleted, and it must not rely
  on the client to hide anything.
- Guests are a separate table. A guest is never a `users` row, never appears in `GET /api/users`, and
  never appears in the owner, participant or internal mention pickers.
- Tokens are high-entropy, stored hashed, single-use for acceptance and then exchanged for a
  workspace-scoped session cookie with the same expiry as the invitation. A raw token is never
  logged, never written to the audit metadata, and never included in an error message.
- Revocation and expiry are checked **per request**, not at acceptance. A revoked guest with an open
  page loses access on their next call.
- Guest-authored content defaults to `Shared` and the API rejects an attempt to set `Internal` —
  visibility is not a client choice for a guest.
- Invitation email content must not include clinical detail beyond the patient name and referring
  organization; the referral content lives behind the link, not in the mail.
- **Guest binding — decided: party-scoped access, per-invitation identity.** A guest row binds to a
  `(workspaceId, partyId)` pair and carries **no foreign key to `party_addresses`**. The reasoning:
  what a guest may see is decided by which *organization* they represent, so the party is the access
  scope, and adding an address FK would contribute nothing to that decision while implying the
  address had been verified — which PRD-24 may only have *inferred* from a domain match
  (`matchedOn: 'domain'`).

  Identity and audit live on the invitation instead. Each invitation is its own row with its own
  recipient email, token, expiry and audit trail, so several people at one party hold independent
  invitations; revoking one leaves the others working, and every guest action names the invitation it
  was taken under. The invited email need not be one of the party's observed addresses, which is the
  normal case for a first invitation and would have forced an awkward choice under an address FK.
- **No rate limiting, and none is faked.** There is no rate-limiting middleware anywhere in this
  codebase, so a token-guessing attempt against `GET /guest/:token` is unthrottled. The 256-bit
  token makes guessing impractical rather than merely slow, which is why this is a gap and not a
  hole — but it is a gap, and it belongs on the same deployment gate as the authentication finding
  above.
- **The session cookie is `SameSite=Lax`, not `Strict`.** Strict would block the cookie on a
  top-level navigation from outside the site, so a guest reopening a bookmarked
  `/guest/workspace` would appear signed out. Lax still refuses cross-site POSTs, which is the
  attack that matters here.
- **No shared mail helper exists.** `nodemailer.createTransport` is constructed inline in
  `prd03/schedulingService.ts`, `prd04/consultNoteService.ts`, `prd05/encounterService.ts` and
  `prd01/mdnService.ts`. Invitation delivery is a fifth caller; extract a helper rather than paste a
  fifth copy.

### Data Models

```typescript
// src/db/schema.ts — new
export const workspaceInvitations = sqliteTable(
  'workspace_invitations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),
    partyId: integer('party_id').references(() => workspaceParties.id).notNull(),
    recipientEmail: text('recipient_email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),     // hash only; the raw token is never stored
    invitedByUserId: integer('invited_by_user_id').references(() => users.id).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    revokedByUserId: integer('revoked_by_user_id').references(() => users.id),
    supersededById: integer('superseded_by_id'),          // set when re-issued
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_invitations_workspace').on(table.workspaceId, table.revokedAt),
    tokenIdx: index('idx_workspace_invitations_token').on(table.tokenHash),
  }),
);

export const workspaceGuests = sqliteTable(
  'workspace_guests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    invitationId: integer('invitation_id').references(() => workspaceInvitations.id).notNull(),
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),
    partyId: integer('party_id').references(() => workspaceParties.id).notNull(),
    displayName: text('display_name'),                    // self-supplied on acceptance, optional
    sessionTokenHash: text('session_token_hash'),
    sessionExpiresAt: integer('session_expires_at', { mode: 'timestamp' }),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_guests_workspace').on(table.workspaceId),
    sessionIdx: index('idx_workspace_guests_session').on(table.sessionTokenHash),
  }),
);
```

```typescript
// src/modules/workspace/invitationService.ts — new
export class InvitationExpiredError extends Error {}
export class InvitationRevokedError extends Error {}
export class InvitationScopeMismatchError extends Error {}

export interface Invitation {
  id: number; workspaceId: number; partyId: number; partyOrgName: string;
  recipientEmail: string; expiresAt: Date;
  acceptedAt: Date | null; revokedAt: Date | null;
  invitedByDisplayName: string;
}

export async function createInvitation(
  workspaceId: number, partyId: number, recipientEmail: string, actor: ActingUser, expiresInHours?: number,
): Promise<{ invitation: Invitation; inviteUrl: string }>;   // raw token appears only in inviteUrl
export async function listInvitations(workspaceId: number): Promise<Invitation[]>;
export async function revokeInvitation(invitationId: number, actor: ActingUser): Promise<void>;
export async function reissueInvitation(
  invitationId: number, actor: ActingUser,
): Promise<{ invitation: Invitation; inviteUrl: string }>;
export async function acceptInvitation(
  rawToken: string, displayName?: string,
): Promise<{ guest: GuestContext; sessionToken: string }>;
```

```typescript
// src/modules/workspace/guestAccess.ts — new
export interface GuestContext {
  guestId: number;
  workspaceId: number;       // the only workspace this guest can ever reach
  partyId: number;
  partyRole: PartyRole;
  partyOrgName: string;
  displayName: string | null;
  expiresAt: Date;
}

/** The single guard. Resolves the session cookie; throws on expiry, revocation or scope mismatch. */
export async function requireGuest(req: Request, pathWorkspaceId?: number): Promise<GuestContext>;

export function formatGuestActor(guest: GuestContext): string;   // => `guest:${guest.guestId}`

/** Built from scratch — never the internal payload with fields removed. */
export async function buildGuestPayload(guest: GuestContext): Promise<GuestWorkspacePayload>;

export interface GuestWorkspacePayload {
  workspace: { referralState: ReferralState; patientName: string; patientDob: string;
               reasonForReferral: string | null; initiatingOrg: string; receivingOrg: string };
  protocolTimeline: TimelineStep[];
  sharedComments: SharedComment[];
  sharedDocuments: SharedDocument[];
  availableAssertions: AssertionSpec[];
  party: { orgName: string; partyRole: PartyRole; protocolMode: ProtocolMode };
  guest: { displayName: string | null; expiresAt: string };
}
```

Note the absence: no `workStatus`, no `ownerUserId`, no `queueId`, no `nextAction`, no participants,
no internal comments, no `exceptionReason`. That absence is the security control.

In Phase 2a `sharedComments`, `sharedDocuments` and `availableAssertions` are always `[]` — present
in the shape, empty in fact, so PRD-22/23/29 fill them without changing the contract. Deliberately
NOT omitted: a consumer written against 2a would otherwise break when they appear.

**The message thread is deliberately not in this payload.** `referral_messages` holds the Direct
messages exchanged between the two organizations, and it is tempting to show the guest "their" half.
It is excluded because the rows carry `content_xml`, `content_hl7` and `decline_reason` — the raw
payloads — and because filtering a mixed-direction table down to what one party may see is exactly
the "omit, do not hide" mistake this PRD forbids. If a guest-visible exchange history is wanted, it
is PRD-25's feed, built for the purpose.

Migration: `0014_add_guest_participation.sql` — 0014 confirmed next free (0013 is PRD-24). The
`0019` in the first draft was indicative, as the epic notes for every unrefined child.
Config: a new `config.workspace` section — there is none today — with
`guestInvitationExpiryHours` (default 336, 14 days) and `guestSessionExpiryHours` (default 24), plus
`publicBaseUrl` (default `http://localhost:${PORT}`) because the invitation URL has to be absolute
and nothing in `config.ts` currently knows the app's external address.

Audit events: `workspace.guest_invited`, `workspace.guest_reissued`, `workspace.guest_revoked`,
`workspace.guest_accepted`, `workspace.guest_action`, `workspace.guest_document_viewed`,
`workspace.guest_access_denied`.

### API Design

**Internal (licensed users):**

`POST /api/workspaces/:id/invitations`
```json
{ "partyId": 2, "recipientEmail": "referrals@lakeside.direct.example.org", "expiresInHours": 336 }
```
```json
{ "success": true, "invitationId": 9, "expiresAt": "2026-09-28T00:00:00Z", "emailSent": true }
```
The raw token is never returned to the inviter — it exists only in the delivered email. `403` unless
the acting user is a Manager participant.

`GET /api/workspaces/:id/invitations` → `{ "invitations": [Invitation] }` — status only, no tokens.

`DELETE /api/workspaces/:id/invitations/:invitationId` — revoke, effective immediately.

`POST /api/workspaces/:id/invitations/:invitationId/reissue` — invalidates the previous token.

**Guest-facing:**

`GET /guest/:token` — accept and redirect to the guest workspace, setting the session cookie.
Expired, revoked or unknown tokens render an explanatory page, never a stack trace.

`GET /guest/workspace` — the guest workspace page. Takes no id; the workspace comes from the session.

`GET /api/guest/workspace` → `GuestWorkspacePayload`.

`POST /api/guest/comments` → `{ "body": "..." }` — always `Shared`; an `Internal` visibility in the
body is rejected with `400`.

`POST /api/guest/documents` — upload; always `Shared`, never transmitted without 360X context.

`GET /api/guest/documents/:documentId/content` — `403` unless the document belongs to this workspace
and is `Shared`; every success writes `workspace.guest_document_viewed`.

`POST /api/guest/assertions` — delegates to PRD-29's `submitAssertion()` with the party resolved
from the guest context, never from the request body.

---

## Test Plan

**Unit Tests:**
- `createInvitation()` stores only a hash, and the raw token appears solely in the returned URL
- `createInvitation()` refuses without an expiry and applies the configured default
- `acceptInvitation()` succeeds once, then fails for the same raw token
- `acceptInvitation()` throws `InvitationExpiredError` past expiry and `InvitationRevokedError` after
  revocation
- `requireGuest()` throws on expired session, revoked invitation, and unknown cookie
- `requireGuest()` throws `InvitationScopeMismatchError` when the path workspace differs from the
  session's
- `reissueInvitation()` marks the old row superseded and invalidates its token
- `buildGuestPayload()` output contains none of: `workStatus`, `ownerUserId`, `queueId`, `nextAction`,
  participants, internal comments, `exceptionReason` — asserted by key inspection on the serialized
  payload
- `formatGuestActor()` produces `guest:<id>`
- A guest comment with `visibility: 'Internal'` in the body is rejected

**Integration Tests:**
- Invite, accept, post a shared comment, upload a document, submit an `accept` assertion, and assert
  each appears in the internal workspace with guest attribution
- Revoke mid-session and assert the guest's next request is denied with an access-ended state and a
  `workspace.guest_access_denied` event
- A guest attempting `GET /api/workspaces/:otherId` and `/guest/workspace` with a tampered cookie is
  denied in both cases
- A guest views a shared document and the internal activity feed shows the view with their identity
- `GET /api/users`, the owner picker, the participant picker and the internal mention picker return
  no guests

**Edge Cases:**
- Two invitations outstanding for the same party — the newer supersedes, the older token fails
- Invitation to a party with no Direct address — permitted (they can still collaborate); assertions
  they make are `local-only` per PRD-29
- Guest accepting after the referral reached `Closed-Confirmed` — read access works, assertions are
  empty
- Guest accepting after the workspace is archived — read-only, no actions
- Invitation email fails to send — the invitation is still created and shows as undelivered, with a
  resend action
- Extremely long or malformed token in the path — rejected without a database call

**Security Tests:**
- No raw token in any log line, audit metadata or error response
- A guest session cookie from workspace A cannot read workspace B by any route
- The guest payload is constructed, not filtered — asserted by comparing the payload's key set
  against an explicit allow-list, so a field added to the internal payload cannot leak in. Stronger
  than naming forbidden fields: it fails for fields nobody thought of.
- An internal route carrying a guest session cookie is refused (the mitigation for the
  authentication finding above), asserted on both a page route and an API route
- The invitation token is 256 bits from `crypto.randomBytes`, and only its SHA-256 hash reaches the
  database — asserted by querying the row after creation and matching the hash, never the token

**Regression:**
- All internal routes reject guest session cookies; internal tests unaffected

---

## Deliverables

- `workspace_invitations`, `workspace_guests` in `src/db/schema.ts` + migration
  `0019_add_guest_participation.sql`
- `src/modules/workspace/invitationService.ts`, `src/modules/workspace/guestAccess.ts`
- `src/views/guestWorkspace.html` — a standalone view, not the internal page with panels hidden
- Internal invitation management in the `#wsParticipants` panel
- Guest and internal routes listed above
- `config.workspace.guestInvitationExpiryHours`, `config.workspace.guestSessionExpiryHours`
- `tests/unit/workspace/invitationService.test.ts`,
  `tests/unit/workspace/guestAccess.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]] — the departures this PRD implements
- [[PRD-24 - Parties & Participants]] — hard prerequisite
- [[PRD-29 - 360X Protocol Gateway]] — what a guest's assertions flow through
- [[PRD-22 - Referral Conversation]] — shared vs internal visibility
- [[PRD-23 - Document Collection]] — shared documents and access logging
- [[PRD-25 - Activity History & Audit]] — guest action and view auditing
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-15  
**Version:** 1.0 — first draft.

**Version:** 1.1 — Ready for Dev, split into Phase 2a and 2b, after a codebase pass against the
shipped PRD-17/18/19/21/24.

**The finding that matters most is not in this PRD's own subject matter.** The application has no
authentication on internal routes: `tryGetActingUser()` falls back to the first active user when no
cookie is present, so an unauthenticated request to `/workspaces/:id` is served as real staff. That
was a documented simulation while every user was internal. This PRD hands a URL to an external
organization, which turns it into a PHI exposure — a guest can edit the path and read another
patient's workspace. The PRD now opens with it, ships the proportionate mitigation (internal routes
refuse a guest session cookie; the guest cookie is `HttpOnly`), and states plainly that the real fix
is PRD-20's boundary and a gate on deploying guest access anywhere public.

**Three of four content areas had nothing behind them.** Shared comments (PRD-22), shared documents
(PRD-23) and assertions (PRD-29) are all unbuilt, and with them AC7–AC10 and AC12. Rather than stub
three subsystems, the scope is split: 2a ships the invitation lifecycle, the guest identity, the
single guard and a view of what exists, with the three collections present-but-empty in the payload
so 2b is a wiring change and not a shape change. Each deferred AC now names the PRD it waits on.

**Guest binding resolved: party-scoped access, per-invitation identity.** No FK to
`party_addresses` — the party is the access scope, and an address FK would imply verification PRD-24
may only have inferred from a domain match. Identity, expiry and audit live on the invitation, so
several people at one party hold independent invitations and revoking one leaves the others alone.

**Corrections and additions from the codebase pass:**

- **Migration is 0014, not 0019.** The draft's number was indicative.
- **`config.workspace` does not exist** and has to be created; it also needs `publicBaseUrl`, since
  nothing in `config.ts` knows the app's external address and an invitation URL must be absolute.
- **There is no shared mail helper.** `nodemailer.createTransport` is inline in four services;
  invitation delivery extracts a helper rather than adding a fifth copy.
- **There is no rate-limiting middleware anywhere**, so token guessing is unthrottled. The 256-bit
  token is what makes that impractical; the gap is recorded on the same deployment gate.
- **`SameSite=Lax`, not `Strict`**, with the reason stated — Strict signs a guest out of their own
  bookmark.
- **The message thread is explicitly excluded** from the guest payload, with the reason: the rows
  carry raw C-CDA and HL7 payloads and decline reasons, and filtering a mixed-direction table is the
  "omit, do not hide" mistake this PRD forbids.
- **The constructed-not-filtered test is now an allow-list comparison** rather than a list of
  forbidden keys, so it fails for a leaked field nobody anticipated.
