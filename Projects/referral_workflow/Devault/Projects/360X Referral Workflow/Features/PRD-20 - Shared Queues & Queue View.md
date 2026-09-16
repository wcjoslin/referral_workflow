---
up: "[[📋 PRD Index]]"
prev: "[[PRD-19 - Workspace Shell]]"
---

# PRD-20: Shared Queues & Referral Queue View

**Status:** Refined — ready for implementation  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`, `views/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

There is no queue entity in this system. What look like queues are view-level filters:
`GET /scheduler/queue` selects referrals whose state is `Accepted` or `No-Show`; `GET /claims` and
`GET /prior-auth` do the same for their own tables; the dashboard at `GET /` selects every referral
ordered by creation date and filters by department in the browser. There is no queue membership, no
per-queue ordering, no claim or lock, and no access boundary — every user sees every referral for
every patient.

That last point matters beyond convenience. The source document's PHI position is "apply
least-privilege queue access," and a system where every coordinator sees every patient cannot
implement it. The queue is where that boundary naturally lives: a cardiology coordinator belongs to
the cardiology queue and does not need the behavioural-health referrals.

The source document's MVP asks for a dedicated referral view with "open, waiting, exception, and
completed" states, filterable by status, owner, organization and due date. The pieces to build it
already exist in the codebase: PRD-13 gives a per-referral routing department validated against a
facility catalogue, the analytics page has a filter panel with active-filter chips and day-range
buttons, and the dashboard has a table with an expanding row preview.

### Goal

The primary goal of this feature is to:
1. Make the **queue a real entity** with membership, so work can be routed to a team rather than to
   everyone
2. Provide the **referral queue view** the source document specifies — open, waiting, exception,
   completed — filterable by status, owner, organization and due date
3. **Route new workspaces automatically** to the right queue using the department classification
   PRD-13 already produces
4. Establish **least-privilege access** so a user sees the queues they belong to, not every patient
   in the system

### Scope

**In Scope:**
- `queues` and `queue_members` tables, with an access level per member
- Automatic routing of a new workspace to a queue based on `referrals.routing_department`
- A default catch-all queue for workspaces that do not match a department
- `GET /queues` and `GET /queues/:slug` with Open / Waiting / Exception / Completed tabs
- Filters: work status, protocol status, owner, party organization, due date range, department
- Per-user saved filters
- Manual re-queue of a workspace, audited
- Queue-scoped access: a user sees workspaces in queues they belong to
- An optional `route-to-queue` skill action so PRD-09 rules can route

**Out of Scope:**
- Workload balancing, capacity limits, round-robin assignment — later phase
- Queue-level SLA policies; due dates are PRD-26 and are per workspace
- Replacing the existing dashboard, scheduler queue, claims queue or prior auth queue — they keep
  working; this is an additional, workspace-centric view
- Guest access to any queue surface — explicitly never
- Organization-wide roles or an admin console for queue management; queues are seeded and editable
  through a minimal API in this PRD

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to see my team's referrals rather than every referral in the building

**AC1:** A user belonging to one or more queues sees only workspaces in those queues by default.  
**AC2:** A user belonging to no queue sees an explanatory empty state, not every workspace.  
**AC3:** A user with `users.allQueuesAccess` set — for a manager or the demo operator — can see all
queues. The grant is an explicit column (PRD-17), never inferred from `jobRole` or from an empty
membership list.  
**AC4:** Queue scoping is enforced server-side; a client cannot request a queue it does not belong to
and receive data.

### As a care coordinator, I want a referral queue organised by what needs attention so that I can work top-down

**AC5:** The queue view has four tabs: Open, Waiting, Exception, Completed, mapped from work status —
Open (`Triage`, `In-Progress`), Waiting (`Waiting-External`, `Waiting-Internal`), Exception
(`Exception`), Completed (`Resolved`, `Follow-up-Required` shown with a distinct marker). Workspaces
nobody has picked up are surfaced by the unassigned-owner filter, not by a separate status.  
**AC6:** Each tab shows a count, and the counts are computed within the user's queue scope.  
**AC7:** Rows show patient, both statuses, owner, party organization, next action and due date, with
overdue rows visibly marked.  
**AC8:** Default ordering is due date ascending with nulls last, then created date descending.  
**AC9:** A row expands to the existing referral preview and links to the workspace.

### As a care coordinator, I want to filter the queue so that I can find a specific slice of work

