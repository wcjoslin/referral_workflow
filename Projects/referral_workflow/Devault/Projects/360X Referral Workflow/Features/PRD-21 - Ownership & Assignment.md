---
up: "[[📋 PRD Index]]"
prev: "[[PRD-20 - Shared Queues & Queue View]]"
---

# PRD-21: Ownership & Assignment

**Status:** Drafting  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

Nothing in the system records who is responsible for a referral. `referrals.clinician_id` captures
who made the accept/decline decision after the fact, and `referrals.scheduled_provider` names the
clinician who will see the patient — neither says who is *working the referral now*. In practice that
means a referral in `Accepted` for six days has no accountable person, and the only way to find out
whether anyone is on it is to ask.

The source document puts a single owner at the centre of its MVP: "one owning queue and one primary
assignee; reassignment recorded." Its differentiation statement leads with ownership — moving from
"what status is this referral in?" to "who owns the next action." This is the PRD that makes that
claim true.

The scope is deliberately narrow. One primary owner, not a team. No multiple assignees, no subtasks,
no delegation chains — those are on the epic's later-phase list. What this PRD must get right is that
every ownership change is deliberate, attributable and reversible, and that the history of who held
a referral is never lost.

### Goal

The primary goal of this feature is to:
1. Give every workspace **one accountable owner**, or an explicit unassigned state that is visible
   rather than implied
2. Make assignment, reassignment, self-claim and release **first-class actions** with a complete
   from→to audit trail
3. Let a coordinator find **their own work** in one click, from anywhere in the application

### Scope

**In Scope:**
- Assigning, reassigning, claiming and releasing the owner of a workspace
- The owner panel in the workspace header slot reserved by PRD-19
- A from→to audit event on every ownership change, including release
- A "My work" filter usable from the dashboard and the queue view
- An unassigned indicator wherever workspaces are listed
- Optional initial assignment when a workspace is routed to a queue (PRD-20 supplies the queue; this
  PRD decides whether an owner is set at that moment — default: no, queues hold unassigned work)

**Out of Scope:**
- Multiple owners, co-owners, watchers or teams — later phase per the epic
- Workload balancing, round-robin or capacity-aware auto-assignment
- Escalation chains and on-call rotation — later phase
- Queue membership and access control — PRD-20
- Notifying the new owner — PRD-27 consumes the event this PRD emits
- Changing the meaning of `referrals.clinician_id`

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to claim a referral so that my colleagues can see I am working it

**AC1:** An unassigned workspace shows a "Claim" action that assigns the acting user as owner in one
click.  
**AC2:** Claiming emits `workspace.assigned` with `from: null`, `to: user:<id>` and the acting actor.  
**AC3:** A workspace that already has an owner shows "Reassign" rather than "Claim", and reassignment
requires choosing a user explicitly — there is no one-click steal.

### As a care coordinator, I want to hand a referral to the right person so that it does not stall with me

**AC4:** The owner control offers all active users, showing display name and job role, sourced from
`GET /api/users`.  
**AC5:** Reassignment emits `workspace.reassigned` with both the previous and the new owner.  
**AC6:** Assigning the current owner again is a no-op that writes nothing and emits nothing, rather
than an event storm of identical reassignments.  
**AC7:** Assigning an inactive user is rejected with a clear message.

### As a care coordinator, I want to release a referral I cannot finish so that it returns to the queue rather than looking handled

**AC8:** A "Release" action clears the owner, leaves the owning queue intact, and emits
`workspace.released` with the previous owner.  
**AC9:** A released workspace appears in its queue's unassigned view immediately.  
**AC10:** Release requires a reason when the work status is anything other than `Triage`, and the
reason is recorded in the event metadata.

### As a manager, I want to see what is unowned so that nothing sits unclaimed

**AC11:** Every list that shows workspaces shows an explicit "Unassigned" treatment, not an empty
cell.  
**AC12:** The queue view and the dashboard both support filtering to unassigned workspaces.

