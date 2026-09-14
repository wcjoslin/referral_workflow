---
up: "[[📋 PRD Index]]"
prev: "[[PRD-24 - Parties & Participants]]"
---

# PRD-25: Unified Activity History & Audit

**Status:** Drafting  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`, `analytics/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

The audit substrate is already here and it is good. PRD-14 built `workflow_events` — an append-only
log with event type, entity, from/to state, actor and a JSON metadata blob, written through a single
fire-and-forget `emitEvent()` from roughly 28 call sites, indexed on `(entity_type, entity_id)` and on
`(event_type, created_at)`.

It has never been read for a single referral. The only consumer is
`src/modules/analytics/analyticsQueries.ts`, which aggregates across the whole log for dashboards.
The entity index exists and is unused. The review page's "journey" is not the event log at all — it is
reconstructed from `outbound_messages` message types and `referral_messages`, which is why it can only
show protocol milestones and cannot show that a coordinator reassigned the referral or overrode a
skill decision.

There are also real gaps in what gets recorded. `POST /api/referrals/:id/routing` changes the
department with no event at all. `POST /referrals/:id/override` reverses a decline, clears the
clinician and the priority flag, writes `state` from a string literal *bypassing the state machine*,
and emits nothing. The escalation path in `prd09/pendingInfoChecker.ts` does the same. And
`referral.auto_declined` is emitted with `entityId: 0`, because an auto-declined referral gets no row
— so the one decision a coordinator most wants to review is the one least visible.

This PRD makes the log readable per referral, fills those gaps, and answers the open question the
source document raises about audit semantics: which receipts prove technical delivery versus human
access.

### Goal

The primary goal of this feature is to:
1. Provide the **first per-referral reader** of the event log, so a workspace can show everything that
   has happened to it
2. **Merge system events, user actions, guest actions, comments, documents and delivery receipts** into
   one chronological feed, filterable by kind
3. **Close the audit gaps** — routing changes, disposition overrides and state-machine bypasses become
   recorded, guarded events
4. Present **delivery evidence and human access as distinct facts**, never merged into one ambiguous
   indicator

### Scope

**In Scope:**
- `GET /api/workspaces/:id/activity` reading `workflow_events` by entity
- The merged feed: events, comments, documents, assertions, delivery receipts, access records
- Filter tabs: All / System / User / Guest / Status
- The `workspace.*` event vocabulary, added alongside the existing 21 event types
- Backfilling event emission at the uninstrumented sites, and routing the two state-machine bypasses
  through `transition()`
- Recording auto-declined referrals so they are reviewable rather than orphaned at `entityId: 0`
- The activity panel in the `#wsActivity` slot
- A guest-facing activity view containing protocol and shared events only

**Out of Scope:**
- Changing the `workflow_events` schema — the existing table and indexes are sufficient and are used
  by analytics
- Retention, archival or export of audit data — inherited from the deployment; noted as a gap
- Analytics aggregation — PRD-14 Phase 2 and PRD-15 own that; this PRD reads per entity
- Tamper-evident logging (hash chaining, append-only storage guarantees) — a production concern worth
  its own PRD, called out here so its absence is not mistaken for completeness
- Real-time streaming of the feed

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to see everything that has happened to a referral in one place so that I can pick up work without asking anyone

**AC1:** `GET /api/workspaces/:id/activity` returns every `workflow_events` row for the referral in
chronological order, using the existing `idx_workflow_events_entity` index.  
**AC2:** The feed also includes comments, document additions, document views, assertions and delivery
receipts, merged into the same chronology.  
**AC3:** Each entry shows what happened, who did it, when, and links to the artifact it concerns.  
**AC4:** Filter tabs narrow the feed to System, User, Guest or Status changes, and the counts on each
tab reflect the unfiltered totals.  
**AC5:** A referral with a full lifecycle renders its feed in one request without pagination problems
at up to several hundred entries.

### As a care coordinator, I want to know whether something was delivered as opposed to actually read, so that I do not assume the other side has seen it

**AC6:** Delivery evidence (an ack received, an MDN, an assertion transmitted) and human access
evidence (a document opened, a shared comment read) render as visibly different entry kinds with
different wording.  
**AC7:** A document that was transmitted but not acknowledged, and a document that was acknowledged but
never opened, are distinguishable in the feed.  
**AC8:** An artifact recorded but never transmitted shows as such, and is never presented as delivered.

