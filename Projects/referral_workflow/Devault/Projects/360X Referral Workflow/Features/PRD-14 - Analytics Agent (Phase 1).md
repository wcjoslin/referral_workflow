---
up: "[[📋 PRD Index]]"
prev: "[[PRD-13 - Department Classification]]"
---

# PRD-14: Analytics Agent — Phase 1: Unified Event Log

**Status:** In Progress 🟡  
**Team:** Analytics & Insights  
**Module:** `analytics/`  
**Started:** 2026-04-10

---

## Context

The referral workflow has multiple failure points spread across services with no unified event tracking: denials from payers, prior auth rejections, no-shows, information requests, routing issues. State transitions are tracked only via `updatedAt` timestamps on individual tables. There's no way to correlate events across services, identify patterns, or surface actionable insights to workflow operators.

Currently, analytics data is fragmented:
- Skill evaluations → `skillExecutions` table
- Message acknowledgments → `outboundMessages` table  
- Prior auth decisions → `priorAuthResponses` table
- State changes → implicit in `updatedAt` timestamps

This fragmentation makes it impossible to answer high-level questions like:
- "Which payers deny the most prior auth requests? For what reasons?"
- "Which clinicians decline referrals? On what criteria?"
- "How long do referrals spend in each state?"
- "Which skills match frequently vs. rarely?"

**Phase 1 establishes the foundation:** a unified event log. Phases 2 and 3 will build analytics dashboards and a proactive agent on top.

## Goal

Implement a centralized workflow event audit log that captures every meaningful event across the referral and prior-auth workflows, enabling future analytics and insights.

## User Stories

- As a **workflow analyst**, I want to query all events for a referral (state transitions, messages sent, skill evaluations, decisions) in chronological order, so that I can understand the complete history of a referral's journey.
- As a **data engineer**, I want all events to be logged consistently with rich metadata (denial reasons, payer info, confidence scores, actors), so that I can build aggregation queries without ad-hoc parsing.
- As a **Phase 2 analyst**, I want indexed access to events by entity type/ID and event type/time, so that dashboard queries run efficiently.

## Acceptance Criteria

**AC1:** All referral state transitions are logged to `workflow_events` with `fromState`, `toState`, `actor`, and `createdAt`.

**AC2:** All message sends (RRI, SIU, ConsultNote, etc.) are logged with `messageControlId`, `messageType`, and recipient address.

**AC3:** All skill evaluations are logged with trigger point, matched status, confidence score, and explanation.

**AC4:** All prior auth outcomes (approved/denied/pended/expired) are logged with outcome, denial reason (if applicable), and payer name.

**AC5:** Event metadata is stored as JSON for extensibility without schema changes.

**AC6:** New skills created via Phase 3 are automatically logged (no per-skill wiring needed).

**AC7:** Event emission is fire-and-forget (never blocks primary workflow); failures are logged but don't fail the transaction.

**AC8:** All existing tests pass (zero regressions).

---

## Technical Specifications

### Schema

**`workflow_events` table:**
```sql
CREATE TABLE workflow_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,           -- e.g. 'referral.received', 'skill.evaluated'
  entity_type TEXT NOT NULL,          -- 'referral' | 'priorAuth'
  entity_id INTEGER NOT NULL,         -- referral.id or priorAuthRequest.id
  from_state TEXT,                    -- nullable (not all events are transitions)
  to_state TEXT,                      -- nullable
  actor TEXT NOT NULL,                -- 'system' | 'clinician:<id>' | 'skill:<name>' | 'payer:<name>'
  metadata TEXT,                      -- JSON blob for event-specific context
  created_at INTEGER NOT NULL         -- timestamp
);

CREATE INDEX idx_workflow_events_entity ON workflow_events (entity_type, entity_id);
CREATE INDEX idx_workflow_events_type_time ON workflow_events (event_type, created_at);
```

### Event Types