**AC10:** Filters exist for work status, protocol status, owner (including "unassigned" and "me"),
party organization, department and due-date range.  
**AC11:** Active filters are shown as removable chips, and a reset clears all of them.  
**AC12:** A filter set can be saved with a name and reapplied, per user.  
**AC13:** Filtering is server-side, so a queue with thousands of workspaces stays usable.

### As a care coordinator, I want new referrals to land in the right queue without me sorting them

**AC14:** On workspace creation, the workspace is routed to the queue whose department filter matches
`referrals.routing_department`.  
**AC15:** A workspace whose department matches no queue is routed to the default queue and flagged in
the queue view as needing triage.  
**AC16:** Routing emits `workspace.queue_changed` with the resolved queue and the reason.  
**AC17:** A coordinator can move a workspace to a different queue, and the change is audited with the
previous queue.  
**AC18:** Changing `referrals.routing_department` after creation does not silently re-queue an
owned workspace; it offers the move rather than performing it.

---

## Authentication — explicitly deferred out of this epic (decision)

The draft of this PRD claimed to own the fix for the application having no authentication. **It does
not.** That was reassigned by an explicit decision during refinement: authentication is deferred out
of the epic to **[[PRD-31 - Caller Authentication]]**, and this PRD ships queue scoping without it.

The finding itself stands and is unchanged. `identityService.tryGetActingUser()` reads the
`actingUserId` cookie and falls back to `getDefaultActingUser()` — the first active user — when it is
absent. Every internal page and API is therefore served to an unauthenticated caller as a real staff
member. PRD-17 recorded that cookie as a simulation rather than a credential; PRD-30 hardened the one
path it opened (internal routes refuse a guest cookie, the guest cookie is `HttpOnly`) without making
internal routes authenticated.

**What this PRD therefore builds, stated precisely so no later reader overstates it.** Queue scoping
here is a *server-side least-privilege default*, not an access control:

- It IS real in the sense that matters for correctness: every query is constrained by the acting
  user's membership **before** any user-supplied filter is applied, so a client cannot widen its own
  scope by editing a query parameter, and an out-of-scope slug is refused rather than filtered. That
  is worth having on its own — it is what stops the queue view from being a browser-side illusion
  like the dashboard's department filter.
- It is NOT a PHI boundary, because the identity it scopes against is a cookie anybody can set.
  Somebody who wants another queue's rows can claim to be a user who belongs to it. No comment, test
  name or PRD sentence in this feature may imply otherwise.

The consequence is recorded rather than hidden: **deploying this application to a publicly reachable
host is gated on PRD-31**, and the schema comment above `queues` in `src/db/schema.ts` says the same
thing at the place an engineer will actually read it. The security tests in this PRD assert the
predicate (an out-of-scope slug returns 403 and no rows, no queue route accepts a guest session) and
deliberately do not assert an authentication property that does not exist.

---

## Technical Specifications

### Dependencies

- [[PRD-17 - Identity & Acting User]] — queue membership references users
- [[PRD-18 - Workspace Entity & Dual Status]] — `referral_workspaces.queue_id` already exists
- [[PRD-13 - Department Classification]] — `routing_department` is the routing key
- `src/modules/prd03/resourceCalendar.ts` — `getDepartments()` is the department vocabulary
- [[PRD-24 - Parties & Participants]] — party organization filter
- [[PRD-26 - Next Action & Due Dates]] — due date values; this PRD sorts and filters on them

### Engineering Constraints

- `referral_workspaces.queue_id` was created by PRD-18 as a plain integer. This PRD adds the real
  foreign key in its own migration rather than changing PRD-18's. **This is not a one-liner and the
  draft was wrong to imply it was** — see *Migrations* below for what it actually takes.
- Department values must be validated against `getDepartments()`, matching the existing behaviour of
  `POST /api/referrals/:id/routing`, which falls back to `Unassigned`. A queue's department filter
  referencing a department not in the catalogue is a configuration error and should be reported.
- **Filtering and sorting move server-side.** The dashboard filters in the browser today, which is
  fine for a demo dataset and wrong for a queue. Build the query with Drizzle conditions; the indexes
  on `(queue_id, work_status)`, `(owner_user_id, work_status)` and `(next_action_due_at)` from PRD-18
  exist for this.