### As a compliance reviewer, I want every action recorded, so that the gaps in today's log are closed

**AC9:** `POST /api/referrals/:id/routing` emits a `referral.routing_changed` event with the previous
and new department and equipment.  
**AC10:** `POST /referrals/:id/override` emits `referral.disposition_overridden` and performs its state
change through `referralStateMachine.transition()` rather than a string literal.  
**AC11:** The escalation path in `prd09/pendingInfoChecker.ts` performs its state change through
`transition()` and emits an event.  
**AC12:** An auto-declined referral is recorded such that the event is reachable from a workspace or an
exception record, rather than being emitted with `entityId: 0`.  
**AC13:** A test enumerates every mutating workspace route and asserts each writes at least one event.

### As an invited specialist, I want to see the referral's progress, so that I know where things stand

**AC14:** The guest activity view shows protocol events, shared comments and shared documents only.  
**AC15:** No internal event — assignment, work status change, internal comment, routing, override,
skill evaluation — appears in the guest feed, asserted against the constructed payload.

### As an engineer, I want the event vocabulary to stay consistent so that analytics keeps working

**AC16:** New event types follow the existing `<domain>.<verb>` naming and are documented in one place.  
**AC17:** New actor forms (`user:<id>`, `guest:<id>`, `party:<address>`) extend the existing prefix
convention; `system`, `clinician:`, `skill:` and `payer:` are unchanged.  
**AC18:** `tests/unit/analytics/analyticsQueries.test.ts` passes unchanged, and the dashboards return
identical figures for the seeded dataset.

---

## Technical Specifications

### Dependencies

- [[PRD-14 - Analytics Agent (Phase 1)|PRD-14 Phase 1]] — `workflow_events`, `emitEvent()`
- [[PRD-18 - Workspace Entity & Dual Status]], [[PRD-19 - Workspace Shell]] — the workspace and slot
- [[PRD-22 - Referral Conversation]], [[PRD-23 - Document Collection]],
  [[PRD-29 - 360X Protocol Gateway]] — feed sources
- [[PRD-30 - Guest Participation]] — the guest feed audience

### Engineering Constraints

- **No schema change to `workflow_events`.** The table and both indexes are adequate; analytics
  depends on their shape. Workspace events use `entity_type: 'referral'` with the referral id and
  carry `workspaceId` in `metadata`, as established by PRD-18.
- **The actor prefix format is load-bearing.** `analyticsQueries.ts` parses it with
  `REPLACE(actor, 'skill:', '')` and `LIKE 'payer:%'`. Adding prefixes is safe; changing or reordering
  existing ones is not.
- Emission stays fire-and-forget: `void emitEvent({...}).catch((err) => console.error(...))`. A feed
  read must never fail because a write failed, and a write must never block a user action.
- The merge happens in the read path, not by duplicating comments and documents into the event log.
  Writing a comment emits an event *referring* to it; the feed joins to get the body. Duplicating
  content into `metadata` would make the log the second source of truth for comment text.
- **Correcting the two state-machine bypasses is in scope and is the riskiest part of this PRD.**
  `POST /referrals/:id/override` currently sets `state: 'Acknowledged'` from `Declined` or
  `Pending-Information` directly — and `Declined` is terminal in `VALID_TRANSITIONS`. Routing it
  through `transition()` requires either an explicit reopen transition added to the machine or a
  documented, audited exception path. Decide and state which; do not quietly widen the transition
  table.
- The guest feed is a separately constructed payload, never the internal feed with entries removed —
  the same rule as PRD-30's workspace payload.
- One event catalog module is the single source of truth for event type names, so the vocabulary
  cannot drift across 30+ call sites.

### Data Models

No new tables. The read model:

```typescript
// src/modules/workspace/activityService.ts — new
export type ActivityKind = 'system' | 'user' | 'guest' | 'status' | 'delivery' | 'access';

export interface ActivityEntry {
  id: string;                       // `${sourceTable}:${rowId}` — stable across merges
  kind: ActivityKind;
  eventType: string;                // 'workspace.assigned', 'referral.scheduled', ...
  occurredAt: Date;
  actor: string;                    // raw actor string
  actorLabel: string;               // resolved: 'Dana Ruiz', 'Lakeside Cardiology (guest)', 'System'
  summary: string;                  // one human-readable line
  fromState: string | null;
  toState: string | null;
  artifact: { kind: 'document' | 'comment' | 'assertion' | 'message'; id: number; label: string } | null;
  evidence: 'delivery' | 'access' | null;   // keeps AC6 explicit in the data, not just the UI
  metadata: Record<string, unknown>;
}

export interface ActivityFeed {
  entries: ActivityEntry[];
  counts: Record<ActivityKind, number>;
}

export async function getActivityFeed(workspaceId: number): Promise<ActivityFeed>;
/** Constructed from scratch: protocol events, shared comments, shared documents. */
export async function getGuestActivityFeed(guest: GuestContext): Promise<ActivityFeed>;
```

