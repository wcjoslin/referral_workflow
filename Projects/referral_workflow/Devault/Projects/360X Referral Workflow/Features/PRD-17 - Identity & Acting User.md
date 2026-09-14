---
up: "[[📋 PRD Index]]"
prev: "[[PRD-16 - 360X Referral Collaboration Workspace]]"
---

# PRD-17: Identity & Acting User Model

**Status:** Drafting  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

The system has no concept of a person. There is no users table, no authentication, no session, and
no identity layer of any kind. The only trace of an actor is `referrals.clinician_id` — a nullable
free-text column, populated from a plain text input on the review screen
(`src/views/referralReview.html`, `<input id="clinicianId" placeholder="e.g. dr-smith">`) and
sometimes written by automation as a synthetic string such as `SYSTEM-SKILL-<name>` or
`SYSTEM-TIMEOUT`. The audit log has an `actor` column with a documented prefix convention
(`system`, `clinician:<id>`, `skill:<name>`, `payer:<name>`) that is enforced only by habit.

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
- A `users` table with the staff the demo needs, seeded with the existing demo data
- An `identityService` exposing the acting user for a request and the roster for pickers
- An acting-user selector in the shared navigation, persisted in a cookie
- `user:<id>` added to the audit actor vocabulary
- Replacing the free-text clinician input on the review screen with a picker defaulted to the acting
  user, while leaving `referrals.clinician_id` in place as the disposition record

**Out of Scope:**
- Passwords, login screens, sessions, tokens, SSO, MFA
- Role-based authorization or permission enforcement — queue-level least privilege is PRD-20,
  workspace-level scoping is PRD-30
- Guest / external identity — that is a distinct entity in PRD-30 and must not be modelled as a user
- Migrating historical `clinician_id` strings to user rows (a best-effort match is offered as an
  optional acceptance criterion, not a requirement)
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

**AC5:** The clinician text input on the review screen is replaced by a picker defaulted to the
acting user.  
**AC6:** `POST /referrals/:id/disposition` accepts a user id and continues to write
`referrals.clinician_id`, so the existing disposition, override and analytics behaviour is unchanged.  
**AC7:** A disposition made by automation still records its synthetic actor (`SYSTEM-SKILL-<name>`,
`SYSTEM-TIMEOUT`) and is not forced into a user row.

### As an engineer, I want a single way to read the acting user so that every later feature attributes actions the same way

**AC8:** `getActingUser(req)` returns a typed user for any request, never throws, and never returns
null.  
**AC9:** `formatActor(user)` produces `user:<id>`, and the existing `clinician:`, `skill:`, `payer:`
and `system` actor forms continue to be produced unchanged where they are already used.  
**AC10:** The analytics queries that parse actor prefixes
(`src/modules/analytics/analyticsQueries.ts`) return identical results before and after this change
for the seeded dataset.

### As a demo operator, I want realistic staff seeded so that the workspace features have people to assign and mention

**AC11:** `npm run seed` creates at least five users spanning the job roles the workflow needs:
coordinator, clinician, scheduler, manager.  
**AC12:** Re-running the seed does not create duplicate users.

---

## Technical Specifications

### Dependencies

- `drizzle-orm` + `better-sqlite3` — existing persistence layer; no new dependency
- Cookie parsing — read `req.headers.cookie` directly rather than adding `cookie-parser`; the
  application has no other cookie needs and `express.json()` is currently the only configured parser

### Engineering Constraints

- No authentication. The acting-user cookie is a convenience, not a credential, and the PRD must say
  so in code comments so a later reader does not mistake it for an auth mechanism.
- `referrals.clinician_id` stays a text column. It is the disposition record, not the workspace
  owner (that is `referral_workspaces.owner_user_id`, PRD-18/PRD-21). Do not repurpose it.
- The `workflow_events.actor` prefix format is load-bearing. `analyticsQueries.ts` parses it with
  `REPLACE(actor, 'skill:', '')` and `LIKE 'payer:%'`; adding `user:` must not alter those results.