**Referral events (30+ event types):**
- Intake: `referral.received`, `referral.acknowledged`, `referral.routing_assessed`, `referral.auto_declined`
- Disposition: `referral.accepted`, `referral.declined`
- Scheduling: `referral.scheduled`
- Encounter: `referral.encounter_complete`, `referral.no_show`
- Consultation: `referral.consult_requested`, `referral.consult_resolved`
- Closure: `referral.closed`, `referral.closed_confirmed`
- Info requests: `referral.pending_info`

**Message events:**
- `message.sent` (RRI, SIU, ConsultNote, InterimUpdate, InfoRequest, NoShowNotification, ConsultRequest)
- `message.acknowledged`

**Skill events:**
- `skill.evaluated` (all evaluations, including non-matches)
- `skill.action_executed` (when matched skill fires an action)

**Prior auth events:**
- Submission: `prior_auth.submitted`
- Outcomes: `prior_auth.approved`, `prior_auth.denied`, `prior_auth.pended`
- Lifecycle: `prior_auth.expired`, `prior_auth.error`

### Implementation

**Event Service (`src/modules/analytics/eventService.ts`):**
- Single `emitEvent(event: WorkflowEvent)` function
- Inserts to `workflow_events` table
- Fire-and-forget: callers use `void emitEvent(...).catch(err => console.error(...))`
- Never blocks primary workflows

**Emission Points (12 service files):**
- PRD-02: referralService, dispositionService
- PRD-03: schedulingService
- PRD-04: consultNoteService
- PRD-05: encounterService
- PRD-06: ackService
- PRD-09: skillEvaluator, skillActions, infoRequestService
- PRD-11: noShowService, consultService
- PRD-12: priorAuthService

### Dependencies

- **Drizzle ORM:** Schema definition + indexes
- **SQLite:** `better-sqlite3` with WAL mode for concurrent reads
- **No new external dependencies**

### Testing

**Unit tests:**
- `tests/unit/analytics/eventService.test.ts`: 5 tests covering event insertion, JSON metadata, multi-event sequences
- All existing 411 tests pass (zero regressions)

---

## Deliverables

✅ **Implemented (2026-04-10):**
1. `workflowEvents` table with dual indexes
2. Drizzle migration (0009_secret_starhawk.sql)
3. Event service module
4. Event emission wired across 12 service files (30+ event types)
5. Unit tests (5 new tests)
6. Full test suite passing (411/411)

**Status:** Phase 1 complete. Ready for Phase 2.

---

## Phase 2 & 3 Preview

*Documented separately. Phase 1 is the prerequisite for both.*

**Phase 2:** SQL-based analytics dashboards querying `workflow_events` for insights (denial rates by payer, skill match frequencies, referral funnel, timing analysis, etc.).

**Phase 3:** Proactive agent that reads Phase 2 aggregations and suggests new skills to operators.

---

## Known Limitations & Future Work

1. **Claims workflow not tracked:** Phase 1 covers referrals and prior auth only. X12 claims attachment workflow can be retrofitted in a future phase.
2. **No clinical document analysis yet:** Raw C-CDA content is not analyzed at ingestion time. This is explicitly deferred.
3. **No data retention policy:** Events are never purged (acceptable for PoC; production would need TTL).
4. **SQLite scaling:** For very large event volumes (>1M events), consider partitioning or migration to PostgreSQL.

---

## Success Metrics

- ✅ Zero regressions in existing test suite
- ✅ Event coverage for all major workflow paths
- ✅ Metadata richness enabling Phase 2 queries
- ✅ Fire-and-forget reliability (no blocking failures)

---

## Related Documents

- [[Analytics Agent]] — feature context and motivation
- [[PRD-02 - Process & Disposition]] — disposition events
- [[PRD-09 - AI-Powered Rules Engine]] — skill evaluation events
- [[PRD-12 - Prior Authorization]] — prior auth events
