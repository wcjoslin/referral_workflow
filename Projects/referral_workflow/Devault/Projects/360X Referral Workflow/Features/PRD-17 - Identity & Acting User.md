---
up: "[[📋 PRD Index]]"
prev: "[[PRD-16 - 360X Referral Collaboration Workspace]]"
---

# PRD-17: Identity & Acting User Model

**Status:** Ready for Dev  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

The system has no concept of a person. There is no users table, no authentication, no session, and
no identity layer of any kind. Identity is retyped from scratch at every action, across **four**
free-text inputs with two different placeholder conventions — `#clinicianId` and
`#consultClinicianId` in `src/views/referralReview.html` (placeholder `dr-smith`), and
`#clinId-${id}` in both row templates of `src/views/dashboard.html` (placeholder `DR001`) — none of
them validated server-side beyond a truthiness check.

The column behind them, `referrals.clinician_id`, is not actually a clinician column.
`src/modules/prd09/skillActions.ts` writes `SYSTEM-SKILL-${skillName}` and
`src/modules/prd09/pendingInfoChecker.ts` writes `SYSTEM-TIMEOUT`, both routed through
`dispositionService.accept/decline`. Because that service emits `actor: \`clinician:${clinicianId}\``,
the audit log's `clinician:` namespace **already contains non-humans** as `clinician:SYSTEM-SKILL-*`
and `clinician:SYSTEM-TIMEOUT`. The documented prefix convention (`system`, `clinician:<id>`,
`skill:<name>`, `payer:<name>`) is enforced only by habit — `emitEvent()` performs no validation.

The same column also leaks into the UI as a person picker: `analyticsQueries.ts` builds its filter
options with `SELECT DISTINCT clinician_id FROM referrals`, and `src/views/analytics.html` renders
that list as a **Clinician** dropdown — so `SYSTEM-SKILL-payer-network-check` and `SYSTEM-TIMEOUT`
are presented to users as clinicians today. That is a small existing defect this PRD is the right
place to fix.

Every collaboration feature in the epic needs a real actor. An owner has to be a person who can be
assigned work. A comment has to have an author. A participant roster has to list someone. Mentions
have to resolve to a recipient. Access logging has to name who opened a document. None of that can be
built on a free-text field that a coordinator retypes each time.

This PRD adds the smallest identity layer that unblocks the rest of the epic: a `users` table seeded
with the demo staff, and an acting-user selector in the navigation bar. It deliberately stops short
of authentication. This is a workflow simulation; passwords, sessions and credential storage would be
a substantial feature of their own and would not make any collaboration feature better. What matters
is that actions are *attributable* and that an actor is a first-class row other tables can reference.

### Goal

The primary goal of this feature is to:
1. Give the application a **first-class user entity** that the owner, comment author, participant,
   mention and access-log features can all reference by foreign key
2. Make the acting user an **ambient, always-known value** for any request, so no feature has to ask
   a coordinator to retype who they are
3. Extend the existing audit actor convention with `user:<id>` **without breaking** the analytics
   queries that parse the current prefixes

### Scope

**In Scope:**
- A `users` table holding **only real people**, seeded to match the clinician identities already in
  the demo data
- An `identityService` exposing the acting user for a request and the roster for pickers
- An acting-user selector in the shared navigation, persisted in a cookie
- `user:<id>` added to the audit actor vocabulary, alongside the existing prefixes rather than
  replacing any of them
- Replacing **all four** free-text clinician inputs with a picker defaulted to the acting user, while
  leaving `referrals.clinician_id` in place as the disposition record
- An explicit `allQueuesAccess` flag, so PRD-20's queue scope is not a side effect of a job title
- Fixing the analytics Clinician filter so it lists people rather than `SYSTEM-*` strings

**Out of Scope:**
- Passwords, login screens, sessions, tokens, SSO, MFA
- Role-based authorization or permission enforcement — queue-level least privilege is PRD-20,
  workspace-level scoping is PRD-30
- Guest / external identity — that is a distinct entity in PRD-30 and must not be modelled as a user
- System and automation identities as user rows — automation keeps its existing actor strings, and
  `users` is people only
