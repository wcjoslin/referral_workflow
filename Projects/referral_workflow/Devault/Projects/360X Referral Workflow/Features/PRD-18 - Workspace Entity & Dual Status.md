---
up: "[[📋 PRD Index]]"
prev: "[[PRD-17 - Identity & Acting User]]"
---

# PRD-18: Workspace Entity & Dual Status Model

**Status:** Drafting  
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
**AC3:** A protocol transition may *propose* a work status change, and the proposal is applied only
when the work status has not been manually set since the last protocol event; otherwise the proposal
is recorded in the audit log as declined and the manual value stands.  
**AC4:** An invalid work status transition throws `InvalidWorkStatusTransitionError` and writes
nothing.

### As a care coordinator, I want a workspace to exist the moment a referral arrives, so that there is never a referral I cannot collaborate on

**AC5:** `ingestReferral()` creates the workspace row in the same operation that creates the
referral; a referral without a workspace is not a reachable state.  
**AC6:** A backfill script creates workspaces for all pre-existing referrals and is idempotent.  
**AC7:** A newly created workspace has work status `New`, no owner, and a `workspace.created` audit
event naming `system` as the actor.  
**AC8:** An auto-declined referral, which writes no referral row today, does not silently lose its
workspace — it is recorded as an exception for PRD-28 rather than dropped.

### As a care coordinator, I want a referral that has formally closed but still needs internal follow-up to stay visible, so that closing the loop externally does not make work disappear

**AC9:** When `referrals.state` reaches `Closed-Confirmed` while the workspace has open internal items,
the work status becomes `Follow-up-Required` and the external state is untouched.  
**AC10:** A workspace in `Follow-up-Required` cannot be archived; the archive attempt returns a clear
error naming what is still open.  
**AC11:** A workspace can only be archived from `Resolved`, and archival sets `archived_at` without
altering any protocol field.

### As an engineer, I want one service that owns workspace reads and transitions, so that later PRDs do not each invent their own access pattern

**AC12:** `getWorkspaceByReferralId()` and `getWorkspace()` return a typed workspace or null.  
**AC13:** `setWorkStatus()` is the only path that writes `work_status`, and it always emits a
`workspace.work_status_changed` event with from/to and the acting actor.  
**AC14:** Every workspace mutation updates `updated_at`.

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
    workStatus: text('work_status').notNull().default('New'),
    workStatusSetBy: text('work_status_set_by'),        // actor string; null => set by protocol mapping
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
  NEW: 'New',
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

Proposed transition table:

| From | Allowed to |
|---|---|
| `New` | `Triage`, `Exception` |
| `Triage` | `In-Progress`, `Waiting-External`, `Waiting-Internal`, `Exception`, `Resolved` |
| `In-Progress` | `Waiting-External`, `Waiting-Internal`, `Follow-up-Required`, `Exception`, `Resolved` |
| `Waiting-External` | `In-Progress`, `Waiting-Internal`, `Follow-up-Required`, `Exception`, `Resolved` |
| `Waiting-Internal` | `In-Progress`, `Waiting-External`, `Follow-up-Required`, `Exception`, `Resolved` |
| `Follow-up-Required` | `In-Progress`, `Resolved`, `Exception` |
| `Exception` | `Triage`, `In-Progress`, `Resolved` |
| `Resolved` | `In-Progress` *(reopen)*, `Follow-up-Required` |

`Resolved` is deliberately not terminal — a late inbound message can reopen internal work without
touching the protocol state. Archival, not `Resolved`, is the end of the line.

Advisory protocol→work mapping (proposals only, per AC3):

| Protocol state | Proposed work status |
|---|---|
| `Received` | `New` |
| `Acknowledged` | `Triage` |
| `Pending-Information` | `Waiting-External` |
| `Accepted` | `In-Progress` |
| `Scheduled` | `Waiting-External` |
| `Encounter`, `Consult` | `In-Progress` |
| `Declined` | `Resolved` |
| `Closed-Confirmed` | `Resolved`, or `Follow-up-Required` if internal items are open |

```typescript
// src/modules/workspace/workspaceService.ts — new
export interface Workspace { /* row shape above, dates as Date */ }

export async function createWorkspace(referralId: number): Promise<Workspace>;
export async function getWorkspace(id: number): Promise<Workspace | null>;
export async function getWorkspaceByReferralId(referralId: number): Promise<Workspace | null>;

/** The only writer of work_status. Guards, updates, emits. */
export async function setWorkStatus(
  workspaceId: number, next: WorkStatus, actor: string, reason?: string,
): Promise<Workspace>;

/** Called from protocol transitions. Applies only if not manually set since the last protocol event. */
export async function proposeWorkStatus(
  workspaceId: number, proposed: WorkStatus, protocolState: string,
): Promise<{ applied: boolean; workStatus: WorkStatus }>;

export async function archiveWorkspace(workspaceId: number, actor: string): Promise<Workspace>;
export async function hasOpenInternalItems(workspaceId: number): Promise<boolean>;
```

`hasOpenInternalItems()` starts as "work status is not `Resolved`" and is extended by later PRDs
(unresolved exceptions in PRD-28, unacknowledged mentions in PRD-22) without changing its callers.

Migration: `0012_add_referral_workspaces.sql`.

### API Design

No user-facing routes in this PRD — PRD-19 adds them. One internal maintenance route for the demo:

**Endpoint:** `POST /api/workspaces/backfill`

**Response:**
```json
{ "success": true, "created": 42, "skipped": 18 }
```

Idempotent; also exposed as `npm run backfill:workspaces` following the precedent of
`scripts/backfill-thread.ts`.

---

## Test Plan

**Unit Tests:**
- Every allowed transition in the table succeeds and returns the next status
- Every disallowed transition throws `InvalidWorkStatusTransitionError`
- `isValidState()` accepts all eight statuses and rejects arbitrary strings
- `proposeWorkStatus()` applies when the status was last set by the mapping
- `proposeWorkStatus()` declines when the status was manually set since the last protocol event, and
  records the declined proposal
- `setWorkStatus()` emits `workspace.work_status_changed` with correct from/to and actor
- `archiveWorkspace()` refuses from `Follow-up-Required` and from `New`, succeeds from `Resolved`
- `createWorkspace()` is rejected for a referral that already has one

**Integration Tests:**
- Ingest a referral end-to-end and confirm exactly one workspace row with status `New` and a
  `workspace.created` event
- Drive a referral through the full happy path and assert `referrals.state` and `work_status` change
  independently, with the protocol state never written by a work status call
- Set work status manually to `Waiting-Internal`, then drive a protocol transition to `Scheduled`, and
  confirm the manual value survives
- Reach `Closed-Confirmed` with an open internal item and confirm `Follow-up-Required` plus a blocked
  archive
- Run the backfill twice and confirm the second run creates nothing

**Edge Cases:**
- Auto-declined referral (no referral row today) — recorded as an exception, not dropped
- Concurrent work status writes on the same workspace — last write wins, both audited
- A referral deleted out from under a workspace (should be impossible via FK; assert the constraint)
- `next_action_due_at` in the past on creation

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
**Version:** 1.0