- **Queue scope is a server-side predicate, not a UI filter.** Every query in this PRD is constrained
  by the acting user's queue membership before any user-supplied filter is applied. This is the
  mechanism that makes the source document's least-privilege position real, so it must not be
  implemented as a default value the client can override.
- Guests have no queue routes at all. Not filtered, not scoped — absent.
- Reuse the analytics filter-panel component vocabulary (`.filter-panel`, `.filter-group`,
  `.filter-select`, `.day-btn`, `.active-tag`, `.reset-btn`) and the dashboard's row preview
  (`togglePreview()`, `GET /api/referrals/:id/preview`). Do not build a new filter component.
- Tab-to-work-status mapping lives in one exported constant, so the queue view, the counts and any
  later consumer cannot disagree about what "Waiting" means.

### Data Models

```typescript
// src/db/schema.ts — new
export const queues = sqliteTable(
  'queues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    departmentFilter: text('department_filter'),   // matches referrals.routing_department; null => none
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({ slugIdx: index('idx_queues_slug').on(table.slug) }),
);

export const queueMembers = sqliteTable(
  'queue_members',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    queueId: integer('queue_id').references(() => queues.id).notNull(),
    userId: integer('user_id').references(() => users.id).notNull(),
    accessLevel: text('access_level').notNull().default('member'),  // 'member' | 'manager'
    addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    queueIdx: index('idx_queue_members_queue').on(table.queueId),
    userIdx: index('idx_queue_members_user').on(table.userId),
    // Added in refinement, not in the draft. One membership row per person per
    // queue, so re-adding revives rather than duplicating — the same shape
    // PRD-24 used for participants. Without it, "is this user in this queue"
    // has no single answer and getVisibleQueueIds() returns duplicate ids.
    uniqueIdx: uniqueIndex('idx_queue_members_unique').on(table.queueId, table.userId),
  }),
);

export const savedFilters = sqliteTable(
  'saved_filters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').references(() => users.id).notNull(),
    name: text('name').notNull(),
    surface: text('surface').notNull().default('queue'),
    filtersJson: text('filters_json').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    userIdx: index('idx_saved_filters_user').on(table.userId, table.surface),
    // Added in refinement. Saving over an existing name must replace it, and
    // AC12 ("saved with a name and reapplied") has no meaning if one user can
    // hold two different filter sets under the same name on the same surface.
    uniqueIdx: uniqueIndex('idx_saved_filters_name').on(table.userId, table.surface, table.name),
  }),
);
```

Exactly one queue has `isDefault: true`; enforce it in the service and assert it in a test.
The see-all-queues scope is granted by `users.allQueuesAccess` (PRD-17) — an explicit boolean, not a
`jobRole` comparison. `jobRole` is descriptive only; branching on it for data access is a defect.

**Department vocabulary — RESOLVED by reconciling the catalogue.** The draft recorded this as an
open question and was right on both counts. Measured rather than guessed at — and measured across
**both** seed scripts, which is the part the first refinement pass got wrong.

`scripts/seed-analytics-demo.ts` declares its own six-department vocabulary and assigns one at
random per referral (`pickOne(DEPARTMENTS)`), so exact counts move between runs — what is stable is
which departments appear at all:

| Department | In `getDepartments()` before this PRD? |
|---|---|
| Cardiology | yes |
| Neurology | yes |
| Orthopedics | yes |
| Gastroenterology | yes |
| **Oncology** | **no** |
| **General Surgery** | **no** |

Two of the six had no queue to route to. Across observed 80-referral runs that was **~25 referrals,
roughly a quarter of the dataset**, landing in default triage — and because assignment is random, the
exact figure is not reproducible, which is itself a reason to assert the invariant rather than a
count.

**Correction, recorded rather than quietly fixed.** The first refinement pass measured only the
full-demo database, found `Oncology` (17 referrals) and no `General Surgery`, and wrote that
`General Surgery` "is not actually used by any seed". That was wrong: it is used by the analytics
seed, which is the dataset the queue view is most likely to be demonstrated against. The draft PRD
had flagged both departments and was correct about both.

**Decision: add both `Oncology` and `General Surgery` to `resourceCalendar.getCatalogue()`**, each as
two resources in that department, so the two vocabularies agree. `General Surgery` is deliberately
its own department rather than folded into the existing `General`, which is generic exam rooms
rather than a surgical specialty.