- Rewriting historical `clinician_id` values. The seeded users carry `legacyClinicianId` so the four
  known slugs resolve to people; any other historical free-text value stays as it is and simply
  resolves to nobody
- A general Direct address model. A user may have one address; a party's several addresses are
  PRD-24's problem (see Engineering Constraints)
- Per-user preferences beyond the acting-user cookie

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want the application to know who I am so that my actions are attributed to me without retyping my name

**AC1:** A selector in the navigation bar lists all active users by display name and job role, and
shows the currently acting user.  
**AC2:** Choosing a user persists the selection in a cookie and it survives page navigation and a
browser restart.  
**AC3:** With no cookie set, the acting user resolves to a deterministic default (the first active
user by id) rather than to null, and no page errors on a missing acting user.  
**AC4:** Every page rendered through `injectNav()` shows the selector, on every existing view, with
no per-view markup changes beyond the shared nav constant.

### As a care coordinator, I want my accept/decline decision recorded against my user record so that the disposition history names a real person

**AC5:** All four free-text clinician inputs are replaced by a picker defaulted to the acting user:
`#clinicianId` and `#consultClinicianId` in `referralReview.html`, and `#clinId-${id}` in both row
templates of `dashboard.html`. The two placeholder conventions disappear with them.  
**AC6:** `POST /referrals/:id/disposition` accepts a user id and continues to write
`referrals.clinician_id`, so the existing disposition, override and analytics behaviour is unchanged.  
**AC7:** A disposition made by automation still records its synthetic actor (`SYSTEM-SKILL-<name>`,
`SYSTEM-TIMEOUT`) and is not forced into a user row.  
**AC8:** The provider fields are **not** touched — `#apptProv-${id}` and `#provider` name the
clinician who will see the patient, and the claims and prior-auth signature fields are attestations.
None of them is the acting user, and all stay as they are.

### As an engineer, I want a single way to read the acting user so that every later feature attributes actions the same way

**AC9:** `getActingUser(req)` returns a typed user for any request, never throws, and never returns
null.  
**AC10:** `formatActor(user)` produces `user:<id>`, and the existing `clinician:`, `skill:`, `payer:`
and `system` actor forms continue to be produced unchanged where they are already used.  
**AC11:** The analytics queries that parse actor prefixes
(`src/modules/analytics/analyticsQueries.ts`) return identical results before and after this change
for the seeded dataset.  
**AC12:** `users` contains no system or automation identity — asserted by a test over the seeded
roster that rejects any row whose display name or legacy id matches `SYSTEM-*`.

### As a care coordinator, I want the Clinician filter to list actual people so that I stop seeing automation in a person picker

**AC13:** The analytics Clinician filter options resolve through `users.legacyClinicianId` and show
display names, excluding `SYSTEM-*` values.  
**AC14:** Filtering by a clinician returns the same referrals as before — the filter still reads
`referrals.clinician_id`; only the option list and its labels change.  
**AC15:** A historical `clinician_id` matching no seeded user does not disappear from the data; it is
simply absent from the picker, and the PRD says so.

### As a demo operator, I want realistic staff seeded so that the workspace features have people to assign and mention

**AC16:** `npm run seed` creates exactly this roster, four of whom map to the `clinician_id` values
already present in the demo data so historical rows resolve to people:

| Display name | Job role | `legacyClinicianId` | `directAddress` | `allQueuesAccess` |
|---|---|---|---|---|
| Dr. Emily Chen, MD | clinician | `dr-chen` | `echen@specialist.direct` | false |
| Dr. Raj Patel, MD | clinician | `dr-patel` | `rpatel@specialist.direct` | false |
| Dr. Carlos Rodriguez, MD | clinician | `dr-rodriguez` | `crodriguez@specialist.direct` | false |
| Dr. Sarah Kim, MD | clinician | `dr-kim` | — | false |
| Dana Ruiz | coordinator | — | — | false |
| Priya Raman | coordinator | — | — | false |
| Sam Okafor | scheduler | — | — | false |
| Alex Whitfield | manager | — | — | **true** |

