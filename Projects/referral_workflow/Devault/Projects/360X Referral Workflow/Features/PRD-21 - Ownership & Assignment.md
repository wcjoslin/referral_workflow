---
up: "[[📋 PRD Index]]"
prev: "[[PRD-20 - Shared Queues & Queue View]]"
---

# PRD-21: Ownership & Assignment

**Status:** Ready for Dev  
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
- A "My work" filter on the existing `/workspaces` index — not a new page; see the decisions below
- An owner and unassigned filter on `/workspaces`, and an unassigned indicator wherever workspaces
  are listed
- `active` added to `ActingUser` (a PRD-17 amendment), without which two of this PRD's own criteria
  have nothing to read
- Optional initial assignment when a workspace is routed to a queue (PRD-20 supplies the queue; this
  PRD decides whether an owner is set at that moment — default: no, queues hold unassigned work)

**Out of Scope:**
- Multiple owners, co-owners, watchers or teams — later phase per the epic
- Workload balancing, round-robin or capacity-aware auto-assignment
- Escalation chains and on-call rotation — later phase
- Queue membership and access control — PRD-20
- A standalone `/my-work` page — decided against; see below
- Notifying the new owner — PRD-27 consumes the event this PRD emits
- Changing the meaning of `referrals.clinician_id`

---

## Decisions taken before implementation

A codebase pass against the shipped PRD-17, PRD-18 and PRD-19 turned up six things this draft
assumed. It was written before any of them existed, so several criteria referenced infrastructure
that is still on the roadmap.

**1. `ActingUser` gains `active: boolean`. This is a PRD-17 amendment and a prerequisite.**
AC7 rejects assigning an inactive user, and the edge cases want a deactivated owner rendered as
inactive. Neither is implementable today: `ActingUser` has no `active` field, and `getUser()`
deliberately does not filter by it. The column is already selected by the query — only
`toActingUser()` changes.

`getUser()` keeps returning inactive users on purpose. Filtering there would make
`ownerDisplayName` null for a workspace that genuinely has an owner, and the header would then show
"Unassigned" for work somebody owns. Wrong, and worse than showing a name greyed out.

**2. "My work" is a filter on `/workspaces`, not a page.**
The draft specifies `GET /my-work` reusing "the queue-view table (PRD-20)... until PRD-20 ships, the
dashboard table markup". Since the draft was written, PRD-19 shipped a flat index at `/workspaces`
that is already workspace-shaped — both statuses, owner, department. Building a third list surface
alongside the dashboard and that index, when PRD-20 may replace the index outright, is work with a
short life.

So: an owner filter and a "Mine" toggle on `/workspaces`, with the acting user resolved server-side.
`GET /api/my-work` still ships — PRD-27 and any later client want it. AC14's navigation requirement
is met by the existing **Workspaces** nav entry; no ninth entry.

**3. This service takes `actor: ActingUser`, and says why.**
Every function in `workspaceService.ts` takes `actor: string` — the pre-formatted `user:<id>`. This
service takes the whole `ActingUser`, because `claimOwnership()` genuinely needs the actor's **id**
as the new owner, not just a label for the audit row. `formatActor()` converts at the `emitEvent()`
boundary. Deliberate divergence, recorded here so it does not read as an accident.

**4. Queues do not exist yet, so two criteria had to be rewritten.**
`queue_id` is a column with no table behind it until PRD-20, and `queueName` is hardcoded `null` in
the workspace payload. AC9's "its queue's unassigned view" and AC12's "the queue view" had no
referent. Both now name what exists: the `/workspaces` index and the dashboard.

**5. The due-date ordering is inert in Phase 2, and the PRD should say so.**
`next_action_due_at` is populated by PRD-26. Until then every value is null, so AC13's "due date
ascending with nulls last" degenerates to "all nulls" and the created-date tiebreak does all the real
ordering. `MyWorkItem.overdue` is likewise always `false`. The clauses stay because PRD-26 makes them
live; stating it here stops a reader from writing a test that cannot fail.

