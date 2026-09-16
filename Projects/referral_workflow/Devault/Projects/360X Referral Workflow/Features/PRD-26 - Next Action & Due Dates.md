---
up: "[[📋 PRD Index]]"
prev: "[[PRD-25 - Activity History & Audit]]"
---

# PRD-26: Next Action & Due Dates

**Status:** Refined — implemented  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

The epic's headline claim is that the workspace answers "who owns the next action." PRD-21 supplies
the *who*. This PRD supplies the *what* and the *by when*.

Today a coordinator infers the next action from the protocol state, which works only if they already
know the protocol. A referral in `Pending-Information` means someone should be chasing the referring
office, but nothing says so, nothing says by when, and nothing notices if it never happens. The one
piece of deadline machinery that exists — `src/modules/prd07/overdueChecker.ts`, which finds outbound
messages unacknowledged for 48 hours — is **not wired into the application at all**. Nothing calls
`checkAndLogOverdue()`, no route exposes `getOverdueMessages()`, and when it does run it only writes a
`console.warn`. The other timeout machinery (`prd09/pendingInfoChecker.ts`,
`prd12/priorAuthService.expirePendedRequests()`) does run on an interval from `src/index.ts`, so the
pattern for scheduling exists; PRD-07's checker was simply never connected.

There is also a distinction the source document is careful about and this codebase cannot currently
express: whether the next move is *ours* or *theirs*. "Waiting on the referring office" and "waiting
on us to schedule" look identical in a status column, and they call for opposite responses.

### Goal

The primary goal of this feature is to:
1. Make the **next action explicit** on every workspace — a plain sentence, not a status a reader has
   to decode
2. Give every next action a **due date**, derived from configuration rather than tribal knowledge
3. State **who owes the next move** — this organization or a named party
4. **Detect and surface overdue work**, finally connecting the overdue checker that already exists and
   generalizing it from messages to workspaces

### Scope

**In Scope:**
- A configuration-driven table of next action and due-date offset per (protocol state × work status)
- Computing and writing `next_action` and `next_action_due_at` on every transition of either status
- A "who owes the next move" indicator: us, a named party, or nobody
- Generalizing `prd07/overdueChecker.ts` from outbound messages to workspaces
- Wiring the overdue checker into `src/index.ts` on an interval, following the existing pattern
- Overdue indicators in the workspace header and the queue view
- `workspace.overdue` events for PRD-27 to notify on
- Manual override of a due date, with a reason, audited

**Out of Scope:**
- Contractual SLA definitions, business-hours or holiday calendars — offsets are in hours and the
  absence of business-hours handling is documented as a gap
- Escalation chains, reminder ladders and timers per participant — later phase per the epic
- Notifying anyone — PRD-27 consumes the events this PRD emits
- Changing the existing PRD-09 pending-info timeout or PRD-12 prior-auth expiry behaviour; both keep
  their own thresholds and this PRD does not take them over
- Per-queue or per-department SLA policy; the table is global in this PRD, with the shape to extend
  later

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to be told what to do next rather than decoding a status

**AC1:** Every non-archived workspace has a `next_action` written as a plain instruction, for example
"Request missing imaging from the referring office."  
**AC2:** The next action is recomputed whenever the protocol status or the work status changes, and
the recomputation is part of the same operation rather than a later job.  
**AC3:** A terminal state with nothing outstanding has an explicit "No action required" rather than a
blank.  
**AC4:** A next action manually set by a coordinator survives a status change until that status change
makes it meaningless, in which case the replacement is recorded with the previous value.

### As a care coordinator, I want to know when something is due so that I can work in priority order

**AC5:** Every next action has a due date, computed from the configured offset for that state
combination applied to the moment the state was entered.  
**AC6:** The due date is visible in the workspace header and the queue view, with relative wording
("due in 6 hours", "2 days overdue") alongside the absolute time.  
**AC7:** A coordinator can override a due date with a reason, and the override is audited and not
recomputed away by the next status change.  
**AC8:** A state combination with no configured offset produces a next action with no due date rather
than a fabricated one.