Relying on the default queue instead was the alternative and is rejected: it would put roughly a
quarter of the primary demo dataset into a "needs triage" state that is an artefact of a catalogue
omission rather than a real routing failure, which makes the `needsTriage` flag useless as a signal.

**Verified on real seeded data** after the change — 80 referrals, `backfill:workspaces` then
`backfill:queues`. The per-department numbers vary per run; these two do not, and they are the
claim:

```
unrouted: 0        (a null queue_id is invisible in EVERY queue view, not merely unsorted)
in default/triage: 0
```

One observed run, for shape only: `cardiology 20, oncology 14, general-surgery 14, orthopedics 13,
gastroenterology 10, neurology 9`. `backfill:queues` reported `routed 0, already routed 80` on both
runs, because `backfill:workspaces` goes through `createWorkspace()` which already routes — which is
the idempotence claim demonstrated rather than asserted.

Four catalogue departments (Endocrinology, General, Imaging, Physical Therapy) get no referrals from
either seed. That is harmless: their queues exist and are empty. The default `general-intake` queue
still exists and is still exercised — by referrals whose `routing_department` is `Unassigned`, which
is the genuine no-match case `needsTriage` is for.

`tests/unit/workspace/queueService.test.ts` pins this: every department the seeds use resolves to a
queue of its own rather than falling back, so a future catalogue edit that drops one fails a test
instead of silently sending 11 referrals to triage.

```typescript
// src/modules/workspace/queueService.ts — new
export type QueueTab = 'open' | 'waiting' | 'exception' | 'completed';

export const TAB_WORK_STATUSES: Record<QueueTab, WorkStatus[]> = {
  open:      [WorkStatus.TRIAGE, WorkStatus.IN_PROGRESS],
  waiting:   [WorkStatus.WAITING_EXTERNAL, WorkStatus.WAITING_INTERNAL],
  exception: [WorkStatus.EXCEPTION],
  completed: [WorkStatus.RESOLVED, WorkStatus.FOLLOW_UP_REQUIRED],
};

export interface QueueFilters {
  tab?: QueueTab;
  workStatus?: WorkStatus[];
  referralState?: ReferralState[];
  ownerUserId?: number | 'unassigned' | 'me';
  partyOrgName?: string;
  department?: string;
  dueBefore?: Date;
  dueAfter?: Date;
  overdueOnly?: boolean;
}

export interface QueueRow {
  workspaceId: number; referralId: number;
  patientName: string; patientDob: string;
  referralState: ReferralState; workStatus: WorkStatus;
  ownerDisplayName: string | null;
  initiatingOrgName: string | null;
  department: string;
  nextAction: string | null; nextActionDueAt: Date | null; overdue: boolean;
  needsTriage: boolean;              // routed to the default queue with no department match
  createdAt: Date;
}

/** Scope resolution happens here, before any user filter is applied. */
export async function getVisibleQueueIds(user: ActingUser): Promise<number[] | 'all'>;
export async function listQueues(user: ActingUser): Promise<QueueSummary[]>;
export async function getQueueRows(
  user: ActingUser, queueSlug: string | 'all', filters: QueueFilters,
): Promise<{ rows: QueueRow[]; counts: Record<QueueTab, number> }>;

/**
 * Corrected in refinement. The draft returned a bare queue id, but the CALLER
 * needs to know whether the department matched or fell back — AC15's
 * `needsTriage` flag and AC16's routing `reason` are both that fact, and
 * re-deriving it by comparing the resolved queue against the default queue is
 * the kind of duplicated inference that drifts.
 */
export async function resolveQueueForDepartment(
  department: string,
): Promise<{ queueId: number; matched: boolean; reason: QueueRoutingReason }>;
export async function routeWorkspace(workspaceId: number, actor: string): Promise<number>;
export async function moveWorkspace(
  workspaceId: number, toQueueId: number, actor: ActingUser, reason?: string,
): Promise<void>;
```

### Migrations

The draft said `0016_add_queues.sql` doing everything at once. Numbers in the unrefined children were
always indicative, and 0016/0017 went to PRD-22/23. What actually ships is **two** migrations,
because the two halves have very different risk:

- **`0018_closed_peter_parker.sql`** — creates `queues`, `queue_members` and `saved_filters`.
  Ordinary additive DDL. Note that `queue_members` is emitted *before* `queues` and carries an FK to
  it; that is fine, and verified — SQLite resolves foreign-key targets at DML time, not DDL time, and
  the constraint enforces correctly afterwards.
