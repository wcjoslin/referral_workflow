---
up: "[[📋 PRD Index]]"
prev: "[[PRD-17 - Identity & Acting User]]"
---

# PRD-18: Workspace Entity & Dual Status Model

**Status:** Ready for Dev  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`, `state/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

A referral in this system has exactly one status dimension: `referrals.state`, governed by
`src/state/referralStateMachine.ts` (`Received → Acknowledged → Accepted/Declined/Pending-Information
→ Scheduled → Encounter/No-Show → Consult → Closed → Closed-Confirmed`). That column is the 360X
protocol state — what the counterparty has been told — and it is correctly guarded: every legitimate
change goes through `transition()`.

The problem is that operational reality does not fit in it. A referral sitting in `Accepted` might be
untouched, might be waiting on a payer, might be blocked on missing imaging, might be assigned to
someone on leave. Coordinators cannot tell these apart, and the temptation in that situation is to
bend the protocol state to represent internal progress — which corrupts the one field the
counterparty relies on. The source document's risk table is explicit about this: "Make the
distinction explicit: '360X status' is externally authoritative; 'Work status' represents internal
processing. Never silently overwrite one with the other."

There is also nowhere to record the things a workspace needs: who owns it, which queue it belongs to,
what the next action is, when it is due, the external referral identifier, or whether it is in an
exception condition. None of those exist as columns anywhere.

This PRD creates the workspace row and the second status dimension. It is the structural foundation
for everything else in the epic — nothing in Phases 2 through 4 can be built without it.

### Goal

The primary goal of this feature is to:
1. Create **one persistent workspace row per referral**, automatically, from the existing ingest path
2. Add a **Concord-local work status** with its own guarded state machine, structurally incapable of
   modifying the protocol state
3. Hold the workspace's operational fields — owner, queue, next action, due date, correlation
   identifiers, exception reason — so later PRDs have somewhere to write
4. Resolve the **closure conflict** the source document raises: a protocol lifecycle can close while
   internal follow-up remains open, without reopening the external state

### Scope

**In Scope:**
- A `referral_workspaces` table, one row per referral, with a unique foreign key
- `src/state/workStatusMachine.ts` following the exact shape of the three existing state machines
- Automatic workspace creation on referral ingest, plus a backfill for existing referrals
- An advisory protocol→work status mapping that proposes but never overrides
- The `Follow-up-Required` work status and the archival rule that depends on it
- A workspace service with the read and transition operations later PRDs call

**Out of Scope:**
- The workspace UI — PRD-19
- Computing the *values* of `next_action` / `next_action_due_at` — PRD-26 owns the rules; this PRD
  only provides the columns and writes them when a later PRD supplies them
- Queue creation and routing — PRD-20 (`queue_id` is a plain integer here until then)
- Assignment behaviour — PRD-21 (`owner_user_id` is a nullable FK here)
- Populating `external_referral_id` / `correlation_key` from real inbound identifiers — PRD-28 owns
  correlation; this PRD defines the columns and writes what ingest already knows
- Exception detection — PRD-28; this PRD defines the `Exception` status and `exception_reason`

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to see internal progress separately from what the referring provider has been told, so that I never have to misuse the protocol status to track my own work

**AC1:** Each referral has exactly one workspace row, and it carries a work status independent of
`referrals.state`.  
**AC2:** Changing the work status leaves `referrals.state` byte-identical.  
**AC3:** A protocol transition may *propose* a work status change. The proposal is applied only when
`work_status_is_manual` is false **and** the current status is neither `Exception` nor
`Follow-up-Required`; otherwise nothing is written and a
`workspace.work_status_proposal_declined` event records the proposal, the current status and the
reason it was declined.  
**AC4:** An invalid work status transition throws `InvalidWorkStatusTransitionError` and writes
nothing.  
**AC5:** `resyncWorkStatus()` clears `work_status_is_manual` and applies the mapping for the current
protocol state, so a manual override is never permanent. Without it a single override would freeze
the work status for the life of the workspace.