### As a care coordinator, I want to know whether we are waiting on someone else so that I chase the right person

**AC9:** Each workspace shows whether the next move is owed by this organization, by a named party, or
by nobody.  
**AC10:** "Owed by a party" names the organization, not a generic "external".  
**AC11:** The determination uses the protocol state and the pending state of outbound messages — a
referral in `Scheduled` with an unacknowledged SIU is owed by the counterparty.  
**AC12:** A `local-only` party is never shown as owing a move, because nothing was transmitted to
them; the move is ours.

### As a manager, I want overdue work surfaced so that nothing rots silently

**AC13:** An overdue checker runs on an interval from `src/index.ts`, following the same pattern as
the pending-info and prior-auth checkers.  
**AC14:** Crossing the due date emits `workspace.overdue` once — not on every subsequent sweep.  
**AC15:** Overdue workspaces are visibly marked in the queue view and filterable with an
`overdueOnly` filter.  
**AC16:** The existing message-level overdue behaviour is preserved: `getOverdueMessages()` keeps
working and the message history view is unaffected.

---

## Technical Specifications

### Dependencies

- [[PRD-18 - Workspace Entity & Dual Status]] — `next_action`, `next_action_due_at` and the
  `idx_referral_workspaces_due` index already exist
- [[PRD-24 - Parties & Participants]] — naming the party that owes a move
- `src/modules/prd07/overdueChecker.ts` — generalized here
- `src/config.ts` — where the action table lives
- `src/index.ts` — the interval registration site

### Engineering Constraints

- **Connect the existing checker rather than writing a second one.** `overdueChecker.ts` already has
  `getOverdueMessages(thresholdMs?)` and `checkAndLogOverdue(thresholdMs?)`. Keep both working for
  messages and add workspace-level functions in the same module, so there is one place that knows
  what "overdue" means.
- The action table belongs in `src/config.ts` alongside `config.skills.pendingInfoTimeoutHours` and
  `config.priorAuth`, keyed by `(referralState, workStatus)` with a state-only fallback. It is
  configuration, not code: changing a deadline must not require editing a service.
- Computation is **synchronous with the transition**, not a background sweep. A coordinator who
  changes a work status sees the new next action immediately. The interval job exists only to notice
  the passage of time.
- `workspace.overdue` must fire once per due date, not once per sweep. Track it with a
  `overdue_notified_at` column so the sweep is idempotent, and reset it when the due date changes.
- A manually overridden due date is marked as such and is not recomputed. Without that flag, the next
  transition silently discards a coordinator's judgement.
- Do not take over the PRD-09 and PRD-12 timeouts. They have their own semantics (auto-decline,
  expiry) and consolidating them is a separate refactor with real behavioural risk.
- Relative time wording is computed in the browser from the absolute timestamp, so a cached page does
  not show a stale "due in 2 hours".
- No business-hours or holiday awareness. State it plainly in the PRD as a known limitation rather
  than implying the offsets are contractual SLAs.

### Refinement findings and decisions

Recorded here because several were wrong in the draft, and one was a real bug found during
implementation.

**1. The transition hook is TWO call sites, not "every transition site".** The draft said
`recomputeNextAction()` is "called from every protocol and work status transition". It does not need
to be: `proposeForReferral()` is the single funnel every protocol transition already goes through —
ten call sites across PRD-02/03/04/05/06/09/11 and the protocol gateway — and `applyWorkStatus()` is
the single write path for `work_status`, covering both a manual `setWorkStatus()` and an applied
proposal. Hooking those two covers everything, so no call site has to remember.

The protocol hook recomputes **even when the work status proposal was declined**, deliberately: the
protocol state moved regardless, and only recomputing on an applied proposal would leave a
manually-held workspace showing an instruction for a state it has left.