**6. The concurrent-claim behaviour needs a mechanism, not an assertion.**
The draft asserts that of two rapid claims "one wins... the loser gets a clear already-claimed-by
response" without saying how. A read-then-write cannot deliver that: `getWorkspace()` and the update
are separated by an await, and the second claim can read a null owner before the first one's write
lands.

The claim path is therefore a single conditional statement —
`UPDATE referral_workspaces SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL` — and the
rows-changed count decides the outcome. Zero rows means somebody else won: re-read, report the
current owner, write nothing and emit nothing. `assignOwner()` is an explicit act on a known owner
and does not need the guard; `claimOwnership()` does.

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
**AC7:** Assigning an inactive user is rejected with a clear message, read from the `active` field
added to `ActingUser` by decision 1.  
**AC7a:** A user deactivated *after* being assigned still renders as the owner, marked inactive — the
workspace never silently reads as unassigned because its owner left.

### As a care coordinator, I want to release a referral I cannot finish so that it returns to the queue rather than looking handled

**AC8:** A "Release" action clears the owner, leaves the owning queue intact, and emits
`workspace.released` with the previous owner.  
**AC9:** A released workspace reads as Unassigned on `/workspaces` and the dashboard immediately, and
its `queue_id` is untouched. (The queue's own unassigned view arrives with PRD-20; there is no queue
to show it in yet.)  
**AC10:** Release requires a reason when the work status is anything other than `Triage`, and the
reason is recorded in the event metadata.

### As a manager, I want to see what is unowned so that nothing sits unclaimed

**AC11:** Every list that shows workspaces shows an explicit "Unassigned" treatment, not an empty
cell.  
**AC12:** `/workspaces` and the dashboard both support filtering to unassigned workspaces. PRD-20
carries the same filter into the queue view.

### As a care coordinator, I want a "My work" view so that I can see everything assigned to me

**AC13:** A "My work" filter returns all non-archived workspaces owned by the acting user, ordered by
due date ascending with nulls last, then by created date. Note that every due date is null until
PRD-26 populates them, so the created-date tiebreak is what actually orders the list in Phase 2 — do
not write a test that claims to exercise the due-date clause.  
**AC14:** The filter is a "Mine" toggle on `/workspaces`, reachable from the existing **Workspaces**
nav entry, and reflects the acting user resolved server-side at request time rather than a value
captured in a URL — so a bookmarked or shared link never shows someone else's work.

### As an auditor, I want the full ownership history so that I can reconstruct who held a referral and when

**AC15:** The workspace activity feed (PRD-25) shows every assignment, reassignment and release in
order with actor, timestamp and both parties.  
**AC16:** No ownership change is possible without an event; a direct database write is the only way to
bypass it and no application code path does so.

### As a care coordinator, I want a losing claim to fail cleanly so that two of us never think we both own a referral

**AC17:** When two claims race, the conditional update in decision 6 means exactly one wins. The loser
gets a 409 naming the current owner, and writes and emits nothing — there is no second
`workspace.assigned` event for a claim that did not take effect.

---

## Technical Specifications

### Dependencies

- [[PRD-17 - Identity & Acting User]] — `users`, `getActingUser()`, `GET /api/users`, and the
  `active` field this PRD adds to `ActingUser` (PRD-17 v1.2). That amendment ships with this PRD and
  is a prerequisite for AC7/AC7a, not a nicety.
- [[PRD-18 - Workspace Entity & Dual Status]] — `referral_workspaces.owner_user_id` already exists
- [[PRD-19 - Workspace Shell]] — the `#wsOwner` slot, its `slots.owner` flag, and the `/workspaces`
  index this PRD adds the owner filter to
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
- Flip `slots.owner` to `true` in `buildWorkspacePayload()` when the panel lands, so the shell stops
  rendering its "coming in PRD-21" placeholder. That single flag is the whole handover — PRD-19 built
  the slot contract for exactly this.