### As a care coordinator, I want a workspace to exist the moment a referral arrives, so that there is never a referral I cannot collaborate on

**AC6:** `ingestReferral()` creates the workspace row in the same operation that creates the
referral; a referral without a workspace is not a reachable state.  
**AC7:** A backfill script creates workspaces for all pre-existing referrals, idempotent on
`referral_id`, deriving each work status from the advisory mapping against that referral's current
protocol state and recording it as mapping-set (`work_status_is_manual: false`).  
**AC8:** A newly created workspace has work status `Triage`, no owner, and a `workspace.created`
audit event naming `system` as the actor.  
**AC9:** An auto-declined referral gets **no workspace**, because `referralService.autoDecline()`
writes no referral row at all — it sends an RRI and emits `referral.auto_declined` with
`entityId: 0`. This PRD states that plainly rather than implying a gap: there is nothing to attach a
workspace to. The durable record that makes those decisions reviewable is
PRD-28's `auto_declined_referrals` table, and until it exists an auto-declined referral is visible
only as that event. No forward dependency and no silent loss.

### As a care coordinator, I want a referral that has formally closed but still needs internal follow-up to stay visible, so that closing the loop externally does not make work disappear

**AC10:** When `referrals.state` reaches `Closed-Confirmed` while the workspace has open internal
items, the work status becomes `Follow-up-Required` and the external state is untouched. The branch
is computed inside `proposeWorkStatus()`, not by the caller.  
**AC11:** A workspace in `Follow-up-Required` cannot be archived; the archive attempt returns a clear
error naming what is still open.  
**AC12:** A workspace can only be archived from `Resolved`, and archival sets `archived_at` without
altering any protocol field.

### As an engineer, I want one service that owns workspace reads and transitions, so that later PRDs do not each invent their own access pattern

**AC13:** `getWorkspaceByReferralId()` and `getWorkspace()` return a typed workspace or null.  
**AC14:** `setWorkStatus()` is the only path that writes `work_status`, and it always emits a
`workspace.work_status_changed` event with from/to and the acting actor. An applied proposal writes
through the same function.  
**AC15:** `setWorkStatus()` sets `work_status_is_manual: true`; an applied proposal sets it false.  
**AC16:** Every workspace mutation updates `updated_at`.  
**AC17:** `workStatusMachine.ts` exports a function named `transition`, as the other three machines
do, so callers alias it on import (`import { transition as workStatusTransition }`).

---

## Technical Specifications

### Dependencies

- `drizzle-orm` + `better-sqlite3` — existing
- [[PRD-17 - Identity & Acting User]] — `owner_user_id` references `users.id`
- `src/modules/analytics/eventService.ts` — existing `emitEvent()` for audit

### Engineering Constraints

- **The work status machine must copy the existing pattern exactly.** All three current machines
  (`referralStateMachine.ts`, `claimsStateMachine.ts`, `priorAuthStateMachine.ts`) use the identical
  shape: an `as const` status object, a module-private `VALID_TRANSITIONS` record, a `transition()`
  pure guard, an `isValidState()` type predicate, and a named error class. Follow it; do not
  introduce a generic state-machine abstraction.
- `transition()` is a **pure guard** — it does not touch the database. Callers load, guard, update,
  then emit. That is the established convention (see `applyDisposition` in
  `src/modules/prd02/dispositionService.ts`) and this PRD keeps it.
- The workspace must be a **separate table**, not new columns on `referrals`. The referral row is the
  protocol record; keeping the internal collaboration state in its own table is what makes the
  boundary between them auditable and makes "never overwrite" enforceable in code review.
- `referral_workspaces.referral_id` is UNIQUE. One workspace per referral, no exceptions.
- **`workStatusMachine.ts` exports `transition`, like the other three machines.** Three modules
  already export a function of that name, so callers alias on import. Follow the existing convention
  rather than renaming to avoid the collision.