### As a care coordinator, I want a "My work" view so that I can see everything assigned to me

**AC13:** A "My work" filter returns all non-archived workspaces owned by the acting user, ordered by
due date ascending with nulls last, then by created date.  
**AC14:** The filter is reachable from the navigation and from the queue view, and reflects the acting
user at request time rather than a value captured in a URL.

### As an auditor, I want the full ownership history so that I can reconstruct who held a referral and when

**AC15:** The workspace activity feed (PRD-25) shows every assignment, reassignment and release in
order with actor, timestamp and both parties.  
**AC16:** No ownership change is possible without an event; a direct database write is the only way to
bypass it and no application code path does so.

---

## Technical Specifications

### Dependencies

- [[PRD-17 - Identity & Acting User]] — `users`, `getActingUser()`, `GET /api/users`
- [[PRD-18 - Workspace Entity & Dual Status]] — `referral_workspaces.owner_user_id` already exists
- [[PRD-19 - Workspace Shell]] — the `#wsOwner` slot
- `src/modules/analytics/eventService.ts` — `emitEvent()`

### Engineering Constraints

- No schema change. `owner_user_id` and the `idx_referral_workspaces_owner` index were created by
  PRD-18 precisely so this PRD is a service plus a panel.
- `assignOwner()` must be the only writer of `owner_user_id`. Enforce it by keeping the column out of
  every other update statement in `workspaceService.ts`.
- `referrals.clinician_id` is not touched. It remains the disposition record. The workspace owner and
  the dispositioning clinician are frequently different people and the PRD must not conflate them.
- Ownership changes emit but do not notify. PRD-27 subscribes to the events; this PRD must not call a
  mail transport.
- "My work" resolves the acting user server-side on each request. Do not encode a user id in the URL,
  or a bookmarked link will show someone else's work.
- Assignment is permitted in any work status including `Resolved` and `Exception`, and on a
  `Closed-Confirmed` referral — someone still owns follow-up. Only an archived workspace rejects
  assignment.

### Data Models

No new tables. Event shapes written through the existing `emitEvent()`:

```typescript
// workspace.assigned
{ eventType: 'workspace.assigned', entityType: 'referral', entityId: referralId,
  actor: 'user:7',
  metadata: { workspaceId: 12, fromOwnerUserId: null, toOwnerUserId: 7, self: true } }

// workspace.reassigned
{ eventType: 'workspace.reassigned', entityType: 'referral', entityId: referralId,
  actor: 'user:7',
  metadata: { workspaceId: 12, fromOwnerUserId: 7, toOwnerUserId: 3, reason: 'on leave' } }

// workspace.released
{ eventType: 'workspace.released', entityType: 'referral', entityId: referralId,
  actor: 'user:3',
  metadata: { workspaceId: 12, fromOwnerUserId: 3, reason: 'needs cardiology coordinator' } }
```

`entityType` stays `'referral'` with the referral id so the existing
`idx_workflow_events_entity` index and the analytics queries keep working; the workspace id travels
in `metadata`, as established by PRD-18.

```typescript
// src/modules/workspace/assignmentService.ts — new
export class OwnerNotFoundError extends Error {}
export class WorkspaceArchivedError extends Error {}
export class ReleaseReasonRequiredError extends Error {}

export interface OwnershipResult {
  workspaceId: number;
  ownerUserId: number | null;
  ownerDisplayName: string | null;
  changed: boolean;          // false for a no-op reassignment to the current owner
}

export async function assignOwner(
  workspaceId: number, toUserId: number, actor: ActingUser, reason?: string,
): Promise<OwnershipResult>;

export async function claimOwnership(
  workspaceId: number, actor: ActingUser,
): Promise<OwnershipResult>;

export async function releaseOwnership(
  workspaceId: number, actor: ActingUser, reason?: string,
): Promise<OwnershipResult>;

export interface MyWorkItem {
  workspaceId: number; referralId: number; patientName: string;
  workStatus: WorkStatus; referralState: ReferralState;
  nextAction: string | null; nextActionDueAt: Date | null; overdue: boolean;
}
export async function getMyWork(userId: number): Promise<MyWorkItem[]>;
```