- **`0019_serious_loners.sql`** — adds the real `queue_id` foreign key. SQLite cannot add a
  constraint in place, so drizzle-kit recreates `referral_workspaces`: create `__new_`, copy all 16
  columns, drop, rename, recreate all 5 indexes.

**The second one is hand-edited, and this is the important finding of this PRD's implementation.**
drizzle-kit generated `PRAGMA foreign_keys=OFF` around the recreation. That pragma is a **no-op
inside a transaction**, and drizzle's migrator runs every migration in one — so foreign keys stayed
enforced through the `DROP TABLE`, against the **nine** tables that reference `referral_workspaces`
(`party_addresses`, `workspace_participants`, `workspace_parties`, `workspace_guests`,
`workspace_invitations`, `workspace_assertions`, `comment_mentions`, `referral_comments`,
`workspace_documents`).

Verified empirically, and the failure mode is the nasty one: **it applies to an empty database and
fails on a populated one.** It would have passed CI and broken the demo database, which is the worst
possible place for a migration bug to hide.

The fix is `PRAGMA defer_foreign_keys` instead, which *does* take effect inside a transaction —
enforcement moves to `COMMIT`, by which point the table has been recreated and every child row
resolves again. Verified on a populated database: row values byte-identical, child rows preserved,
all nine child foreign keys still pointing at `referral_workspaces`, `foreign_key_check` empty,
`integrity_check` ok, all five indexes recreated, no `__new_` table left behind, and the new
constraint genuinely rejecting a dangling `queue_id` while accepting a valid one.

Because a future drizzle-kit table recreation would silently reintroduce this,
`tests/unit/workspace/dbMigrations.test.ts` fails if any migration contains a non-commented
`PRAGMA foreign_keys=OFF`, and separately migrates a **populated** database through the whole folder.
0019 is the only table recreation in the repository today, so there is no pre-existing instance of
the bug.

Queue seeding is **not** in the migration. It lives in `seedQueues()` alongside the other seeds, for
the reason PRD-17's `seedUsers()` does: seeding is idempotent application logic that has to re-run
against an existing database, and a migration runs exactly once.

Audit events: `workspace.queue_changed`, `queue.member_added`, `queue.member_removed`.

### API Design

**Page:** `GET /queues` — queue list with per-queue tab counts, scoped to the user.
**Page:** `GET /queues/:slug` — the queue view. `403` for a queue outside the user's scope.

**Endpoint:** `GET /api/queues/:slug/rows`

**Query:** `?tab=waiting&owner=unassigned&department=Cardiology&dueBefore=2026-09-20&overdueOnly=1`

**Response:**
```json
{
  "queue": { "slug": "cardiology", "name": "Cardiology" },
  "counts": { "open": 12, "waiting": 5, "exception": 1, "completed": 40 },
  "rows": [
    { "workspaceId": 12, "referralId": 31, "patientName": "R. Alvarez",
      "referralState": "Scheduled", "workStatus": "Waiting-External",
      "ownerDisplayName": null, "initiatingOrgName": "Northside Primary Care",
      "department": "Cardiology", "nextAction": "Awaiting appointment confirmation",
      "nextActionDueAt": "2026-09-16T14:00:00Z", "overdue": false,
      "needsTriage": false, "createdAt": "2026-09-10T09:14:00Z" }
  ]
}
```

**Endpoint:** `POST /api/workspaces/:id/queue` — `{ "queueId": 4, "reason": "wrong department" }`

**Endpoints:** `GET`/`POST`/`DELETE /api/saved-filters` — per-user named filter sets.

**Endpoints:** `POST`/`DELETE /api/queues/:slug/members` — membership management; requires a queue
`manager` or a user with the `manager` job role.

---

## Test Plan

**Unit Tests:**
- `TAB_WORK_STATUSES` covers every `WorkStatus` exactly once across the four tabs
- `getVisibleQueueIds()` returns the user's memberships, and `'all'` for a manager
- `getQueueRows()` applies queue scope before user filters — a filter naming an out-of-scope queue
  returns nothing rather than that queue's rows
- Ordering: due date ascending with nulls last, then created date descending
- `resolveQueueForDepartment()` matches a department queue, and falls back to the default queue for an
  unknown department, setting `needsTriage`