- **Copy `claimsStateMachine.ts` literally**, including the U+2192 arrow in the error message and the
  export order: the `as const` object, the same-name type alias, the module-private
  `VALID_TRANSITIONS`, the error class, `transition()`, `isValidState()`.
- **The advisory mapping lives in one place.** `proposeWorkStatus()` owns it. No call site may
  compute a proposed status itself, or the "never silently overwrite" rule becomes unenforceable in
  review.
- No new dependency on a scheduler or background worker. Workspace creation is synchronous with
  ingest.
- `entity_type` for workspace events is `'referral'` with the referral id, not a new entity type —
  this keeps the existing `idx_workflow_events_entity` index and the analytics queries working. The
  workspace id travels in `metadata`.

### Data Models

```typescript
// src/db/schema.ts — new
export const referralWorkspaces = sqliteTable(
  'referral_workspaces',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    referralId: integer('referral_id').references(() => referrals.id).notNull().unique(),

    // Correlation (populated fully by PRD-28)
    externalReferralId: text('external_referral_id'),   // the 360X referral id preserved across orgs
    correlationKey: text('correlation_key'),            // sender+recipient+patient composite

    // Internal work state — never mirrors referrals.state
    workStatus: text('work_status').notNull().default('Triage'),

    /**
     * True once any actor has set the work status explicitly through setWorkStatus().
     * False when the status was last written by the advisory protocol mapping.
     * This single flag is what makes the mapping advisory: a proposal applies only when it is
     * false. resyncWorkStatus() clears it.
     */
    workStatusIsManual: integer('work_status_is_manual', { mode: 'boolean' }).notNull().default(false),

    // Plain audit detail — who and when. NOT load-bearing for the advisory rule.
    workStatusSetBy: text('work_status_set_by'),
    workStatusSetAt: integer('work_status_set_at', { mode: 'timestamp' }),

    // Ownership (PRD-21) and routing (PRD-20)
    ownerUserId: integer('owner_user_id').references(() => users.id),
    queueId: integer('queue_id'),                       // FK added by PRD-20

    // Next action (values computed by PRD-26)
    nextAction: text('next_action'),
    nextActionDueAt: integer('next_action_due_at', { mode: 'timestamp' }),

    // Exception condition (raised by PRD-28)
    exceptionReason: text('exception_reason'),

    archivedAt: integer('archived_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    referralIdx: index('idx_referral_workspaces_referral').on(table.referralId),
    ownerIdx: index('idx_referral_workspaces_owner').on(table.ownerUserId, table.workStatus),
    queueIdx: index('idx_referral_workspaces_queue').on(table.queueId, table.workStatus),
    dueIdx: index('idx_referral_workspaces_due').on(table.nextActionDueAt),
  }),
);
```

```typescript
// src/state/workStatusMachine.ts — new
export const WorkStatus = {
  TRIAGE: 'Triage',
  IN_PROGRESS: 'In-Progress',
  WAITING_EXTERNAL: 'Waiting-External',
  WAITING_INTERNAL: 'Waiting-Internal',
  FOLLOW_UP_REQUIRED: 'Follow-up-Required',
  EXCEPTION: 'Exception',
  RESOLVED: 'Resolved',
} as const;
export type WorkStatus = (typeof WorkStatus)[keyof typeof WorkStatus];

export class InvalidWorkStatusTransitionError extends Error {
  constructor(from: WorkStatus, to: WorkStatus);
}
export function transition(current: WorkStatus, next: WorkStatus): WorkStatus;
export function isValidState(value: string): value is WorkStatus;
```

**Seven statuses, and `New` is deliberately absent.** A workspace starts at `Triage`. "Nobody has
picked this up yet" is expressed by `owner_user_id IS NULL`, which PRD-21 surfaces explicitly
everywhere a workspace is listed — a separate `New` state would only duplicate it and would be
skipped straight past in practice.

Transition table:

