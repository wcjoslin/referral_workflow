---
up: "[[📋 PRD Index]]"
prev: "[[PRD-24 - Parties & Participants]]"
---

# PRD-25: Unified Activity History & Audit

**Status:** Implemented  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`, `analytics/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

The audit substrate is already here and it is good. PRD-14 built `workflow_events` — an append-only
log with event type, entity, from/to state, actor and a JSON metadata blob, written through a single
fire-and-forget `emitEvent()`, indexed on `(entity_type, entity_id)` and on `(event_type, created_at)`.

The draft of this PRD counted 21 event types across roughly 28 call sites. That was true when PRD-14
wrote it. **It is now 49 event types across 69 call sites in 22 files** — the epic more than doubled
the vocabulary, which is precisely why a catalog is needed and precisely why the draft's version of
it had already drifted.

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
- One event catalog naming the 49 event types that are actually emitted, plus the three this PRD adds
- Event emission at the uninstrumented sites; the two LEGAL bypasses routed through `transition()`,
  and the one illegal reopen confined to an audited exception
- Fixing the retransmit path's orphaned `entityId: 0`
- The activity panel in the `#wsActivity` slot
- A guest-facing activity view containing protocol and shared events only

**Out of Scope:**
- Making the auto-decline event reachable — PRD-28's `auto_declined_referrals` owns it
- Changing the `workflow_events` schema — the existing table and indexes are sufficient and are used
  by analytics
- Retention, archival or export of audit data — inherited from the deployment; noted as a gap
- Analytics aggregation — PRD-14 Phase 2 and PRD-15 own that; this PRD reads per entity
- Tamper-evident logging (hash chaining, append-only storage guarantees) — a production concern worth
  its own PRD, called out here so its absence is not mistaken for completeness
- Real-time streaming of the feed

---

## Refinement decisions

| # | Decision | Effect |
|---|---|---|
| 1 | **An audited exception path, not a widened transition table** | `VALID_TRANSITIONS[DECLINED]` stays `[]`. One named `reopenDeclined()` is the only place a terminal state may be left; it emits an event recording that it bypassed the machine. The bypass does not go away — it stops being scattered and invisible. |
| 2 | **The auto-decline stranding stays PRD-28's** | PRD-25 fixes the gaps it owns. Pulling `auto_declined_referrals` forward would give one table two owners. |

### The two bypasses are not the same problem

The draft treated `POST /referrals/:id/override` and the `pendingInfoChecker` escalation as one
issue. Checked against `VALID_TRANSITIONS`, they split three ways:

| Site | Transition | Legal? | Fix |
|---|---|---|---|
| `pendingInfoChecker.ts:89` escalation | `Pending-Information → Acknowledged` | **yes** | route through `transition()` |
| `override`, from `Pending-Information` | `Pending-Information → Acknowledged` | **yes** | route through `transition()` |
| `override`, from `Declined` | `Declined → Acknowledged` | **no** — terminal | `reopenDeclined()`, decision 1 |

Two of the three need no exception at all. Only reopening a declined referral does, and confining the
exception to that one case is what keeps the machine meaningful.

### Three `entityId: 0` sites, and only one is a bug

The draft knew about one. There are three, and they are different in kind:

| Site | Why | Disposition |
|---|---|---|
| `protocolGateway.ts:720` — retransmit | **A bug.** Every other emit in that file resolves `referral.id`; this path passes 0 although the assertion carries a `workspaceId`. A retransmitted artifact's event is therefore orphaned and would never appear in this PRD's feed. | **Fixed here.** Introduced by PRD-29; mine. |
| `referralService.ts:226` — auto-decline | No referral row exists to point at. | PRD-28's `auto_declined_referrals`. |
| `server.ts:2233` — guest denial | No workspace could be resolved, and that IS the denial. `entityId: 0` is the honest value. | Correct as-is; documented, not "fixed". |

So AC12 as drafted — "an auto-declined referral is recorded such that the event is reachable" — is not
this PRD's to satisfy, and `entityId: 0` is not by itself a defect.

### What the codebase pass changed