**2. The rule table is NOT in `config.ts`.** The draft said to put it there, beside
`skills.pendingInfoTimeoutHours`. That was tried and reverted. Everything in `config.ts` calls
`requireEnv()` at import time, so every test suite has to mock the module — and the first version of
the test suite consequently **restated the entire rule table inside the mock**, meaning every rule
assertion ran against a copy of itself. That suite would have stayed green with a wrong table
shipped.

The table now lives in `src/modules/workspace/nextActionRules.ts`, which has no environment
dependency, and `resolveRule()` reads it directly. `config.ts` carries a comment saying so. The PRD's
actual requirement — "changing a deadline must not require editing a service" — is met: that file is
data, not logic. Only `overdueSweepIntervalMs` stayed in `config.ts`, because it genuinely is
env-driven.

**3. `'appointment'` is a third kind of offset.** The draft's table said "until appointment" as
prose, which is not expressible as `dueInHours: number`. `dueInHours` is now
`number | 'appointment' | null`. When the referral has no appointment date — or an unparseable one —
there is **no due date**, applying AC8's principle (a fabricated deadline is worse than an absent
one, because it gets chased).

**4. `Scheduled` is deliberately NOT ack-gated, unlike `Closed`.** AC11 says the awaited-by
determination uses outbound ack state. That is right for `Closed`, where "they owe us" *is* a
delivery claim. It is wrong for `Scheduled`: what is awaited there is the appointment happening, not
a message, so gating it would flip the indicator to "nobody" the moment the SIU came back
acknowledged while the appointment is still days away and very much awaited.

**5. A real bug, found by the test that was written to catch it.** The entry-moment fallback was
`workStatusSetAt ?? updatedAt`. But `recomputeNextAction()` **writes `updatedAt`** — so every
recompute without an explicit entry moment pushed the due date forward by however long had passed.
A backfill over an existing database therefore reset every deadline to the moment of the backfill and
un-overdued the lot, **while looking exactly like the feature working**. The fallback is now
`workStatusSetAt ?? createdAt`; `createdAt` never moves. Pinned by two tests asserting that repeated
runs produce an identical due date.

**6. `NextActionWorkspaceNotFoundError`, not `WorkspaceNotFoundError`.** `workspaceService` already
exports a class by the latter name and `server.ts` imports *that* one, so two same-named classes in
different modules would make `err instanceof WorkspaceNotFoundError` silently false for whichever the
route did not import — a 500 where a 404 belongs. Reusing the existing class would need an import
back into a module that already imports this one, so the distinct name is the cheap fix.

**7. AC15 already shipped.** The queue-view overdue marking and the `overdueOnly` filter were built
in PRD-20, which needed them for its own row rendering. Nothing further was required here.

**8. A log-noise fix.** `createWorkspace()` logged a full stack trace whenever queue routing found no
seeded queues — an expected state in every unit suite that does not exercise queues. That is now a
single warn line with no trace, so real routing faults are still visible.

### Migrations

The draft said `0017_add_next_action_fields.sql`. 0017 went to PRD-23; this is
**`0020_hot_tiger_shark.sql`**, and it is six plain `ALTER TABLE ... ADD COLUMN` statements with no
table recreation.

That last point is a deliberate decision rather than luck. The draft modelled
`awaitedByPartyId` with `.references(() => workspaceParties.id)`. A real foreign key on a new column
would have made drizzle-kit recreate `referral_workspaces` — and PRD-20's `0019` already showed what
that costs: a hand-edited migration, because drizzle-kit emits a `PRAGMA foreign_keys=OFF` that is a
no-op inside a transaction and fails against the nine tables referencing that table. Not worth a
second one for a **nullable advisory pointer** that the service revalidates on every read anyway
(it downgrades to `us` when the party is gone, which is tested). So `awaited_by_party_id` is a plain
integer, and the schema comment says why.