```typescript
// src/modules/workspace/eventCatalog.ts — new: the single source of truth for event names
export const WorkspaceEvents = {
  CREATED: 'workspace.created',
  ASSIGNED: 'workspace.assigned',
  REASSIGNED: 'workspace.reassigned',
  RELEASED: 'workspace.released',
  WORK_STATUS_CHANGED: 'workspace.work_status_changed',
  WORK_STATUS_PROPOSAL_DECLINED: 'workspace.work_status_proposal_declined',
  QUEUE_CHANGED: 'workspace.queue_changed',
  PARTY_SEEDED: 'workspace.party_seeded',
  PARTY_UPDATED: 'workspace.party_updated',
  PROTOCOL_MODE_CHANGED: 'workspace.protocol_mode_changed',
  PARTICIPANT_ADDED: 'workspace.participant_added',
  PARTICIPANT_ROLE_CHANGED: 'workspace.participant_role_changed',
  PARTICIPANT_REMOVED: 'workspace.participant_removed',
  COMMENT_ADDED: 'workspace.comment_added',
  COMMENT_EDITED: 'workspace.comment_edited',
  COMMENT_DELETED: 'workspace.comment_deleted',
  COMMENT_SHARED: 'workspace.comment_shared',
  COMMENT_MENTION: 'workspace.comment_mention',
  DOCUMENT_ADDED: 'workspace.document_added',
  DOCUMENT_UPLOADED: 'workspace.document_uploaded',
  DOCUMENT_VIEWED: 'workspace.document_viewed',
  DOCUMENT_DOWNLOADED: 'workspace.document_downloaded',
  DOCUMENT_ACCESS_DENIED: 'workspace.document_access_denied',
  GUEST_INVITED: 'workspace.guest_invited',
  GUEST_REISSUED: 'workspace.guest_reissued',
  GUEST_REVOKED: 'workspace.guest_revoked',
  GUEST_ACCEPTED: 'workspace.guest_accepted',
  GUEST_ACTION: 'workspace.guest_action',
  GUEST_ACCESS_DENIED: 'workspace.guest_access_denied',
  ASSERTION_MADE: 'workspace.assertion_made',
  ARTIFACT_RENDERED: 'workspace.artifact_rendered',
  ARTIFACT_TRANSMITTED: 'workspace.artifact_transmitted',
  ARTIFACT_NOT_TRANSMITTED: 'workspace.artifact_not_transmitted',
  ARTIFACT_DELIVERY_FAILED: 'workspace.artifact_delivery_failed',
  CAPABILITY_VERIFIED: 'workspace.capability_verified',
  EXCEPTION_RAISED: 'workspace.exception_raised',
  EXCEPTION_RESOLVED: 'workspace.exception_resolved',
  REASSOCIATED: 'workspace.reassociated',
  OVERDUE: 'workspace.overdue',
  ARCHIVED: 'workspace.archived',
} as const;

// Gaps in the existing vocabulary, closed by this PRD
export const ReferralEvents = {
  ROUTING_CHANGED: 'referral.routing_changed',
  DISPOSITION_OVERRIDDEN: 'referral.disposition_overridden',
  PENDING_INFO_ESCALATED: 'referral.pending_info_escalated',
} as const;
```

Evidence classification, answering the source document's open question:

| Evidence | Proves | Sources |
|---|---|---|
| `delivery` | An artifact reached the counterparty's address | `outbound_messages.acknowledged_at`, MDN receipt, `workspace_assertions.delivery_status` |
| `access` | A human opened the content | `document_access_log`, `comment_reads` |
| `null` | Neither — an internal action or a state change | everything else |

A transmitted-but-unacknowledged artifact has neither. That absence is information and the feed shows
it as such.

### API Design

**Endpoint:** `GET /api/workspaces/:id/activity`

**Query:** `?kind=user` (optional; omit for all)