| From | Allowed to |
|---|---|
| `Triage` | `In-Progress`, `Waiting-External`, `Waiting-Internal`, `Follow-up-Required`, `Exception`, `Resolved` |
| `In-Progress` | `Triage`, `Waiting-External`, `Waiting-Internal`, `Follow-up-Required`, `Exception`, `Resolved` |
| `Waiting-External` | `Triage`, `In-Progress`, `Waiting-Internal`, `Follow-up-Required`, `Exception`, `Resolved` |
| `Waiting-Internal` | `Triage`, `In-Progress`, `Waiting-External`, `Follow-up-Required`, `Exception`, `Resolved` |
| `Follow-up-Required` | `In-Progress`, `Exception`, `Resolved` |
| `Exception` | `Triage`, `In-Progress`, `Waiting-External`, `Waiting-Internal`, `Resolved` |
| `Resolved` | `In-Progress`, `Follow-up-Required`, `Exception` |

**Be clear about what this machine buys.** The four active statuses are freely interchangeable, so
the graph is nearly complete and the table is not where the value is. What the machine actually
provides is a single guarded write path and valid-value enforcement — the same properties the other
three machines give their domains. Only three rules are genuinely encoded, and they are the ones
worth reviewing:

1. **`Exception` is reachable from every status.** PRD-28 must always be able to raise one.
2. **A reopen never returns to `Triage`.** From `Resolved` or `Follow-up-Required` the only way back
   into active work is `In-Progress` — you resume work, you do not re-triage it.
3. **No status is terminal.** A late inbound message can reopen internal work without touching the
   protocol state. Archival, not `Resolved`, is the end of the line.

Do not pad the table with invented restrictions to make the machine look busier; a reviewer should be
able to see that the constraint set is small and deliberate.

Advisory protocol→work mapping (proposals only, per AC3):

| Protocol state | Proposed work status |
|---|---|
| `Received`, `Acknowledged` | `Triage` |
| `Pending-Information` | `Waiting-External` |
| `Accepted` | `In-Progress` |
| `Scheduled` | `Waiting-External` |
| `Encounter`, `Consult` | `In-Progress` |
| `No-Show` | `In-Progress` |
| `Declined` | `Resolved` |
| `Closed` | `Waiting-External` |
| `Closed-Confirmed` | `Resolved`, or `Follow-up-Required` when internal items are open |

**The rule, stated precisely enough to implement.** The first draft said a proposal applies "only
when the work status has not been manually set since the last protocol event." That is
unimplementable: `proposeWorkStatus()` is only ever called *from* a protocol transition, so the
condition is always true and the declined path is unreachable. The rule is instead:

```
apply the proposal  ⟺  work_status_is_manual === false
                        AND current status ∉ { Exception, Follow-up-Required }
```

- A manual override is **sticky**. Once a person has taken control of the internal status, protocol
  progress stops rewriting it. That is the intended behaviour, not a limitation.
- `Exception` and `Follow-up-Required` are protected regardless of the flag. A protocol advance must
  never clear an exception PRD-28 raised, or quietly discharge outstanding follow-up.
- `resyncWorkStatus(workspaceId, actor)` is the escape hatch, and it is required, not optional —
  without it one override freezes the work status permanently.
- A declined proposal writes nothing and emits `workspace.work_status_proposal_declined` carrying
  the proposed status, the current status and which of the two conditions declined it. The path is
  reachable and therefore testable.