**AC17:** The four clinician display names come from a single shared source, not a copy — the
`PROVIDER_NAMES` map currently at `scripts/seed-full-demo.ts:53-58` is hoisted into the shared seed
module, and `scripts/seed-analytics-demo.ts` (which lists the same four slugs) imports it too.  
**AC18:** Re-running any seed script does not create duplicate users — `seedUsers()` is idempotent
on `email`.  
**AC19:** `npm run seed` seeds users. Note that `scripts/seed-demo.ts` performs no direct inserts
today — it is a wrapper over `processInboundMessage` + `ingestReferral` — so this is a new capability
in that script, not an extension of an existing insert block.  
**AC20:** Individual Direct addresses are on `specialist.direct`, the domain implied by the seeded
`RECEIVING_DIRECT_ADDRESS=receiving@specialist.direct`. One clinician is deliberately left without
one so the fallback to the organization's intake address is exercised.

---

## Technical Specifications

### Dependencies

- `drizzle-orm` + `better-sqlite3` — existing persistence layer; no new dependency
- Cookie parsing — read `req.headers.cookie` directly rather than adding `cookie-parser`; the
  application has no other cookie needs and `express.json()` is currently the only configured parser

### Engineering Constraints

- **The acting-user cookie is not a credential, and nothing about it is a security control.** There
  is no authentication, and the selector itself is the sanctioned way to act as someone else — anyone
  can pick any user from the dropdown. Signing the cookie was considered and rejected: it would
  protect nothing the dropdown does not already give away, while implying a property that does not
  exist. Say this in a code comment at the cookie read, so a later reader does not mistake
  attribution for authorization. It is a simulation limitation, recorded as such.
- **No foreign key may ever be added to `referrals.clinician_id`.** It contains
  `SYSTEM-SKILL-<name>` and `SYSTEM-TIMEOUT` on rows written by `skillActions.ts` and
  `pendingInfoChecker.ts`. It stays a text column and stays the disposition record — the workspace
  owner is `referral_workspaces.owner_user_id` (PRD-18/PRD-21). Do not repurpose it.
- **`clinician:` in the audit log is not a person namespace.** Because the automated paths route
  through `dispositionService`, it already contains `clinician:SYSTEM-SKILL-*` and
  `clinician:SYSTEM-TIMEOUT`. Any consumer that resolves actors to people must tolerate that —
  a note for PRD-25's actor resolver, which must not assume `clinician:` implies a human.
- The `workflow_events.actor` prefix format is load-bearing. `analyticsQueries.ts` parses it with
  `REPLACE(actor, 'skill:', '')` and `LIKE 'payer:%'`; adding `user:` must not alter those results.
  Note that `REPLACE` is a substring replace, not a prefix strip, so a new prefix must not contain
  the literal `skill:` or `payer:`.
- **`jobRole` is descriptive only.** It appears in pickers and the participant roster. No code path
  may branch on it to decide access — that is `allQueuesAccess`, read by PRD-20. Enforce it in
  review: a `jobRole ===` comparison guarding data access is a defect.
- The navigation is a single module-level `NAV_HTML` constant in `src/server.ts` with its design
  tokens copy-pasted into each view. Add the selector there, not per view.
- Guest identity belongs to a separate table in PRD-30. A guest must never be insertable into
  `users`, so any later foreign key to an author has to accommodate both — noted here for PRD-22.
- **This PRD does not model Direct addresses in general.** A user may have one; an organization can
  hold an intake address, departmental addresses and per-clinician addresses simultaneously.
  PRD-24's single `workspace_parties.directAddress` column, PRD-29's send-to routing and PRD-30's
  invitation target all need that cardinality resolved when they are refined. Out of scope here,
  recorded so the single-address assumption does not harden.

### Data Models