- Exactly one queue is `isDefault`
- `moveWorkspace()` emits `workspace.queue_changed` with the previous queue
- `routeWorkspace()` is idempotent for an already-routed workspace
- Each filter narrows correctly and combinations compose

**Integration Tests:**
- Seed queues from the department catalogue, ingest referrals across departments, and assert each
  lands in the right queue
- A user in one queue sees only that queue's rows; a manager sees all
- A user in no queue sees the empty state, not every workspace
- Change a workspace's department after creation and confirm it is not silently re-queued
- Save a filter, reload, reapply, and assert identical rows

**Edge Cases:**
- Queue whose `departmentFilter` names a department no longer in the catalogue — reported as
  misconfigured, workspaces still route to the default
- A workspace with `routing_department = 'Unassigned'` — default queue, `needsTriage: true`
- Two queues claiming the same department — deterministic resolution by queue id, reported as
  misconfigured
- Deactivating a queue that holds workspaces — workspaces are moved to the default queue, audited
- A queue with several thousand workspaces — server-side filtering keeps the response bounded

**Security Tests:**
- No queue route accepts a guest session
- Requesting `/api/queues/:slug/rows` for an out-of-scope queue returns 403 and no data
- Scope is applied before the user filter: a user who passes `?queue=` or any other parameter naming
  a queue they do not belong to gets nothing, not that queue's rows

**Migration Tests** (`dbMigrations.test.ts`, added in refinement):
- No migration contains a non-commented `PRAGMA foreign_keys=OFF`
- The whole folder applies to an empty database with `integrity_check` ok
- The whole folder applies to a **populated** database — a workspace with child rows — preserving
  row values and child counts, and is replayable
- `queue_id` genuinely enforces: a dangling id is rejected, a valid one accepted
- All five `referral_workspaces` indexes survive the recreation
- All nine child foreign keys still point at `referral_workspaces`

**Regression:**
- `GET /`, `GET /scheduler/queue`, `GET /claims`, `GET /prior-auth` are unchanged

---

## Deliverables

- `queues`, `queue_members`, `saved_filters` in `src/db/schema.ts`
- Migration `0018_closed_peter_parker.sql` (the three tables) and `0019_serious_loners.sql` (the
  `queue_id` foreign key, hand-edited to `defer_foreign_keys` — see *Migrations*)
- `src/modules/workspace/queueService.ts`
- `src/views/queueView.html` and `src/views/queueList.html`
- Routes listed above
- `Oncology` and `General Surgery` added to `src/modules/prd03/resourceCalendar.ts` to reconcile the
  department vocabulary
- `seedQueues()` wired into the seed scripts; `scripts/backfill-queues.ts` for existing workspaces
- Routing wired into `createWorkspace()`
- `tests/unit/workspace/queueService.test.ts`
- `tests/unit/workspace/dbMigrations.test.ts` — the migration guard described under *Migrations*

**Dropped from the draft:** the `route-to-queue` skill action. PRD-09 rules act on referrals, and
routing already happens unconditionally at workspace creation from the same `routing_department` a
skill would set — so the action would be a second way to do what `createWorkspace()` already does,
with no caller asking for it. Re-queueing by hand is `POST /api/workspaces/:id/queue`. Recorded here
rather than silently omitted.

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-13 - Department Classification]] — the routing key
- [[PRD-18 - Workspace Entity & Dual Status]] — owns `queue_id`
- [[PRD-21 - Ownership & Assignment]] — claiming from a queue
- [[PRD-26 - Next Action & Due Dates]] — the due dates this view sorts by
- [[PRD-28 - Correlation & Exception Queue]] — populates the Exception tab
- [[PRD-31 - Caller Authentication]] — the deferred authentication work this PRD's scoping rests on
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-16  
**Version:** 1.1

**v1.1 — refinement.** Authentication reassigned out of this PRD to PRD-31 by explicit decision, with
what queue scoping does and does not guarantee stated precisely. Department vocabulary resolved by
measuring both seed datasets and adding `Oncology` and `General Surgery` to the catalogue — the first
pass measured only the full-demo database and wrongly dismissed `General Surgery`, which the
verification step against real seeded data caught. Migration plan corrected to two
migrations with the `PRAGMA foreign_keys=OFF` no-op-in-transaction finding recorded and guarded by a
test. `resolveQueueForDepartment()` now returns the match reason rather than a bare id. Two unique
indexes added to the schema. `route-to-queue` skill action dropped with the reason recorded.