`tests/unit/workspace/dbMigrations.test.ts` from PRD-20 picked this migration up automatically and
proves it applies to a populated database.

### Data Models

One additive migration on the existing table:

```typescript
// src/db/schema.ts — added to referralWorkspaces
  nextActionSetBy: text('next_action_set_by'),          // actor if manually set; null if computed
  dueDateOverridden: integer('due_date_overridden', { mode: 'boolean' }).notNull().default(false),
  dueDateOverrideReason: text('due_date_override_reason'),
  overdueNotifiedAt: integer('overdue_notified_at', { mode: 'timestamp' }),
  awaitedBy: text('awaited_by'),                        // 'us' | 'party' | 'nobody'
  awaitedByPartyId: integer('awaited_by_party_id'),   // plain integer, NOT an FK — see Migrations
```

```typescript
// src/modules/workspace/nextActionRules.ts — new, and NOT in config.ts (finding 2)
export interface NextActionRule {
  action: string;                              // the instruction a coordinator reads
  dueInHours: number | 'appointment' | null;   // null => no deadline; see finding 3
  awaitedBy: 'us' | 'party' | 'nobody';
}

// Three lookup layers, most specific first. resolveRule() reads these directly.
export const NEXT_ACTION_BY_WORK_STATUS: Record<string, NextActionRule>;        // 'Exception'
export const NEXT_ACTION_BY_STATE_AND_WORK_STATUS: Record<string, NextActionRule>; // 'Scheduled|Waiting-External'
export const NEXT_ACTION_BY_STATE: Record<string, NextActionRule>;              // fallback

// src/config.ts keeps only the genuinely env-driven value:
config.workspace.overdueSweepIntervalMs   // default 900000 (15 min)
```

The work-status layer is new in refinement and wins outright: an `Exception` is the thing to deal
with, and what the protocol happens to say meanwhile is not the next action.

Starting table (refine during implementation — these are defaults, not contractual):

| Protocol state | Work status | Next action | Due in | Awaited by |
|---|---|---|---|---|
| `Received` | any | Acknowledge receipt of the referral | 4h | us |
| `Acknowledged` | `Triage` | Review clinical information and accept or decline | 24h | us |
| `Pending-Information` | any | Follow up with the referring office for the missing information | 48h | party |
| `Accepted` | `In-Progress` | Schedule the patient and notify the referrer | 48h | us |
| `Scheduled` | `Waiting-External` | Awaiting the appointment — confirm the patient attends | the appointment date | party |
| `No-Show` | any | Contact the patient and reschedule | 24h | us |
| `Encounter` | any | Complete the encounter and send the consult note | 72h | us |
| `Consult` | any | Resolve the consultation request | 48h | us |
| `Closed` | any | Awaiting acknowledgement of the consult note | 48h | party |
| `Closed-Confirmed` | `Follow-up-Required` | Complete internal follow-up and resolve | 72h | us |
| `Closed-Confirmed` | `Resolved` | No action required | none | nobody |
| `Closed-Confirmed` | other | Confirm nothing is outstanding, then resolve | 24h | us |
| `Declined` | `Resolved` | No action required | none | nobody |
| any | unmapped | Review this referral and decide the next step | none (AC8) | us |
| any | `Exception` | Review and resolve the exception | 8h | us |

