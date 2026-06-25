# 360X Closed Loop Referral — Healthcare Workflow Simulation

A production-grade simulation of the complete 360X closed-loop referral protocol, implementing authentic healthcare provider-to-provider workflows across HL7 V2, C-CDA, Direct Secure Messaging, FHIR, and X12 EDI standards. Built to explore how agentic AI can be layered onto deterministic clinical workflows without replacing clinician oversight.

---

## What This Is

The 360X protocol defines a state machine where a referring provider and a receiving specialist exchange structured messages until a referral is formally "closed" by a final consult report. This project implements the full lifecycle end-to-end — from initial C-CDA referral intake through prior authorization, scheduling, encounter, consult note generation, and ACK-based loop closure.

**Core thesis:** Healthcare workflow automation requires a hybrid architecture. Most steps are deterministic (state validation, message routing, standards compliance). A small number of steps require clinical reasoning — that's where AI is applied, surgically.

---

## Architecture

### State Machine

All referrals follow a strictly enforced lifecycle. No ad-hoc state updates — every transition runs through `referralStateMachine.ts`.

```
Received
  └─► Acknowledged
        ├─► Accepted ──────────────────────────────────────────────────────────────┐
        ├─► Declined (terminal)                                                    │
        └─► Pending-Information                                                    │
              ├─► Acknowledged (info received)                                     │
              └─► Declined (timeout, terminal)                                     │
                                                                                   ▼
                                                                              Scheduled
                                                                              ├─► Encounter
                                                                              │     ├─► Consult ─► Closed
                                                                              │     └─► Closed
                                                                              └─► No-Show ─► Scheduled
                                                                                        ↓
                                                                              Closed-Confirmed (terminal)
```

### AI Integration Points

AI is used in exactly three places, each chosen because deterministic logic is insufficient:

| Module | Model | Task |
|---|---|---|
| PRD-02 Disposition | Claude (Anthropic SDK) | Validates C-CDA clinical sufficiency — checks for required sections (medications, diagnoses, reason for referral) before accept/decline |
| PRD-04 Consult Note | Gemini 2.5-Flash | Extracts structured clinical findings from a signed ORU message to generate a C-CDA Consult Note |
| PRD-09 Skills Engine | Gemini 2.5-Flash (fallback) | Evaluates YAML-defined automation rules against referral data when deterministic scripts can't resolve |

All other workflow steps are deterministic TypeScript. No LangGraph, no CrewAI — custom state machine with direct API calls.

### Modular PRD Structure

Each workflow step is implemented as an isolated module under `src/modules/prd<N>/`. Each module has a trigger, a logic service, a message builder, and mock automation for demo purposes.

---

## Skills Engine (PRD-09)

The skills engine is a configurable, pluggable rules framework for automating referral disposition decisions. Skills are defined as YAML-frontmatter Markdown files and evaluated against live clinical data at defined trigger points.

**Trigger points:** `post-intake`, `post-acceptance`, `encounter-complete`

**Evaluation tiers:**
1. **Deterministic script** — TypeScript `check()` function runs first. If it resolves the decision, AI is never called. Confidence = 1.0.
2. **Gemini fallback** — If the script returns `resolved: false` (e.g., missing payer data), the full SKILL.md + clinical context + facility assets are passed to Gemini 2.5-Flash for evaluation.
3. **Confidence threshold + conflict resolution** — If multiple skills match, the most restrictive action wins (`auto-decline` > `request-info` > `flag-priority` > `auto-accept`). Matches below the skill's confidence threshold are downgraded to `flag-priority` for manual review.

**Example skill (`skills/in-network-accept/SKILL.md`):**
```yaml
---
name: in-network-accept
description: Auto-accept referrals where the patient's payer is in-network and the referral includes diagnosis codes
metadata:
  trigger-point: post-intake
  action-type: auto-accept
  confidence-threshold: 0.90
  priority: 10
  active: true
---
```

**Adding a new skill:** Drop a directory under `skills/` with a `SKILL.md`. Optionally add a `scripts/check-*.ts` for deterministic evaluation and `assets/*.json` for facility configuration. The skill watcher picks it up at runtime without a restart.

---

## Healthcare Standards Implemented

| Standard | Usage |
|---|---|
| **HL7 V2 REF^I12** | Inbound referral request |
| **HL7 V2 RRI^I12** | Accept/decline response |
| **HL7 V2 SIU^S12** | Appointment scheduling notification |
| **HL7 V2 ADT** | Patient encounter trigger |
| **HL7 V2 ORU** | Clinical results (EHR → consult note trigger) |
| **HL7 V2 ACK** | Loop closure acknowledgment |
| **C-CDA Referral Note** | Inbound referral document (parsed via `@kno2/bluebutton`) |
| **C-CDA Consult Note** | Outbound final report (generated via `xmlbuilder2`) |
| **Direct Secure Messaging** | Transport layer (SMTP/IMAP mock gateway; RFC 3798 MDN) |
| **FHIR R4** | Optional patient record enrichment (HAPI FHIR) |
| **X12 277** | Inbound payer claims attachment request |
| **X12 275** | Outbound claims attachment response |
| **LOINC** | Document type mapping for claims attachments |
| **ICD-10** | Diagnosis code validation in skills engine |