- `claimOwnership()` writes through a conditional `UPDATE ... WHERE owner_user_id IS NULL` and
  branches on rows-changed. Do not read-then-write: the await between them is where the race lives.
- The acting user may be absent on an unseeded install — `tryGetActingUser()` returns null. Every
  ownership route must reject that with a clear message rather than assigning `user:undefined`,
  the same split PRD-17 made between `getActingUser()` and `tryGetActingUser()`.
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
export class OwnerNotFoundError extends Error {}      // unknown id, or users.active = 0
export class WorkspaceArchivedError extends Error {}
export class ReleaseReasonRequiredError extends Error {}
export class NoActingUserError extends Error {}       // unseeded install
/** A claim that lost the race in decision 6. Carries the winner for the message. */
export class OwnershipConflictError extends Error {
  constructor(readonly currentOwnerUserId: number, readonly currentOwnerDisplayName: string) {
    super(`Already claimed by ${currentOwnerDisplayName}`);
  }
}

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
  nextAction: string | null;
  /** Always null until PRD-26 populates it. */
  nextActionDueAt: Date | null;
  /** Therefore always false until PRD-26. Kept so the shape does not change then. */
  overdue: boolean;
}
export async function getMyWork(userId: number): Promise<MyWorkItem[]>;
```

`overdue` is computed here as `nextActionDueAt < now`; PRD-26 replaces the computation with its own
helper without changing this signature. In Phase 2 it is always `false`, because the column it reads
is always null — see decision 5.

### API Design

**Endpoint:** `POST /api/workspaces/:id/owner`

The draft left this ambiguous: it described assign, claim and release as three shapes of one body,
with release as `"ownerUserId": null`. In JSON an absent key and an explicit null are different
things, and `{}` would have been indistinguishable from a release — a request that forgot its payload
would have silently unassigned the workspace. So the body must carry **exactly one** of:

| Body | Action |
|---|---|
| `{ "ownerUserId": 3 }` | assign or reassign to user 3 |
| `{ "self": true }` | claim for the acting user |
| `{ "release": true }` | clear the owner |

An empty body, or more than one of these, is a `400`. Release does not overload a null.

```json
{ "ownerUserId": 3, "reason": "cardiology coordinator" }
```

**Response:**
```json
{ "success": true, "ownerUserId": 3, "ownerDisplayName": "Dana Ruiz", "changed": true }
```

- `400` malformed body, or an unknown or inactive user
- `401` no acting user on an unseeded install — nothing to attribute the change to
- `409` workspace archived, **or** a claim that lost the race (body names the current owner)
- `422` release without a reason when one is required

**Endpoint:** `GET /api/my-work`

**Response:**
```json
{ "actingUserId": 7, "items": [ { "workspaceId": 12, "patientName": "R. Alvarez", "workStatus": "In-Progress", "nextAction": "Send scheduling notice", "nextActionDueAt": "2026-09-16T14:00:00Z", "overdue": false } ] }
```

**Surface:** no new page. `GET /workspaces` gains two optional query parameters, and the index grows a
"Mine" toggle and an "Unassigned" toggle beside its existing text filter:

| Parameter | Meaning |
|---|---|
| `?owner=me` | workspaces owned by the acting user, resolved server-side |
| `?owner=unassigned` | workspaces with no owner |

`owner=me` deliberately takes the literal string `me` rather than a user id, so the URL cannot be
shared into showing someone else's work — the same reasoning as PRD-18's `data/users/me` convention
and AC14.

Both parameters filter server-side in `listWorkspaceRows()`, not in the browser, because PRD-20 will
inherit that function and its queue view cannot filter client-side over a paged list.

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
- `getMyWork()` excludes archived workspaces and orders by created date — the due-date clause cannot
  be exercised until PRD-26, so assert the created-date order and do not pretend otherwise
- `assignOwner()` and `claimOwnership()` throw `NoActingUserError` when no user is seeded
- a losing `claimOwnership()` throws `OwnershipConflictError`, writes nothing and emits nothing;
  assert the event count is unchanged, not just the returned value
- an owner deactivated after assignment still resolves a display name (AC7a), because `getUser()`
  does not filter on `active` — a regression test for the choice in decision 1

**Integration Tests:**
- Claim → reassign → release on one workspace, then read the activity feed and assert three events in
  order with correct actors
- Assign an owner, switch the acting user in the nav, and confirm "My work" reflects the new acting
  user rather than the previous one
- Assign an owner on a `Closed-Confirmed` referral in `Follow-up-Required` and confirm it succeeds

**Edge Cases:**
- Two interleaved claims on the same unassigned workspace — exactly one wins and emits; the loser
  gets `OwnershipConflictError` naming the winner. Drive it by awaiting both promises together, so
  the second claim reads before the first writes; the conditional update is what makes the outcome
  deterministic. Note the draft said "both are audited" — that was wrong: a claim that changed
  nothing must not leave an event saying it did
- Owner deactivated after assignment — the workspace still renders, showing the owner as inactive
  rather than falling back to "Unassigned"
- `referrals.clinician_id` set to a string with no matching user — the owner panel is unaffected

**Regression:**
- Disposition flow and its tests are unchanged; `clinician_id` semantics untouched

---

## Deliverables

- `src/modules/workspace/assignmentService.ts`
- `POST /api/workspaces/:id/owner`, `GET /api/my-work`
- `active` added to `ActingUser` and `toActingUser()` in
  `src/modules/workspace/identityService.ts` (PRD-17 v1.2)
- Owner panel rendered into the `#wsOwner` slot in `src/views/workspaceDetail.html`, and
  `slots.owner` flipped to `true` in `workspaceView.ts`