```typescript
// src/modules/workspace/nextActionService.ts — new
export interface NextActionState {
  nextAction: string;
  nextActionDueAt: Date | null;
  awaitedBy: 'us' | 'party' | 'nobody';
  awaitedByPartyId: number | null;
  overdue: boolean;
  overdueByHours: number | null;
}

export function resolveRule(state: ReferralState, workStatus: WorkStatus): NextActionRule;

/**
 * Called from proposeForReferral() and applyWorkStatus() — the two funnels that
 * cover every transition (finding 1). Respects manual overrides.
 *
 * Returns null rather than throwing for a missing workspace: it runs on protocol
 * transition paths, and a protocol event must never fail because of internal
 * bookkeeping.
 */
export async function recomputeNextAction(
  workspaceId: number, enteredAt?: Date, actor?: string,
): Promise<NextActionState | null>;

/** Read-only, for the workspace payload. Reports the RULE's action when nothing is stored. */
export async function getNextActionState(workspaceId: number): Promise<NextActionState | null>;

/** Clears a manual action AND a due-date override, restoring the rule. */
export async function clearOverrides(workspaceId: number, actor: ActingUser): Promise<NextActionState | null>;

/** Overdue workspaces, narrowed to a queue scope the CALLER resolved (queueService owns that). */
export async function listOverdue(queueIds: number[] | 'all', now?: Date): Promise<OverdueItem[]>;

export async function overrideDueDate(
  workspaceId: number, dueAt: Date, reason: string, actor: ActingUser,
): Promise<NextActionState>;

export async function overrideNextAction(
  workspaceId: number, action: string, actor: ActingUser,
): Promise<NextActionState>;

export function isOverdue(workspace: Workspace, now?: Date): boolean;
```

```typescript
// src/modules/prd07/overdueChecker.ts — extended, existing exports unchanged
export interface OverdueWorkspace {
  workspaceId: number; referralId: number;
  nextAction: string; nextActionDueAt: Date; hoursOverdue: number;
  ownerUserId: number | null; queueId: number | null;
}
export async function getOverdueWorkspaces(): Promise<OverdueWorkspace[]>;
/** Emits workspace.overdue once per due date; idempotent across sweeps. */
export async function checkAndFlagOverdueWorkspaces(): Promise<number>;
```

`awaitedBy` derivation: the rule supplies the default; `party` is downgraded to `us` when the awaited
party is `local-only` (AC12), and resolved to a specific party by matching the protocol state to the
party role that owes the response.

Migration: `0020_hot_tiger_shark.sql` (see *Migrations* above).
Audit events: `workspace.next_action_changed`, `workspace.due_date_overridden`,
`workspace.overdue`, all three added to PRD-25's `WorkspaceEvents` catalogue.

### API Design

**Endpoint:** `POST /api/workspaces/:id/due-date`
```json
{ "dueAt": "2026-09-20T17:00:00Z", "reason": "referring office closed until Friday" }
```
`422` without a reason.

**Endpoint:** `POST /api/workspaces/:id/next-action`
```json
{ "nextAction": "Call Dr. Ofori's office about the echo report" }
```

**Endpoint:** `GET /api/overdue`
```json
{ "count": 3, "items": [ { "workspaceId": 12, "patientName": "R. Alvarez", "nextAction": "Schedule the patient and notify the referrer", "nextActionDueAt": "2026-09-12T14:00:00Z", "hoursOverdue": 51, "ownerDisplayName": "Dana Ruiz" } ] }
```
Scoped to the acting user's queues, consistent with PRD-20.

The workspace payload (PRD-19) gains `nextAction`, `nextActionDueAt`, `awaitedBy`,
`awaitedByPartyOrgName`, `overdue` and `overdueByHours`.

---

## Test Plan

**Unit Tests:**
- `resolveRule()` prefers the state-and-work-status rule over the state-only fallback
- `resolveRule()` for an unmapped combination returns an action with a null due date, not a fabricated
  one
- `recomputeNextAction()` computes the due date from the state entry time, not from now
- `recomputeNextAction()` leaves an overridden due date untouched
- `recomputeNextAction()` replaces a manual next action when the state change makes it meaningless,
  recording the previous value
- `awaitedBy` resolves to the correct party for each state, and downgrades to `us` for a `local-only`
  party
- `isOverdue()` boundary behaviour exactly at the due timestamp
- `checkAndFlagOverdueWorkspaces()` emits `workspace.overdue` once, and a second sweep emits nothing
- Changing the due date resets `overdue_notified_at` so a new breach notifies again
- `getOverdueMessages()` behaviour is unchanged

