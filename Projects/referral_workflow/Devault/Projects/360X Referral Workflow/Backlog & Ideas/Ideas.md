---
title: Ideas & Future Features
tags: [ideas, brainstorm, backlog, epic]
up: "[[_INDEX]]"
same: "[[In Progress]]"
---

# 💡 Ideas & Future Features

Ideas for expanding and enhancing the 360X Referral Workflow system.

## Current Phase

The closed-loop protocol core (PRD-01 … PRD-15) is implemented. Active work is the
[[../Features/PRD-16 - 360X Referral Collaboration Workspace|Collaboration Workspace epic]]
(PRD-16 … PRD-30). This document tracks ideas that sit outside that epic, plus the epic's own
later-phase opportunities.

## Feature Ideas

### FHIR Integration (PRD-08)
- **Status:** Planned
- **Epic:** Patient Lookup and Clinical Data Enrichment
- **Summary:** Integrate with HAPI FHIR servers to enrich C-CDA data with FHIR resources
- **Potential User Stories:**
  - As a clinician, I want to see complete patient history from FHIR when reviewing a referral
  - As a system, I want to validate C-CDA against FHIR patient records
- **Tags:** `#epic`, `#fhir`, `#future`

### Agent-Powered Rules Engine (PRD-09)
- **Status:** Planned
- **Epic:** AI-Powered Skills Engine
- **Summary:** Implement a skills engine that uses Claude and Gemini for dynamic decision-making at different workflow stages
- **Key Components:**
  - YAML skill definitions
  - Deterministic script evaluation
  - Fallback to AI reasoning (Gemini 2.5-Flash)
  - Skill execution logging
- **Tags:** `#epic`, `#ai`, `#skills`, `#future`

### Enhanced Clinician Dashboard
- **Status:** Superseded — largely delivered by [[../Features/PRD-14 - Analytics Agent (Phase 2)|PRD-14 Phase 2]] and the Collaboration Workspace epic
- **Summary:** The funnel view, message/ack status and performance metrics landed in the analytics
  dashboard. The operational half — queues, ownership, due dates and next actions — is now
  [[../Features/PRD-20 - Shared Queues & Queue View|PRD-20]],
  [[../Features/PRD-21 - Ownership & Assignment|PRD-21]] and
  [[../Features/PRD-26 - Next Action & Due Dates|PRD-26]].
- **Still open:** a calendar view of scheduled appointments — not covered by any current PRD
- **Tags:** `#feature`, `#dashboard`, `#ui`, `#superseded`

### Referral Analytics & Reporting
- **Status:** Backlog
- **Summary:** Generate reports on:
  - Referral volume trends
  - Acceptance/decline rates by specialty
  - Processing time analysis
  - Message delivery reliability metrics
- **Tags:** `#feature`, `#analytics`, `#reporting`

### Webhook Integration for External Systems
- **Status:** Backlog
- **Summary:** Allow external systems to subscribe to referral events (created, accepted, declined, closed)
- **Use Case:** Integration with scheduling systems, billing platforms, etc.
- **Tags:** `#feature`, `#integration`, `#webhooks`

### Batch Message Processing
- **Status:** Backlog
- **Summary:** Support bulk import/export of referrals for migration scenarios
- **Tags:** `#feature`, `#data-management`

### Multi-Specialty Routing Rules
- **Status:** Backlog
- **Summary:** Implement intelligent routing based on:
  - Patient diagnosis
  - Provider availability
  - Specialty requirements
  - Geographic location
- **Tags:** `#feature`, `#routing`, `#advanced`

### Audit Trail & Compliance Reporting
- **Status:** Superseded in part by the Collaboration Workspace epic
- **Summary:** Immutable event logging arrived with [[../Features/PRD-14 - Analytics Agent (Phase 1)|PRD-14 Phase 1]];
  user and guest action tracking, document access logging, and delivery-versus-access evidence are
  [[../Features/PRD-25 - Activity History & Audit|PRD-25]]; least-privilege queue and workspace access
  are [[../Features/PRD-20 - Shared Queues & Queue View|PRD-20]] and
  [[../Features/PRD-30 - Guest Participation|PRD-30]].
- **Still open:** tamper-evident logging (hash chaining, append-only storage guarantees), retention
  and purge policy, and compliance reporting/export — none of these is covered by a current PRD and
  each is worth its own
- **Tags:** `#feature`, `#compliance`, `#security`, `#partially-superseded`

### Message Encryption & Security Hardening
- **Status:** Backlog
- **Summary:** Implement S/MIME or PGP encryption for message payloads
- **Alignment:** Production readiness for 360X security requirements
- **Tags:** `#feature`, `#security`, `#production`

## Collaboration Workspace — Later-Phase Opportunities

From the 360X software collaboration review, documented in
[[../Features/PRD-16 - 360X Referral Collaboration Workspace|PRD-16]] but deliberately outside its
delivery scope.