- The navigation is a single module-level `NAV_HTML` constant in `src/server.ts` with its design
  tokens copy-pasted into each view. Add the selector there, not per view.
- Guest identity belongs to a separate table in PRD-30. A guest must never be insertable into
  `users`, so any later foreign key to an author has to accommodate both — noted here for PRD-22.

### Data Models

```typescript
// src/db/schema.ts — new
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  displayName: text('display_name').notNull(),
  email: text('email').notNull().unique(),
  directAddress: text('direct_address'),        // this user's Direct address, if they have one
  jobRole: text('job_role').notNull(),          // 'coordinator' | 'clinician' | 'scheduler' | 'manager'
  legacyClinicianId: text('legacy_clinician_id'), // maps historical referrals.clinician_id strings
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
```

```typescript
// src/modules/workspace/identityService.ts — new
export type JobRole = 'coordinator' | 'clinician' | 'scheduler' | 'manager';

export interface ActingUser {
  id: number;
  displayName: string;
  email: string;
  directAddress: string | null;
  jobRole: JobRole;
}

export const ACTING_USER_COOKIE = 'actingUserId';

export async function listUsers(includeInactive?: boolean): Promise<ActingUser[]>;
export async function getUser(id: number): Promise<ActingUser | null>;
/** Never throws, never returns null — falls back to the first active user. */
export async function getActingUser(req: Request): Promise<ActingUser>;
export function formatActor(user: ActingUser): string;   // => `user:${user.id}`
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
{ "success": true, "user": { "id": 3, "displayName": "Dana Ruiz", "jobRole": "coordinator" } }
```

Sets `actingUserId=3` as a `Path=/`, `SameSite=Lax` cookie. Returns 400 for an unknown or inactive
user id.

**Endpoint:** `GET /api/users`

**Response:**
```json
{ "users": [{ "id": 1, "displayName": "Dana Ruiz", "jobRole": "coordinator", "directAddress": "druiz@direct.example.org" }] }
```

Used by the nav selector, the owner picker (PRD-21), the participant picker (PRD-24) and the mention
picker (PRD-22).

---

## Test Plan

**Unit Tests:**
- `getActingUser()` with a valid cookie returns that user
- `getActingUser()` with a missing, malformed, unknown or inactive cookie value returns the default
  active user and does not throw
- `formatActor()` produces `user:<id>`
- `listUsers()` excludes inactive users unless asked for them
- `POST /api/acting-user` rejects an unknown id and an inactive user

**Integration Tests:**
- Seed, select a user in the nav, make a disposition, and confirm the referral and the resulting
  workflow event both name that user
- The nav selector renders on every route that goes through `injectNav()`

**Edge Cases:**
- Cookie present but the user row has been deactivated since — falls back, does not error
- No users at all in the database (unseeded install) — pages still render, the selector shows an
  empty state, and no route 500s
- A cookie value that is not a number
- Automation actors (`SYSTEM-SKILL-*`, `SYSTEM-TIMEOUT`) still recorded verbatim

**Regression:**
- `tests/unit/analytics/analyticsQueries.test.ts` passes unchanged
- `tests/unit/prd02/dispositionService.test.ts` passes unchanged

---

## Deliverables

- `users` table in `src/db/schema.ts` + migration `0011_add_users.sql`
- `src/modules/workspace/identityService.ts`
- Acting-user selector in `NAV_HTML` (`src/server.ts`) + `POST /api/acting-user` + `GET /api/users`
- Clinician picker replacing the free-text input in `src/views/referralReview.html`
- User seeding in `scripts/seed-demo.ts` (and the full-demo seed)
- `tests/unit/workspace/identityService.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-18 - Workspace Entity & Dual Status]] — consumes `owner_user_id`
- [[PRD-21 - Ownership & Assignment]] — the first real consumer
- [[PRD-30 - Guest Participation]] — external identity, deliberately a separate entity
- [[PRD-02 - Process & Disposition]] — owns `referrals.clinician_id`
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-14  
**Version:** 1.0
