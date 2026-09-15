---
title: PRD Index - All Product Requirements
tags: [prd, features, index]
up: "[[🎯 PROJECT OVERVIEW]]"
down: ["[[PRD-01 - Receive & Acknowledge]]", "[[PRD-02 - Process & Disposition]]", "[[PRD-03 - Schedule Patient]]", "[[PRD-04 - Generate Consult Note]]", "[[PRD-05 - Patient Encounter]]", "[[PRD-06 - Close Loop]]", "[[PRD-07 - Ack Tracking]]", "[[PRD-10 - UI Modernization & CCDA Viewer]]", "[[PRD-11 - No-Show & Consult States]]", "[[PRD-12 - Prior Authorization]]", "[[PRD-13 - Department Classification]]", "[[PRD-14 - Analytics Agent (Phase 1)]]", "[[PRD-14 - Analytics Agent (Phase 2)]]", "[[PRD-15 - Analytics Agent AI]]", "[[Feature - Human-Readable Email Summaries]]", "[[Feature - Human-Readable Message Type Labels]]", "[[Feature - No-Show & Consult Demo Scenarios]]", "[[Feature - Full Demo Seed Expansion (100 Scenarios)]]", "[[PRD-16 - 360X Referral Collaboration Workspace]]", "[[PRD-17 - Identity & Acting User]]", "[[PRD-18 - Workspace Entity & Dual Status]]", "[[PRD-19 - Workspace Shell]]", "[[PRD-20 - Shared Queues & Queue View]]", "[[PRD-21 - Ownership & Assignment]]", "[[PRD-22 - Referral Conversation]]", "[[PRD-23 - Document Collection]]", "[[PRD-24 - Parties & Participants]]", "[[PRD-25 - Activity History & Audit]]", "[[PRD-26 - Next Action & Due Dates]]", "[[PRD-27 - Notifications]]", "[[PRD-28 - Correlation & Exception Queue]]", "[[PRD-29 - 360X Protocol Gateway]]", "[[PRD-30 - Guest Participation]]"]
---

# 📋 PRD Index

Product Requirements Documents for the 360X Referral Workflow project. PRD-01 through PRD-15 map to phases of the closed-loop referral process. PRD-16 through PRD-30 form the [[PRD-16 - 360X Referral Collaboration Workspace|Collaboration Workspace epic]], which layers a persistent referral workspace over that protocol core and makes the workspace itself the 360X enablement layer for both parties.

---

## Development Roadmap

The logical order for PRD development:

### 1. **[[PRD-01 - Receive & Acknowledge|PRD-01: Receive and Acknowledge Referral]]** ✅
**Foundational step.** You must be able to receive and acknowledge a referral before any other processing can happen.

- Receive C-CDA via Direct Secure Messaging
- Parse and extract patient/referral data
- Send MDN acknowledgment
- **Database Prerequisite:** SQLite + Drizzle schema required before PRD-02

**Status:** ✅ Complete  
**Module:** `prd01/`

---

### 2. **[[PRD-02 - Process & Disposition|PRD-02: Process and Disposition Referral]]** ✅
**Core logic of the referral process.** Determines if a patient can even be seen.

- Validate C-CDA completeness using AI reasoning
- Present valid referrals to clinician for Accept/Decline decision (manual step)
- Auto-decline incomplete referrals
- Generate RRI^I12 accept/decline message
- **Prerequisite:** PRD-01 + database persistence

**Status:** ✅ Complete  
**Module:** `prd02/`

---

### 3. **[[PRD-03 - Schedule Patient|PRD-03: Schedule Patient and Notify Referrer]]** ✅
**Logical next step for accepted referrals.**

- Present patient to scheduling system
- Auto-assign appointment slots (mock scheduler)
- Generate SIU^S12 scheduling message
- **Prerequisite:** PRD-02 (accepted referral)

**Status:** ✅ Complete  
**Module:** `prd03/`

---