### Cross-Organization Chat as a Product Surface
- **Status:** Later phase
- **Summary:** Conversation beyond a single referral — chat tied to a shared client or case across
  partner organizations, following the Unite Us model. The referral-scoped conversation is
  [[../Features/PRD-22 - Referral Conversation|PRD-22]]; this is the step past it.
- **Tags:** `#feature`, `#collaboration`, `#later-phase`

### Patient & Caregiver Progress Visibility
- **Status:** Later phase
- **Summary:** A shared-journey view where the referred individual can see progress, next steps and
  outcomes, following the Findhelp model. Explicitly excluded from the epic's MVP.
- **Tags:** `#feature`, `#patient-experience`, `#later-phase`

### Subtasks, Checklists & Escalation Chains
- **Status:** Later phase
- **Summary:** Multiple owners, subtasks, per-participant service-level timers and escalation
  ladders. The epic delivers one owner and one next action; this is the project-management layer
  above it.
- **Tags:** `#feature`, `#workflow`, `#later-phase`

### Provider Matching, Capacity & Scheduling Coordination
- **Status:** Later phase
- **Summary:** Provider matching, availability and capacity-aware scheduling coordination, following
  the ReferralMD pattern. Builds on the existing resource catalogue in
  `src/modules/prd03/resourceCalendar.ts`.
- **Tags:** `#feature`, `#scheduling`, `#later-phase`

### AI Referral-Packet Summaries
- **Status:** Later phase
- **Summary:** AI-generated summaries of an inbound referral packet so a coordinator can triage
  without reading the full C-CDA, following the WellSky CarePort pattern. Related to the existing
  routing assessment in PRD-13.
- **Tags:** `#feature`, `#ai`, `#later-phase`

### Referral-Network Analytics, Leakage & Partner Scorecards
- **Status:** Later phase
- **Summary:** Network-level analytics — referral leakage, partner responsiveness scorecards,
  organization-level acceptance and turnaround. Extends
  `src/modules/analytics/analyticsQueries.ts` with the party and workspace data the epic introduces.
- **Tags:** `#feature`, `#analytics`, `#later-phase`

### Delegated Direct Mailbox (Gateway Transport Mode B)
- **Status:** Later phase
- **Summary:** Let a party connect their own Direct mailbox credentials so artifacts the gateway
  renders on their behalf are genuinely signed as them, completing non-repudiation.
  [[../Features/PRD-29 - 360X Protocol Gateway|PRD-29]] ships Mode A (address on file) and is shaped
  so this needs no data-model rework. Requires credential storage, which PRD-29 excludes.
- **Tags:** `#feature`, `#interoperability`, `#security`, `#later-phase`

---

## Optimization Ideas

### Performance
- [ ] Cache parsed C-CDA objects to reduce re-parsing
- [ ] Implement connection pooling for IMAP/SMTP
- [ ] Add database indexing for common queries
- **Tags:** `#performance`, `#optimization`

### Scalability
- [ ] Move from SQLite to PostgreSQL for multi-instance deployments
- [ ] Implement message queue (e.g., RabbitMQ) for high-volume scenarios
- [ ] Add horizontal scaling support
- **Tags:** `#scalability`, `#infrastructure`

### Testing
- [ ] Add E2E tests using Docker + mock EHR systems
- [ ] Expand integration test coverage
- [ ] Performance testing suite (load/stress testing)
- **Tags:** `#testing`, `#quality`

## Exploration Ideas

### Research Areas
- [ ] Integration with Direct Trust HIE networks for real deployments
- [ ] Real-time appointment availability APIs (e.g., CarePlus, Availity)
- [ ] HL7 FHIR Appointment scheduling (in addition to HL7 V2 SIU)
- [ ] Blockchain for immutable audit trails (research phase)

### Vendor Integration Opportunities
- [ ] Epic EHR integration
- [ ] Cerner integration
- [ ] Allscripts integration
- **Rationale:** Test interoperability against real-world EHR variations

---

## Backlog Prioritization

The items above are roughly organized by:
1. **Planned** — Next phase after core PRDs (PRD-08, PRD-09)
2. **Backlog** — Future enhancements (Q2-Q3 planning)
3. **Optimization** — Quality/performance improvements (ongoing)
4. **Exploration** — Research/investigation phase (future consideration)

---

## How to Propose New Ideas

1. Add a new section in **Backlog** with a descriptive title
2. Include: Status, Summary, Key Points, and relevant tags
3. Link to related PRDs or features using `[[]]` syntax
4. Tag with appropriate labels: `#feature`, `#bug`, `#epic`, `#optimization`, `#security`, etc.

---

## Related Documents

- [[../Features/📋 PRD Index|PRD Index (PRD-01 … PRD-30)]]
- [[../Features/PRD-16 - 360X Referral Collaboration Workspace|Collaboration Workspace Epic]]
- [[In Progress|In Progress Work]]
- [[../🎯 PROJECT OVERVIEW|Project Overview]]