```typescript
// src/db/schema.ts — new
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    displayName: text('display_name').notNull(),
    email: text('email').notNull().unique(),

    /**
     * This user's own Direct address within the organization's domain. Nullable, because an
     * organization provisions addresses at whatever granularity it chooses — individual,
     * departmental or organizational are all normal in Direct — and most non-clinical staff have
     * none. ADDITIVE to `config.receiving.directAddress` (the single organizational intake
     * address), never a replacement for it. Read by PRD-29 as the outbound sender/author identity
     * when `senderIdentityMode` is 'individual'; ignored when it is 'organization'.
     */
    directAddress: text('direct_address'),

    /** Descriptive only. No code may branch on this for access — see `allQueuesAccess`. */
    jobRole: text('job_role').notNull(),          // 'coordinator' | 'clinician' | 'scheduler' | 'manager'

    /**
     * The historical `referrals.clinician_id` slug this person was recorded as, e.g. 'dr-chen'.
     * This is what lets the users table and the existing demo data describe the same four people,
     * and what the analytics Clinician filter resolves its labels through. Nullable: most staff
     * have no historical slug.
     */
    legacyClinicianId: text('legacy_clinician_id'),

    /** Explicit grant of the PRD-20 see-all-queues scope. Never inferred from `jobRole`. */
    allQueuesAccess: integer('all_queues_access', { mode: 'boolean' }).notNull().default(false),

    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    legacyIdx: index('idx_users_legacy_clinician').on(table.legacyClinicianId),
  }),
);
```

```typescript
// src/modules/workspace/identityService.ts — new
export type JobRole = 'coordinator' | 'clinician' | 'scheduler' | 'manager';

export interface ActingUser {
  id: number;
  displayName: string;
  email: string;
  directAddress: string | null;
  jobRole: JobRole;              // descriptive; never an access check
  allQueuesAccess: boolean;      // the explicit grant PRD-20 reads
}

export const ACTING_USER_COOKIE = 'actingUserId';

export async function listUsers(includeInactive?: boolean): Promise<ActingUser[]>;
export async function getUser(id: number): Promise<ActingUser | null>;
/** Never throws, never returns null — falls back to the first active user. */
export async function getActingUser(req: Request): Promise<ActingUser>;
export function formatActor(user: ActingUser): string;   // => `user:${user.id}`

/** Resolves a historical clinician_id slug to a person, for the analytics filter labels. */
export async function getUserByLegacyClinicianId(slug: string): Promise<ActingUser | null>;
```

Migration: `0011_add_users.sql` generated by `npm run db:generate`, applied by `npm run db:migrate`.
Note that migrations `0001`–`0004` were hand-written without snapshots; the next generate diffs
against `src/db/migrations/meta/0010_snapshot.json`, which is consistent with the current schema, so
generation is safe. A hand-written migration would need a manual `_journal.json` entry.

### API Design

**Endpoint:** `POST /api/acting-user`

**Request:**
```json
{ "userId": 3 }
```

**Response:**
```json
{ "success": true, "user": { "id": 3, "displayName": "Dana Ruiz", "jobRole": "coordinator", "allQueuesAccess": false } }
```

Sets `actingUserId=3` as a `Path=/`, `SameSite=Lax` cookie. Returns 400 for an unknown or inactive
user id.

**Endpoint:** `GET /api/users`

**Response:**
```json
{
  "users": [
    { "id": 1, "displayName": "Dana Ruiz", "jobRole": "coordinator", "directAddress": null, "allQueuesAccess": false },
    { "id": 4, "displayName": "Dr. Emily Chen, MD", "jobRole": "clinician", "directAddress": "echen@specialist.direct", "allQueuesAccess": false }
  ]
}
```

Used by the nav selector, the owner picker (PRD-21), the participant picker (PRD-24) and the mention
picker (PRD-22).

---

## Test Plan

**Unit Tests:**
- `getActingUser()` with a valid cookie returns that user
- `getActingUser()` with a missing, malformed, unknown or inactive cookie value returns the default
  active user and does not throw
- `formatActor()` produces `user:<id>`, and contains neither the literal `skill:` nor `payer:`
- `listUsers()` excludes inactive users unless asked for them
- `POST /api/acting-user` rejects an unknown id and an inactive user
- `getUserByLegacyClinicianId()` resolves each of the four seeded slugs, and returns null for
  `SYSTEM-TIMEOUT` and for an unknown slug