---

## Workflow Modules

### Core Referral Lifecycle

| Module | What it does |
|---|---|
| **PRD-01** | IMAP polling → C-CDA parsing → MDN delivery notification |
| **PRD-02** | Claude API validates clinical completeness → Accept/Decline via RRI |
| **PRD-03** | Calendar slot assignment → SIU scheduling notification |
| **PRD-04** | ORU triggers Gemini-based note extraction → C-CDA Consult Note generation |
| **PRD-05** | ADT parsing → Encounter state transition |
| **PRD-06** | ACK parsing → terminal state closure |
| **PRD-07** | Overdue ACK detection for referrer-side tracking |
| **PRD-08** | Optional HAPI FHIR enrichment — merges patient history into clinical data |
| **PRD-09** | YAML skills engine (see above) |
| **PRD-11** | No-show handling and specialist-initiated consult states |
| **PRD-12** | Prior authorization request/response workflow with mock payer API |

### Claims Attachment Workflow (CMS-0053-F)

Separate state machine (`Received → Signed → Sent`) that handles X12 EDI payer requests:

1. File watcher monitors `claims-inbox/` for inbound X12 277 EDI files
2. Parser extracts LOINC codes from the attachment request
3. FHIR patient lookup enriches the record
4. C-CDA documents generated per requested LOINC code
5. Clinician signs via Express UI
6. X12 275 response written to `claims-outbox/`

---

## Tech Stack

- **Runtime:** Node.js + TypeScript (strict mode)
- **Database:** SQLite + Drizzle ORM
- **UI:** Express + Bootstrap (clinician review interface)
- **AI:** Anthropic Claude SDK (PRD-02), Google Gemini 2.5-Flash (PRD-04, PRD-09)
- **HL7/CDA:** `hl7` npm package, `@kno2/bluebutton`, `xmlbuilder2`
- **EDI:** `node-x12`
- **Email:** `nodemailer` (SMTP) + `imapflow` (IMAP)
- **Testing:** Jest, >80% line/function coverage

---

## Getting Started

```bash
# Install dependencies
npm install

# Set up environment variables (see .env.example)
cp .env.example .env

# Run database migrations
npm run db:migrate

# Seed demo data
npm run seed

# Start the application
npm run dev
# → Express UI at localhost:3001
# → IMAP monitor polling for inbound referrals
# → Skills watcher monitoring skills/ directory
# → EDI watcher monitoring claims-inbox/
```

### Run the Full Demo

With `npm run dev` running:

1. Visit `localhost:3001` — see the clinician review queue
2. Mock scripts auto-trigger non-clinician workflow steps (scheduling, encounter, consult note, ACK)
3. Use the UI to manually accept/decline referrals (PRD-02) or override any step

### Seed Claims Demo

```bash
npm run seed:claims   # generates 4 X12 277 EDI files in claims-inbox/
# file watcher picks them up automatically
```

---

## Project Structure

```
src/
├── index.ts                    # Entry point (IMAP monitor, skills watcher, EDI watcher, server)
├── server.ts                   # Express server + clinician UI
├── config.ts                   # Centralized env-based config
├── state/
│   └── referralStateMachine.ts # Enforced state transitions
├── db/
│   └── schema.ts               # Drizzle schema (patients, referrals, skill_executions, claims)
└── modules/
    ├── prd01/ – prd12/         # One directory per workflow module
    └── claims/                 # X12 claims attachment workflow

skills/
├── in-network-accept/          # SKILL.md + check script + approved-payers.json
├── payer-network-check/
└── missing-icd-codes/

claims-inbox/                   # Drop X12 277 EDI files here
claims-outbox/                  # X12 275 responses written here
```

---

## Key Design Decisions

**No orchestration framework.** A custom TypeScript state machine enforces transitions rather than LangGraph or CrewAI. This keeps the workflow deterministic, auditable, and independently testable at each step.

**Deterministic-first AI.** Skills evaluate with TypeScript logic before touching Gemini. Claude validates C-CDA completeness rather than making disposition decisions — the clinician still accepts or declines.

**Clinician override at every step.** All AI outputs are stored as suggestions. The Express UI provides manual fallbacks for every automated step.

**Immutable audit trail.** All state transitions and skill evaluations are logged to `workflowEvents` and `skillExecutions` tables with actor, timestamp, and metadata.