### 4. **[[PRD-04 - Generate Consult Note|PRD-04: Generate and Send Final Consult Note]]** ✅
**Primary goal of the workflow—sending the final report.**

- Detect clinician-signed final note
- Extract clinical summary using AI
- Generate valid Consult Note C-CDA
- Package and send via Direct
- **Prerequisite:** PRD-03 (scheduled appointment)

**Status:** ✅ Complete  
**Module:** `prd04/`

---

### 5. **[[PRD-05 - Patient Encounter|PRD-05: Patient Encounter and Interim Updates]]** ✅
**Fills the gap between scheduling and final note.**

- Detect appointment time trigger
- Send ADT^A04 encounter message
- Support optional interim update messages
- Update referral state to "Encounter"
- **Prerequisite:** PRD-03 (scheduled)

**Status:** ✅ Complete  
**Module:** `prd05/`

---

### 6. **[[PRD-06 - Close Loop|PRD-06: Acknowledge Final Report and Close Loop]]** ✅
**Implements the final handshake.**

- Detect inbound ACK for Consult Note
- Correlate ACK to sent message
- Update state to "Closed-Confirmed"
- Mark loop as complete
- **Prerequisite:** PRD-04 (consult note sent)

**Status:** ✅ Complete  
**Module:** `prd06/`

---

### 7. **[[PRD-07 - Ack Tracking|PRD-07: Referrer-Side Acknowledgment Tracking]]** ✅
**Enhances system robustness** (can be developed in parallel).

- Monitor outbound messages for acknowledgments
- Detect overdue/missing ACKs
- Provide dashboard visibility
- Implement retry logic

**Status:** ✅ Complete  
**Module:** `prd07/`

---

### 8. **[[PRD-11 - No-Show & Consult States|PRD-11: No-Show & Consult States]]** ✅
**Fills missing lifecycle gaps** for appointments and post-encounter consultation.

- Mark a scheduled appointment as no-show; notify referring physician
- Allow rescheduling from No-Show state using existing referral document
- Allow specialist to flag post-encounter consultation need
- Reintroduce clinician confirmation step before loop closure
- **Prerequisite:** PRD-03 (Scheduled), PRD-05 (Encounter)

**Status:** ✅ Complete  
**Module:** `prd11/`

---

### 9. **[[PRD-12 - Prior Authorization|PRD-12: Prior Authorization (Da Vinci PAS)]]** ✅
**FHIR-based prior authorization gate** before referral submission per CMS-0057-F.

- Submit prior authorization requests via Da Vinci PAS `$submit` operation
- Handle approved, denied, and pended outcomes with subscription + polling
- Auto-populate PA form from referral clinical data with clinician edit
- Mock payer with deterministic decision logic for demo scenarios
- Pended requests auto-expire to Expired state after configurable timeout
- **Prerequisite:** PRD-08 (FHIR client), PRD-02 (referral with clinical data)

**Status:** ✅ Complete  
**Module:** `prd12/`

---

### 10. **[[PRD-13 - Department Classification|PRD-13: Department Classification & Administrative Routing]]** 🔧
**Repurposes AI assessment for administrative triage** — department routing, equipment identification, and care-request summarization.

- Classify referrals into departments from the facility catalogue
- Surface required equipment and diagnostic resources
- Editable routing controls for coordinator overrides
- Department badge + filter on inbox dashboard
- **Prerequisite:** PRD-02 (disposition flow), PRD-03 (resource catalogue)

**Status:** 🔧 In Progress  
**Module:** `prd02/`

---

### 14. **[[PRD-14 - Analytics Agent (Phase 1)|PRD-14: Analytics Agent — Phase 1: Unified Event Log]]** ✅
**Foundation for analytics & insights.** Establishes centralized event logging across all workflows for future dashboards and proactive recommendations.