`overdue` is computed here as `nextActionDueAt < now`; PRD-26 replaces the computation with its own
helper without changing this signature.

### API Design

**Endpoint:** `POST /api/workspaces/:id/owner`

**Request:** assign, claim (`"self": true`) or release (`"ownerUserId": null`)
```json
{ "ownerUserId": 3, "reason": "cardiology coordinator" }
```

**Response:**
```json
{ "success": true, "ownerUserId": 3, "ownerDisplayName": "Dana Ruiz", "changed": true }
```

- `400` unknown or inactive user
- `409` workspace archived
- `422` release without a reason when one is required

**Endpoint:** `GET /api/my-work`

**Response:**
```json
{ "actingUserId": 7, "items": [ { "workspaceId": 12, "patientName": "R. Alvarez", "workStatus": "In-Progress", "nextAction": "Send scheduling notice", "nextActionDueAt": "2026-09-16T14:00:00Z", "overdue": false } ] }
```

**Page:** `GET /my-work` — a list view reusing the queue-view table (PRD-20) with the owner filter
pre-applied; until PRD-20 ships, it reuses the dashboard table markup.

---

## Test Plan

**Unit Tests:**
- `claimOwnership()` on an unassigned workspace sets the acting user and emits `workspace.assigned`
- `assignOwner()` to a different user emits `workspace.reassigned` with correct from/to
- `assignOwner()` to the current owner returns `changed: false`, writes nothing, emits nothing
- `assignOwner()` with an unknown or inactive user throws `OwnerNotFoundError`
- `releaseOwnership()` clears the owner, preserves `queue_id`, emits `workspace.released`
- `releaseOwnership()` without a reason throws in `In-Progress`, succeeds in `Triage`
- Any ownership call on an archived workspace throws `WorkspaceArchivedError`
- `getMyWork()` orders by due date ascending with nulls last and excludes archived workspaces

**Integration Tests:**
- Claim → reassign → release on one workspace, then read the activity feed and assert three events in
  order with correct actors
- Assign an owner, switch the acting user in the nav, and confirm "My work" reflects the new acting
  user rather than the previous one
- Assign an owner on a `Closed-Confirmed` referral in `Follow-up-Required` and confirm it succeeds

**Edge Cases:**
- Two rapid claims on the same unassigned workspace — one wins, both are audited, the loser gets a
  clear "already claimed by" response
- Owner deactivated after assignment — the workspace still renders, showing the owner as inactive
- `referrals.clinician_id` set to a string with no matching user — the owner panel is unaffected

**Regression:**
- Disposition flow and its tests are unchanged; `clinician_id` semantics untouched

---

## Deliverables

- `src/modules/workspace/assignmentService.ts`
- `POST /api/workspaces/:id/owner`, `GET /api/my-work`, `GET /my-work`
- Owner panel rendered into the `#wsOwner` slot in `src/views/workspaceDetail.html`
- Unassigned treatment and owner filter in `src/views/dashboard.html`
- `tests/unit/workspace/assignmentService.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-17 - Identity & Acting User]], [[PRD-18 - Workspace Entity & Dual Status]],
  [[PRD-19 - Workspace Shell]] — prerequisites
- [[PRD-20 - Shared Queues & Queue View]] — the queue an owner claims from
- [[PRD-25 - Activity History & Audit]] — renders the ownership history
- [[PRD-26 - Next Action & Due Dates]] — replaces the local `overdue` computation
- [[PRD-27 - Notifications]] — consumes the assignment events
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-14  
**Version:** 1.0