**Integration Tests:**
- Drive a referral through every protocol state and assert the next action, due date and awaited-by at
  each step
- Override a due date, then transition, and assert the override survives
- Let a due date pass, run the sweep, and assert one event and the queue view marking
- Assert the overdue checker is registered in `src/index.ts` and runs on the configured interval

**Edge Cases:**
- Appointment-relative due date ("until appointment") with no appointment date set
- Due date in the past at the moment of computation — immediately overdue, notified once
- Workspace archived while overdue — excluded from the sweep
- Clock skew and DST boundaries around a due date
- A workspace whose awaited party is removed — falls back to `us`

**Regression:**
- PRD-07 message overdue behaviour and `messageHistory.html` unchanged
- PRD-09 pending-info timeout and PRD-12 prior-auth expiry unchanged

---

## Deliverables

- Six additive columns on `referral_workspaces` + migration `0020_hot_tiger_shark.sql`
- `src/modules/workspace/nextActionRules.ts` — the rule table, deliberately not in `config.ts`
- `config.workspace.overdueSweepIntervalMs` in `src/config.ts`
- `src/modules/workspace/nextActionService.ts`
- Workspace-level functions added to `src/modules/prd07/overdueChecker.ts`, existing message-level
  exports untouched (AC16)
- `runOverdueSweep()` registered on an interval in `src/index.ts` — which is also the fix for PRD-07's
  checker never having been connected to anything
- `recomputeNextAction()` hooked into `proposeForReferral()` and `applyWorkStatus()`, the two funnels
  that cover every transition
- Three events added to PRD-25's `WorkspaceEvents` catalogue
- Routes listed above; the next-action panel in `workspaceDetail.html` with relative wording computed
  in the browser
- `scripts/backfill-next-actions.ts` + `npm run backfill:next-actions`
- `tests/unit/workspace/nextActionService.test.ts` — 50 tests, including the workspace-level overdue
  behaviour and an AC16 guard that PRD-07's message behaviour is unchanged

**Verified on real seeded data** (80 referrals, analytics seed, after `backfill:workspaces`):

```
computed 80, skipped 0     null next_action: 0        (AC1 holds on real data)
already overdue: 10        null due date:    42       (terminal + no-appointment cases)
awaited by:  nobody 49  |  us 16  |  party 15
repeated run: rows byte-identical, 80 events before and after  (idempotent)
```

The 42 null due dates are the honest cases, not gaps: terminal states have no deadline by rule, and
the appointment-relative rule declines to invent one when there is no appointment date.

**Not built, and why:** a dedicated `/overdue` page. `GET /api/overdue` exists and is scoped, and the
queue view already marks overdue rows and filters on them (PRD-20). A separate page would be a third
place the same rows are listed, so it is left until something asks for it.

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-07 - Ack Tracking]] — the checker being generalized and finally connected
- [[PRD-18 - Workspace Entity & Dual Status]] — owns the columns
- [[PRD-20 - Shared Queues & Queue View]] — sorts and filters on due dates
- [[PRD-24 - Parties & Participants]] — the party that owes a move
- [[PRD-27 - Notifications]] — consumes `workspace.overdue`
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-16  
**Version:** 1.1

**v1.1 — refinement and implementation.** Eight findings recorded above, of which three changed the
design: the rule table moved out of `config.ts` (a test mocking it had been asserting against a copy
of itself), `dueInHours` gained an `'appointment'` case the draft had left as prose, and the
transition hook collapsed from "every transition site" to the two funnels that already cover them.
One real bug was found and fixed: the entry-moment fallback was `updatedAt`, which the recompute
itself writes, so a backfill silently reset every deadline in the database. `awaitedByPartyId` was
downgraded from a foreign key to a plain integer to avoid a second hand-edited table recreation, and
`Scheduled` was deliberately exempted from the ack gate that `Closed` needs. AC15 was already
satisfied by PRD-20.