- Unified `workflow_events` table capturing all state transitions, messages, skill evaluations, and decisions
- Event service module (fire-and-forget, non-blocking)
- Rich metadata (denial reasons, payer info, confidence scores, actor tracking)
- Dual indexes for efficient Phase 2 queries
- **Prerequisite:** None (foundational infrastructure)

**Status:** ✅ Complete (2026-04-10)  
**Module:** `analytics/`

---

### 14b. **[[PRD-14 - Analytics Agent (Phase 2)|PRD-14 Phase 2: Analytics Agent — SQL Dashboard]]** 🔧
**Operational insights dashboard.** SQL-based charts and KPIs querying the Phase 1 event log — no AI required.

- KPI cards: acceptance rate, avg days to close, PA approval rate, no-show rate
- Charts: daily intake trend, state distribution, PA outcomes doughnut, denial reasons
- Tables: skill match rates, avg time per state
- Synthetic seed script (`seed:analytics`) for 80-referral demo dataset
- **Prerequisite:** PRD-14 Phase 1 (event log)

**Status:** 🔧 In Progress (2026-04-11)  
**Module:** `analytics/`, `views/`

---

### 15. **[[PRD-15 - Analytics Agent AI|PRD-15: Analytics Agent AI — Proactive Workflow Intelligence]]** 📋
**UI-triggered AI agent** that identifies anomaly clusters in the event log, retrieves the full referral and prior auth documents for each cluster, and uses Claude to surface root causes and actionable recommendations.

- Four anomaly types: denial cluster, PA denial pattern, no-show cluster, pending-info cluster
- Full document context: clinical data JSON, PA service codes, payer denial reasons, review actions
- Claude-powered pattern analysis (top 3 anomalies, `claude-sonnet-4-6`)
- Four recommendation types: skill rule update, referrer education, scheduling protocol, payer documentation requirement
- "Run Analysis" button in analytics filter bar; findings panel with per-anomaly cards
- **Prerequisite:** PRD-14 Phase 2 (event log + dashboard), [[Feature - Full Demo Seed Expansion (100 Scenarios)]] (sufficient cluster density)

**Status:** 📋 Ready for Dev (2026-04-12)  
**Module:** `analytics/`

---

### 16. **[[PRD-16 - 360X Referral Collaboration Workspace|PRD-16: 360X Referral Collaboration Workspace]]** 📋
**Epic.** Turns every recognized 360X referral into a persistent, accountable unit of collaborative work — owner, next action, conversation, documents, participants and a complete history — and makes the workspace itself the 360X enablement layer so neither party needs its own protocol implementation.

- Separate authoritative 360X status from Concord-local work status
- Referral workspace created automatically from a recognized 360X request
- Guest participation scoped to a single workspace; protocol artifacts rendered on a party's behalf
- Parent of PRD-17 through PRD-30; not directly implementable
- **Prerequisite:** None (children have their own)

**Status:** 📋 Drafting (2026-09-14)
**Module:** `workspace/`

---

#### Phase 1 — Foundation

### 17. **[[PRD-17 - Identity & Acting User|PRD-17: Identity & Acting User Model]]** 📋
**The smallest identity layer that unblocks collaboration.** No users table or auth exists today — `referrals.clinician_id` is a free-text input.

- `users` table seeded with demo coordinators, clinicians, schedulers and managers
- Acting-user selector in the shared nav, persisted in a cookie; no passwords
- `user:<id>` added to the audit actor vocabulary without breaking analytics parsing
- **Prerequisite:** None