- `seedUsers()` run twice produces eight users, not sixteen
- The seeded roster contains no row whose display name or `legacyClinicianId` starts with `SYSTEM-`
- Exactly one seeded user has `allQueuesAccess: true`
- Exactly one seeded clinician has a null `directAddress`

**Integration Tests:**
- Seed, select a user in the nav, make a disposition, and confirm the referral and the resulting
  workflow event both name that user
- The nav selector renders on every route that goes through `injectNav()`
- Each of the four replaced inputs submits the acting user without the operator typing anything, from
  both the review page and both dashboard row templates
- The analytics Clinician filter lists the four seeded clinicians by display name and omits
  `SYSTEM-SKILL-*` and `SYSTEM-TIMEOUT`, while filtering by one of them returns the same referral set
  as the pre-change string filter

**Edge Cases:**
- Cookie present but the user row has been deactivated since — falls back, does not error
- No users at all in the database (unseeded install) — pages still render, the selector shows an
  empty state, and no route 500s
- A cookie value that is not a number
- Automation actors (`SYSTEM-SKILL-*`, `SYSTEM-TIMEOUT`) still recorded verbatim, and still appear in
  the referral data even though they are absent from the picker
- A historical `clinician_id` such as `demo-clinician`, `dr-jones` or `dr-smith` that matches no
  seeded user — the referral still filters correctly by that raw value; only the picker omits it
- Two seeded users sharing a display name — permitted, distinguished by id in the selector

**Regression:**
- `tests/unit/analytics/analyticsQueries.test.ts` passes unchanged
- `tests/unit/prd02/dispositionService.test.ts` passes unchanged

---

## Deliverables

- `users` table in `src/db/schema.ts` + migration `0011_add_users.sql` (confirmed next free number;
  `db:generate` diffs safely against `meta/0010_snapshot.json`)
- `src/modules/workspace/identityService.ts`
- Acting-user selector in `NAV_HTML` (`src/server.ts`) + `POST /api/acting-user` + `GET /api/users`
- Clinician picker replacing **all four** free-text inputs: `#clinicianId` and `#consultClinicianId`
  in `src/views/referralReview.html`, `#clinId-${id}` in both row templates of
  `src/views/dashboard.html`
- `scripts/seedUsers.ts` (or `scripts/shared/users.ts`) — the shared roster module, with
  `PROVIDER_NAMES` hoisted out of `scripts/seed-full-demo.ts` and imported by
  `scripts/seed-demo.ts`, `scripts/seed-full-demo.ts` and `scripts/seed-analytics-demo.ts`
- Analytics Clinician filter options resolved through `legacyClinicianId` in
  `src/modules/analytics/analyticsQueries.ts` (`getFilterOptions`) and labelled in
  `src/views/analytics.html`
- `tests/unit/workspace/identityService.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-18 - Workspace Entity & Dual Status]] — consumes `owner_user_id`
- [[PRD-21 - Ownership & Assignment]] — the first real consumer
- [[PRD-30 - Guest Participation]] — external identity, deliberately a separate entity
- [[PRD-02 - Process & Disposition]] — owns `referrals.clinician_id`
- [[PRD-20 - Shared Queues & Queue View]] — reads `allQueuesAccess`
- [[PRD-24 - Parties & Participants]] — party-side Direct addresses and their unresolved cardinality
- [[PRD-25 - Activity History & Audit]] — its actor resolver must tolerate `clinician:SYSTEM-*`
- [[PRD-29 - 360X Protocol Gateway]] — reads `directAddress` under `senderIdentityMode`
- [[PRD-14 - Analytics Agent (Phase 2)]] — owns the Clinician filter being corrected
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-14  
**Version:** 1.1 — refined to implementation-ready. Added `allQueuesAccess` so queue scope is not a
job title; kept `directAddress` and gave it a purpose under a configurable sender identity; fixed the
input count from one to four; added the concrete seed roster and the shared roster module; corrected
the claim that `clinician_id` holds clinicians; added the analytics Clinician picker fix; recorded
the Direct address cardinality gap for PRD-24/29/30.