```typescript
// src/modules/workspace/workspaceService.ts — new
export interface Workspace { /* row shape above, dates as Date */ }

export async function createWorkspace(referralId: number): Promise<Workspace>;
export async function getWorkspace(id: number): Promise<Workspace | null>;
export async function getWorkspaceByReferralId(referralId: number): Promise<Workspace | null>;

/** The only writer of work_status. Guards, updates, emits, sets workStatusIsManual = true. */
export async function setWorkStatus(
  workspaceId: number, next: WorkStatus, actor: string, reason?: string,
): Promise<Workspace>;

/**
 * Called from every protocol transition site. Resolves the mapping for `protocolState` — including
 * the Closed-Confirmed → Resolved | Follow-up-Required branch, computed HERE so each call site
 * stays a one-liner — and applies it only when the AC3 conditions hold. Otherwise writes nothing
 * and emits workspace.work_status_proposal_declined.
 */
export async function proposeWorkStatus(
  workspaceId: number, protocolState: ReferralState, actor: string,
): Promise<{ applied: boolean; workStatus: WorkStatus; declinedReason?: 'manual' | 'protected' }>;

/** Clears workStatusIsManual and applies the mapping for the current protocol state. */
export async function resyncWorkStatus(workspaceId: number, actor: string): Promise<Workspace>;

export async function archiveWorkspace(workspaceId: number, actor: string): Promise<Workspace>;
export async function hasOpenInternalItems(workspaceId: number): Promise<boolean>;
```

Note that `proposeWorkStatus()` no longer takes the proposed status — it derives it. The caller
knows the protocol state it just transitioned to and nothing more, which is what keeps every
transition site a single line and keeps the mapping in one place.

**`hasOpenInternalItems()` — the Phase-1 definition, spelled out so it is testable on day one.**

In this PRD it is exactly:

```
hasOpenInternalItems(workspace)  ≡  workspace.workStatus !== 'Resolved'
```

evaluated against the status *before* the closure proposal is applied. Reading the current work
status to decide what to propose is not circular — the proposal is about the next value, the check is
about the present one. Concretely: a referral reaching `Closed-Confirmed` while its workspace sits at
`In-Progress` or `Waiting-Internal` still has work outstanding, so the proposal resolves to
`Follow-up-Required`; one already at `Resolved` stays `Resolved`.

Later PRDs OR additional sources into the same function without changing any caller — an unresolved
`workspace_exceptions` row (PRD-28), an unacknowledged mention (PRD-22). Each of those PRDs owns
adding its clause and its test.

Migration: `0012_add_referral_workspaces.sql`. Confirmed free after `0011` (PRD-17). The numbers
quoted in PRD-19 … PRD-30 are indicative only and get assigned when each is implemented.

### API Design

No user-facing routes in this PRD — PRD-19 adds them. One internal maintenance route for the demo:

**Endpoint:** `POST /api/workspaces/backfill`

**Response:**
```json
{ "success": true, "created": 42, "skipped": 18 }
```

Idempotent on `referral_id`; also exposed as `npm run backfill:workspaces` following the precedent of
`scripts/backfill-thread.ts`.

Each backfilled workspace derives its work status from the advisory mapping against that referral's
**current** protocol state, written as mapping-set (`work_status_is_manual: false`) so the advisory
rule behaves correctly from then on. Setting everything to `Triage` was considered and rejected: it
would misrepresent a hundred seeded referrals as untriaged and make the queue views useless on first
run. Deriving is also honest about provenance, because the flag records that no person chose these
values.

---

## Test Plan

**Unit Tests:**
- Every allowed transition in the table succeeds and returns the next status
- Every disallowed transition throws `InvalidWorkStatusTransitionError`
- The three encoded rules hold: `Exception` is reachable from all seven statuses; neither `Resolved`
  nor `Follow-up-Required` may go to `Triage`; no status has an empty allowed-to list
- `isValidState()` accepts all seven statuses, and rejects `'New'` along with arbitrary strings
- Every protocol state in `ReferralState` has a mapping entry, and every status the mapping names
  appears in the transition table
- `proposeWorkStatus()` applies when `workStatusIsManual` is false
- `proposeWorkStatus()` declines with `declinedReason: 'manual'` when the flag is true, writes
  nothing, and emits `workspace.work_status_proposal_declined`
- `proposeWorkStatus()` declines with `declinedReason: 'protected'` from `Exception` and from
  `Follow-up-Required` even when the flag is false