**Status:** ✅ Shipped (PR #13, merged 2026-09-14). Doc at v1.2 — `active` exposed on `ActingUser` for PRD-21.
**Module:** `workspace/`

---

### 18. **[[PRD-18 - Workspace Entity & Dual Status|PRD-18: Workspace Entity & Dual Status Model]]** 📋
**The structural foundation.** One workspace row per referral, plus a second status dimension that cannot touch the protocol state.

- `referral_workspaces` table: work status, owner, queue, next action, due date, correlation ids
- `workStatusMachine.ts` following the existing six-export state-machine pattern
- Protocol→work status mapping is advisory; a manually set work status is never overwritten
- `Closed-Confirmed` resolves in Phase 1; `Follow-up-Required` becomes derivable once PRD-28 and
  PRD-22 supply a real open-item source (corrected in v1.2 — the original rule made every closed
  referral look like it needed follow-up)
- **Prerequisite:** PRD-17

**Status:** ✅ Shipped (PR #14, merged 2026-09-14). Doc at v1.2 — closure rule, backfill and proposal ordering corrected after running against real data.
**Module:** `workspace/`, `state/`

---

#### Phase 2 — Workspace surface & cross-party enablement

### 19. **[[PRD-19 - Workspace Shell|PRD-19: Workspace Shell]]** 📋
**The page.** A new `/workspaces/:id` surface; `/referrals/:id/review` stays the clinical disposition screen.

- Header: patient, reason, organizations, owner, due date, next action, two distinct status badges
- Reuses the journey timeline, embedded message thread and C-CDA viewer already built
- Labelled placeholder slots so PRD-21…29 each land as one self-contained panel
- Adds a minimal flat index at `/workspaces` so the page is reachable before PRD-20's queue view
- **Prerequisite:** PRD-18

**Status:** ✅ Shipped (PR #15, merged 2026-09-14; viewer and header fixes in PR #16). Doc at v1.1.
**Module:** `workspace/`, `views/`

---

### 21. **[[PRD-21 - Ownership & Assignment|PRD-21: Ownership & Assignment]]** 📋
**Who owns the next action.** One accountable owner per workspace, or an explicitly visible unassigned state.

- Assign, reassign, claim and release, each with a from→to audit event
- "My work" as a filter on `/workspaces`, resolving the acting user server-side — not a new page
- A losing concurrent claim fails cleanly via a conditional update, writing and emitting nothing
- `referrals.clinician_id` stays the disposition record, not the owner
- Ships the PRD-17 v1.2 `active` amendment it depends on
- **Prerequisite:** PRD-17 (incl. v1.2), PRD-19

**Status:** ✅ Shipped (2026-09-15). Doc at v1.2.
**Module:** `workspace/`

---

### 24. **[[PRD-24 - Parties & Participants|PRD-24: Parties & Participants]]** 📋
**Who is involved on each side** — and the prerequisite for guest access and the protocol gateway.

- `workspace_parties`: organization, canonical intake Direct address, party role, protocol mode
- `party_addresses`: every address observed from a party, so one org's several addresses resolve to one
- `workspace_participants`: internal staff as Manager / Collaborator / Viewer
- Protocol mode resolution: `native-360x`, `workspace-mediated`, `local-only`
- A party is never a user; the two models stay structurally separate
- Settles the Direct address cardinality question the epic left open for PRD-24/29/30
- **Prerequisite:** PRD-19

**Status:** ✅ Shipped (2026-09-15). Doc at v1.1.
**Module:** `workspace/`

---

### 30. **[[PRD-30 - Guest Participation|PRD-30: Guest Participation & Secure Invitations]]** 📋
**The other side of the referral, invited in.** Scoped, expiring, revocable access to one workspace.

- Tokenized invitations following the SFT limited-sender/recipient pattern; no passwords
- A guest sees the header, protocol timeline, shared comments and shared documents — nothing else
- Guests can comment, upload and make the assertions their party role permits
- Every guest action and every guest document view audited
- **Prerequisite:** PRD-24

**Status:** 📋 Ready for Dev — Phase 2a (refined 2026-09-15, v1.1)
**Module:** `workspace/`

---

### 29. **[[PRD-29 - 360X Protocol Gateway|PRD-29: 360X Protocol Gateway & Context Authoring]]** 📋
**The central bet.** The workspace supplies the protocol, so neither party has to implement 360X — a party brings only a Direct address.

- Any participant attaches 360X context to a message or document; the gateway renders the artifact
- Uses the existing RRI, SIU, C-CDA and MDN builders — no new message-building code
- Always records, conditionally transmits: `local-only` artifacts still advance state locally
- Transport identity: Mode A address-on-file by default, Mode B delegated mailbox as the upgrade
- **Prerequisite:** PRD-24 (PRD-30 for the guest half)

**Status:** 📋 Drafting
**Module:** `workspace/`

---

#### Phase 3 — Collaboration artifacts

### 22. **[[PRD-22 - Referral Conversation|PRD-22: Referral Conversation (Dual-Visibility)]]** 📋
**One conversation attached to the referral**, carrying internal notes and shared messages in one thread.

- Per-comment `Internal` / `Shared` visibility; internal is the default, sharing needs confirmation
- Internal comments are structurally absent from the guest payload, not filtered out of it
- Edits are versioned, deletions are tombstoned, nothing is hard-deleted
- **Prerequisite:** PRD-19, PRD-24

**Status:** 📋 Drafting
**Module:** `workspace/`

---

### 23. **[[PRD-23 - Document Collection|PRD-23: Referral Document Collection]]** 📋
**Everything clinical on a referral in one list** — as an index over content that already exists, not a second copy.

- `workspace_documents` referencing `raw_ccda_xml`, `referral_messages`, `attachment_responses`, uploads
- Type, source, sender, received date, protocol relationship, visibility
- Delivery evidence and human access evidence kept as two distinct facts
- Upload never transmits; sending requires attaching 360X context
- **Prerequisite:** PRD-19, PRD-24

**Status:** 📋 Drafting
**Module:** `workspace/`

---

### 25. **[[PRD-25 - Activity History & Audit|PRD-25: Unified Activity History & Audit]]** 📋
**The first per-referral reader of the PRD-14 event log**, which has only ever been aggregated.

- Merged feed: system events, user actions, guest actions, comments, documents, delivery receipts
- Closes real audit gaps — routing changes and disposition overrides emit nothing today
- Routes the two existing state-machine bypasses through `transition()`
- Answers the open question: which receipts prove delivery versus human access
- **Prerequisite:** PRD-14 Phase 1, PRD-19

**Status:** 📋 Drafting
**Module:** `workspace/`, `analytics/`

---

#### Phase 4 — Operational layer

### 20. **[[PRD-20 - Shared Queues & Queue View|PRD-20: Shared Queues & Referral Queue View]]** 📋
**Queues as a real entity**, with membership as the least-privilege PHI boundary.

- `queues` + `queue_members`; a user sees the queues they belong to, not every patient
- Open / Waiting / Exception / Completed tabs with server-side filtering and saved filters
- Auto-routing from the PRD-13 department classification, with a default triage queue
- **Prerequisite:** PRD-13, PRD-18

**Status:** 📋 Drafting
**Module:** `workspace/`, `views/`

---

### 26. **[[PRD-26 - Next Action & Due Dates|PRD-26: Next Action & Due Dates]]** 📋
**What to do next, by when, and who owes the move.**

- Config-driven next action and due-date offset per (protocol state × work status)
- "Awaited by us / a named party / nobody", derived from state and outbound ack status
- Finally connects `prd07/overdueChecker.ts`, which nothing calls today, and generalizes it to workspaces
- **Prerequisite:** PRD-18, PRD-24

**Status:** 📋 Drafting
**Module:** `workspace/`

---

### 27. **[[PRD-27 - Notifications|PRD-27: Notifications]]** 📋
**Telling people things** — there is no notification infrastructure of any kind today.

- The seven triggers from the source document, plus guest invitation and guest activity
- Recipients resolved from owner, participants and mentions; one `notify()` funnel
- Guest-eligible types are allow-listed, so a new internal type is invisible to guests by default
- Email carries a link and no clinical content
- **Prerequisite:** PRD-24, and each trigger's own PRD

**Status:** 📋 Drafting
**Module:** `workspace/`

---

### 28. **[[PRD-28 - Correlation & Exception Queue|PRD-28: Correlation, Reconciliation & Exception Queue]]** 📋
**Stop losing messages.** Unmatched ACKs are dropped today, auto-declines write no row, patients are never deduped.

- `processed_messages` table replacing the `.processed_messages.json` file
- Every silent failure becomes a visible, workable exception retaining the raw artifact
- Manual reassociation with full audit — and never an automatic protocol replay
- Duplicate patients flagged for a human, never auto-merged
- **Prerequisite:** PRD-18, PRD-20, PRD-29

**Status:** 📋 Drafting
**Module:** `workspace/`, `prd01/`

---

## Quick Reference

| PRD | Name | Status | Key Action | Module |
|-----|------|--------|-----------|--------|
| [[PRD-01 - Receive & Acknowledge\|01]] | Receive & Acknowledge | ✅ | Parse C-CDA, send MDN | `prd01/` |
| [[PRD-02 - Process & Disposition\|02]] | Process & Disposition | ✅ | Validate, clinician decides | `prd02/` |
| [[PRD-03 - Schedule Patient\|03]] | Schedule Patient | ✅ | Assign appointment, send SIU | `prd03/` |
| [[PRD-04 - Generate Consult Note\|04]] | Generate Consult Note | ✅ | Extract notes, send C-CDA | `prd04/` |
| [[PRD-05 - Patient Encounter\|05]] | Patient Encounter | ✅ | Send ADT, update state | `prd05/` |
| [[PRD-06 - Close Loop\|06]] | Close Loop | ✅ | Acknowledge final report | `prd06/` |
| [[PRD-07 - Ack Tracking\|07]] | Ack Tracking | ✅ | Monitor & retry messages | `prd07/` |
| [[PRD-11 - No-Show & Consult States\|11]] | No-Show & Consult States | ✅ | No-show notify + consult confirmation | `prd11/` |
| [[PRD-12 - Prior Authorization\|12]] | Prior Authorization (PAS) | ✅ | FHIR PA submit, payer decisions | `prd12/` |
| [[PRD-13 - Department Classification\|13]] | Department Classification | 🔧 | Route to dept, surface equipment | `prd02/` |
| [[PRD-14 - Analytics Agent (Phase 1)\|14]] | Analytics Agent (Phase 1) | ✅ | Event log, indexes, emission | `analytics/` |
| [[PRD-14 - Analytics Agent (Phase 2)\|14b]] | Analytics Agent (Phase 2) | 🔧 | SQL dashboard, KPI charts, seed data | `analytics/` |
| [[PRD-15 - Analytics Agent AI\|15]] | Analytics Agent AI | 📋 | Anomaly detection, Claude pattern analysis, findings UI | `analytics/` |
| [[PRD-16 - 360X Referral Collaboration Workspace\|16]] | 360X Collaboration Workspace (Epic) | 📋 | Persistent referral workspace; 360X enablement layer | `workspace/` |
| [[PRD-17 - Identity & Acting User\|17]] | Identity & Acting User | ✅ | Users table, acting-user picker, `user:<id>` actors | `workspace/` |
| [[PRD-18 - Workspace Entity & Dual Status\|18]] | Workspace Entity & Dual Status | ✅ | Workspace row, work status machine, closure conflict | `workspace/`, `state/` |
| [[PRD-19 - Workspace Shell\|19]] | Workspace Shell | ✅ | `/workspaces/:id`, header, dual badges, panel slots | `workspace/`, `views/` |
| [[PRD-20 - Shared Queues & Queue View\|20]] | Shared Queues & Queue View | 📋 | Queue entity, membership scope, four-tab queue view | `workspace/`, `views/` |
| [[PRD-21 - Ownership & Assignment\|21]] | Ownership & Assignment | ✅ | Claim, assign, release, My work, audited | `workspace/` |
| [[PRD-22 - Referral Conversation\|22]] | Referral Conversation | 📋 | One thread, Internal/Shared visibility, versioned | `workspace/` |
| [[PRD-23 - Document Collection\|23]] | Document Collection | 📋 | Index over existing artifacts, delivery + access evidence | `workspace/` |
| [[PRD-24 - Parties & Participants\|24]] | Parties & Participants | ✅ | Organizations + Direct address + protocol mode; internal roles | `workspace/` |
| [[PRD-25 - Activity History & Audit\|25]] | Activity History & Audit | 📋 | Per-referral event reader, merged feed, gaps closed | `workspace/`, `analytics/` |
| [[PRD-26 - Next Action & Due Dates\|26]] | Next Action & Due Dates | 📋 | Config-driven actions, awaited-by, overdue sweep | `workspace/` |
| [[PRD-27 - Notifications\|27]] | Notifications | 📋 | Nine triggers, one funnel, guest allow list | `workspace/` |
| [[PRD-28 - Correlation & Exception Queue\|28]] | Correlation & Exception Queue | 📋 | Idempotent intake, exceptions, manual reassociation | `workspace/`, `prd01/` |
| [[PRD-29 - 360X Protocol Gateway\|29]] | 360X Protocol Gateway | 📋 | Context authoring, artifact rendering, record-then-transmit | `workspace/` |
| [[PRD-30 - Guest Participation\|30]] | Guest Participation | 📋 | Scoped invitations, guest view, audited external access | `workspace/` |

---

## Feature Dependencies

```mermaid
PRD-01 (Receive)
    ↓
PRD-02 (Disposition)
    ↓
PRD-03 (Schedule)
    ├── → PRD-05 (Encounter)
    └── → PRD-04 (Consult Note)
            ↓
        PRD-06 (Close Loop)

PRD-07 (Ack Tracking) ← Horizontal feature, monitors all outbound messages
```

### Collaboration Workspace Epic (PRD-16)

```mermaid
Phase 1  PRD-17 (Identity) ──┬───────────────────────────────┐
         PRD-18 (Workspace + Dual Status) ──┐                │
                                            ▼                │
Phase 2  PRD-19 (Shell) ──► PRD-21 (Ownership)               │
                       └──► PRD-24 (Parties & Participants) ◄─┘
                                    ├──► PRD-30 (Guest Participation)
                                    └──► PRD-29 (Protocol Gateway) ◄── PRD-30

Phase 3  PRD-22 (Conversation) ──┐
         PRD-23 (Documents) ─────┼──► PRD-25 (Activity & Audit)
                                 └────┘  (PRD-29 artifacts feed both)

Phase 4  PRD-20 (Queues) · PRD-26 (SLA) · PRD-27 (Notifications) · PRD-28 (Reconciliation)
```

---

## Features

| Feature | Description | Status |
|---------|-------------|--------|
| [[Feature - Human-Readable Email Summaries]] | Plain-text summaries in outbound emails | ✅ Complete |
| [[Feature - Human-Readable Message Type Labels]] | Friendly labels for message types in UI | ✅ Complete |
| [[Feature - Demo Launcher Message Preview]] | C-CDA viewer + envelope preview on demo launcher | ✅ Complete |
| [[Feature - No-Show & Consult Demo Scenarios]] | Demo scenarios for No-Show and Consult state paths | 🔧 Ready for Dev |
| [[Feature - Full Demo Seed Expansion (100 Scenarios)]] | Expand seed-full-demo.ts to 100 scenarios with concentrated anomaly patterns | 📋 Ready for Dev |

---

## See Also

- [[🎯 PROJECT OVERVIEW|Project Overview]]
- [[../Architecture/360X Workflow Overview|Workflow Overview]]
- [[../Architecture/Technical Architecture|Technical Architecture]]
- [[../Backlog & Ideas/Ideas|Ideas & Future Features]]