- `owner` query parameter in `listWorkspaceRows()`, with "Mine" and "Unassigned" toggles in
  `src/views/workspaceIndex.html`
- Unassigned treatment and owner filter in `src/views/dashboard.html`
- `tests/unit/workspace/assignmentService.test.ts`
- Smoke-check coverage: the owner panel renders and the two index filters return what they claim —
  this page is client-rendered, and `scripts/smoke.ts` exists because payload tests missed exactly
  that on PRD-19

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
**Last Updated:** 2026-09-15  
**Version:** 1.0 — first draft.

**Version:** 1.1 — Ready for Dev, after a codebase pass against the shipped PRD-17/18/19. The draft
predated all three, so several criteria pointed at infrastructure that does not exist yet:

- **`ActingUser` gains `active`** (PRD-17 v1.2, a prerequisite). AC7 and the deactivated-owner edge
  case had nothing to read — the field did not exist and `getUser()` does not filter on it.
- **"My work" became a filter on `/workspaces`** rather than a new page. PRD-19 shipped an index
  after this draft was written; a third list surface that PRD-20 may replace was not worth building.
- **The `POST .../owner` body was ambiguous.** Release as `"ownerUserId": null` made an empty body
  indistinguishable from a release, so a request that forgot its payload would have unassigned the
  workspace. Now exactly one of `ownerUserId`, `self` or `release`.
- **The concurrent-claim behaviour got a mechanism** — a conditional `UPDATE ... WHERE
  owner_user_id IS NULL` — replacing an assertion a read-then-write could not deliver. The draft's
  "both are audited" was also wrong: a claim that changed nothing must not emit an event saying it
  did.
- **AC9 and AC12 were rewritten** against `/workspaces` and the dashboard, since queues are PRD-20.
- **The due-date ordering is recorded as inert** until PRD-26 populates the column, so nobody writes
  a test that cannot fail.
- Actor convention divergence stated deliberately: this service takes `ActingUser` because
  `claimOwnership()` needs the actor's id, not just an audit label.