**Response:**
```json
{
  "counts": { "system": 12, "user": 6, "guest": 3, "status": 9, "delivery": 4, "access": 5 },
  "entries": [
    { "id": "workflow_events:412", "kind": "status", "eventType": "referral.scheduled",
      "occurredAt": "2026-09-14T16:20:00Z", "actor": "user:7", "actorLabel": "Dana Ruiz",
      "summary": "Appointment scheduled for 22 Sep, Cardiology Suite 2",
      "fromState": "Accepted", "toState": "Scheduled",
      "artifact": { "kind": "assertion", "id": 88, "label": "SIU scheduling notice" },
      "evidence": null, "metadata": {} },
    { "id": "document_access_log:57", "kind": "guest", "eventType": "workspace.document_viewed",
      "occurredAt": "2026-09-14T17:02:00Z", "actor": "guest:4",
      "actorLabel": "Lakeside Cardiology (guest)",
      "summary": "Opened Referral Note",
      "fromState": null, "toState": null,
      "artifact": { "kind": "document", "id": 340, "label": "Referral Note" },
      "evidence": "access", "metadata": {} }
  ]
}
```

**Guest:** `GET /api/guest/activity` — protocol events, shared comments and shared documents only.

---

## Test Plan

**Unit Tests:**
- `getActivityFeed()` returns events in chronological order for a referral with a full lifecycle
- The merge interleaves events, comments, documents and access records correctly by timestamp
- `counts` reflect unfiltered totals even when a `kind` filter is applied
- `actorLabel` resolves each actor form: `system`, `clinician:<id>`, `skill:<name>`, `payer:<name>`,
  `user:<id>`, `guest:<id>`, and an unknown form degrades to the raw string rather than throwing
- `evidence` is `delivery` for an ack, `access` for a document view, `null` for an assignment
- A transmitted-but-unacknowledged artifact yields no delivery evidence
- `getGuestActivityFeed()` contains no internal event types — asserted against an explicit deny list
  *and* by confirming the payload is built from an allow list

**Integration Tests:**
- Drive a referral through intake, routing change, assignment, comments, a guest document view, an
  assertion and closure, then assert every one appears once in the feed with the right kind and actor
- Change the routing department and assert `referral.routing_changed` with previous and new values
- Override a disposition and assert the state change went through `transition()` and emitted
  `referral.disposition_overridden`
- Enumerate every mutating workspace route and assert each writes at least one event (AC13)
- Auto-decline a referral and assert the event is reachable rather than orphaned

**Edge Cases:**
- Workspace with no activity beyond creation
- Several hundred entries — one request, no timeout, ordering stable
- Two events with identical timestamps — deterministic tiebreak by source and id
- An event whose `metadata` is malformed JSON — the entry renders with a degraded summary rather than
  failing the whole feed
- A comment deleted after its event was emitted — the feed shows it as deleted, not as missing

**Boundary Tests:**
- No internal event, internal comment or internal document appears in the guest feed
- Adding a new internal event type does not cause it to appear in the guest feed (allow-list proof)

**Regression:**
- `tests/unit/analytics/analyticsQueries.test.ts` and the analytics dashboard figures are unchanged
- The review page journey timeline continues to work from its existing sources

---

## Deliverables

- `src/modules/workspace/activityService.ts`
- `src/modules/workspace/eventCatalog.ts`
- `GET /api/workspaces/:id/activity`, `GET /api/guest/activity`
- Event emission added at the uninstrumented sites: `POST /api/referrals/:id/routing`,
  `POST /referrals/:id/override`, `prd09/pendingInfoChecker.ts` escalation
- Both state-machine bypasses routed through `transition()`, with the reopen decision documented
- Auto-decline recording so `entityId: 0` events become reachable
- Activity panel in the `#wsActivity` slot, reusing `.response-timeline` from `priorAuthDetail.html`
- `tests/unit/workspace/activityService.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-14 - Analytics Agent (Phase 1)]] — the event log being read per entity for the first time
- [[PRD-19 - Workspace Shell]] — the slot
- [[PRD-22 - Referral Conversation]], [[PRD-23 - Document Collection]],
  [[PRD-29 - 360X Protocol Gateway]] — feed sources
- [[PRD-28 - Correlation & Exception Queue]] — exception events in the feed
- [[PRD-30 - Guest Participation]] — the guest feed audience
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-14  
**Version:** 1.0