- `proposeWorkStatus()` for `Closed-Confirmed` resolves to `Follow-up-Required` when
  `hasOpenInternalItems()` is true and `Resolved` when it is false — the branch is inside the
  function, not the caller
- `resyncWorkStatus()` clears the flag and applies the current mapping
- `setWorkStatus()` emits `workspace.work_status_changed` with correct from/to and actor, and sets
  `workStatusIsManual: true`
- An applied proposal sets `workStatusIsManual: false`
- `hasOpenInternalItems()` is true for every status except `Resolved`
- `archiveWorkspace()` refuses from `Follow-up-Required` and from `Triage`, succeeds from `Resolved`
- `createWorkspace()` is rejected for a referral that already has one

**Integration Tests:**
- Ingest a referral end-to-end and confirm exactly one workspace row with status `Triage`, no owner,
  and a `workspace.created` event
- Drive a referral through the full happy path and assert `referrals.state` and `work_status` change
  independently, with the protocol state never written by a work status call
- Set work status manually to `Waiting-Internal`, then drive a protocol transition to `Scheduled`, and
  confirm the manual value survives and a declined-proposal event was recorded
- Then call `resyncWorkStatus()` and confirm the mapping takes over again
- Reach `Closed-Confirmed` with an open internal item and confirm `Follow-up-Required` plus a blocked
  archive; repeat from `Resolved` and confirm it stays `Resolved` and archives cleanly
- Run the backfill twice and confirm the second run creates nothing, and that a referral in
  `Scheduled` was backfilled to `Waiting-External` rather than `Triage`
- Auto-decline a referral and confirm no workspace row is created and no error is thrown

**Edge Cases:**
- Auto-declined referral — no referral row, therefore no workspace; asserted as intended behaviour
  rather than treated as a failure
- Concurrent work status writes on the same workspace — last write wins, both audited
- A protocol transition on a workspace already in `Exception` — declined as `protected`, exception
  intact
- A referral deleted out from under a workspace (should be impossible via FK; assert the constraint)
- `next_action_due_at` in the past on creation
- Backfill over a referral in a terminal protocol state (`Declined`, `Closed-Confirmed`)

**Regression:**
- All PRD-01 … PRD-15 suites pass unchanged; `referrals.state` semantics are untouched

---

## Deliverables

- `referral_workspaces` in `src/db/schema.ts` + migration `0012_add_referral_workspaces.sql`
- `src/state/workStatusMachine.ts`
- `src/modules/workspace/workspaceService.ts`
- Workspace creation wired into `ingestReferral()` (`src/modules/prd02/referralService.ts`)
- `proposeWorkStatus()` calls added to the existing protocol transition sites
- `scripts/backfill-workspaces.ts` + `npm run backfill:workspaces`
- `tests/unit/workspace/workStatusMachine.test.ts`,
  `tests/unit/workspace/workspaceService.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-17 - Identity & Acting User]] — prerequisite
- [[PRD-19 - Workspace Shell]] — first consumer
- [[PRD-20 - Shared Queues & Queue View]] — owns `queue_id`
- [[PRD-21 - Ownership & Assignment]] — owns `owner_user_id`
- [[PRD-26 - Next Action & Due Dates]] — owns `next_action` values
- [[PRD-28 - Correlation & Exception Queue]] — owns correlation columns and `exception_reason`
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-14  
**Version:** 1.1 — refined to implementation-ready. Collapsed `New` into `Triage` (seven statuses);
stated plainly what the transition table does and does not buy; replaced the unimplementable advisory
rule with the `work_status_is_manual` flag plus `resyncWorkStatus()`, making the declined path
reachable; gave `hasOpenInternalItems()` a concrete Phase-1 definition; corrected the auto-decline
behaviour from a forward dependency on PRD-28 to the truth that no workspace exists; moved the
closure branch inside `proposeWorkStatus()` and gave it an actor; specified backfill derivation.