1. **The catalog in the draft was already wrong**, in three ways at once: it names
   `workspace.document_added` where PRD-23 emits `workspace.document_indexed`; it omits four events
   that are emitted (`party_address_observed`, `comment_downgrade_refused`,
   `comment_mention_acknowledged`, `work_status_resynced`); and it declares eleven that nothing emits
   (`queue_changed`, `participant_role_changed`, `guest_action`, `artifact_rendered`,
   `artifact_transmitted`, `artifact_delivery_failed`, `exception_raised`, `exception_resolved`,
   `reassociated`, `overdue`, `reassigned`). **The catalog names what is emitted, plus what this PRD
   adds, and nothing else.** A source of truth listing phantoms is worse than no catalog, and the
   eleven belong to the PRDs that will emit them.
2. **`comment_reads` does not exist.** The draft's evidence table cites it as a source of `access`
   evidence. PRD-22 deliberately did not build it — the share lock reads
   `workspace_guests.last_seen_at` instead. So **documents have per-read access evidence and comments
   do not**, and the evidence table says so rather than implying a source that was never built.
3. **`referral.routing_changed` really is missing.** `POST /api/referrals/:id/routing` contains zero
   `emitEvent` calls. Confirmed by count.
4. **Both bypass sites already carry a comment naming PRD-25 as their fix.** `server.ts` and
   `pendingInfoChecker.ts` each say the bypass "is PRD-25's to fix", so this is a debt the epic
   recorded against itself rather than a new discovery.
5. **The actor prefix format is load-bearing, as claimed.** `analyticsQueries.ts:53` matches
   `actor = 'payer:' + payer` exactly. Adding prefixes is safe; changing one breaks a dashboard.
6. **`clinician:` already contains non-humans**, per PRD-17: `SYSTEM-SKILL-<name>` and
   `SYSTEM-TIMEOUT` are written through `dispositionService`. The resolver must not render those as
   people — that is the exact bug PRD-17 fixed in the analytics filter, and re-introducing it in a
   feed would be worse, because a feed is read as a narrative of who did what.
7. **No migration.** This PRD adds no table and no column, which is why its risk is concentrated
   entirely in the two bypasses rather than in the schema.

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
**AC12:** The retransmit path's orphaned `entityId: 0` is fixed, so every assertion event resolves to
its referral. The auto-decline stranding is recorded as PRD-28's, and the guest-denial `entityId: 0`
is documented as correct rather than changed.  
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
| `access` | A human opened the content | `document_access_log` only. **Comments have no per-read evidence** — PRD-22 did not build `comment_reads`, using `workspace_guests.last_seen_at` for its share lock instead. A shared comment can be shown as *reachable* by a guest, never as *read* by one, and the feed does not pretend otherwise. |
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

**Version:** 1.2 — Implemented. Built as specified at v1.1, with 880 tests across 47 suites and
205 smoke checks green. No migration: this PRD adds no table and no column, so its risk was
concentrated entirely in the bypasses rather than the schema.

- **The catalog is now checkable, not aspirational.** A test greps every `eventType:` literal out of
  `src/` and asserts the catalog names it. That is the only thing that makes "single source of truth"
  mean anything, and it is what the draft's version — which had drifted three ways before a line was
  written — could never have claimed.
- **`reopenReferral()` is asserted to be the only bypass, structurally.** A test greps `src/` for
  direct `Acknowledged` writes and asserts exactly two files appear: `dispositionOverride.ts`, which
  owns the exception, and `pendingInfoChecker.ts`, which writes the same state but now calls
  `transition()` first. A third file appearing means this PRD's central claim has become false, and
  the test says so.
- **The guest feed's allow-list is proved by an event nobody forbade.** A test emits
  `workspace.exception_raised_in_some_future_prd` and asserts it does not reach a guest. A deny-list
  would have had to anticipate that name.
- **Every reserved panel in PRD-19's shell is now filled.** `slots` went from five placeholders to
  five `true`, and the assertion that came past every one of them — added in PRD-19, updated by 21,
  22, 23 and 25 — did its job: no panel was ever half-wired behind a flag saying otherwise.

Two smoke assertions I wrote were wrong rather than the code, both for the same reason: they ran
inside the guest block, before the protocol activity they asserted on existed. The positive checks
moved to the end of the run and the orphan check became a direct assertion that no
`workspace.assertion_made` event sits at `entityId: 0` — which tests the retransmit bug better than
the check it replaced.
