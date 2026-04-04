---
title: Technical Architecture
tags: [architecture, technical, design]
up: "[[🎯 PROJECT OVERVIEW]]"
---

# Technical Architecture

Extracted from [[Referral_Workflow_Overview|Full_Workflow_and_PRD_Roadmap.md]]

## End-to-End Workflow Diagram & PRD Alignment

| Step | Action | Referring Provider | Agentic AI Orchestrator | Receiving Provider (System) | Relevant PRD(s) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **Initiate Referral** | Sends Referral C-CDA via Direct Secure Message. | - | Ingests inbound message. | [[PRD-01 - Receive & Acknowledge]] |
| **2** | **Acknowledge Receipt** | Receives MDN acknowledgment. | Triggers MDN send-back. | Sends MDN to confirm message delivery. | [[PRD-01 - Receive & Acknowledge]] |
| **3** | **Process & Disposition** | Receives `RRI` (Accept/Decline) message. | 1. Parses C-CDA.<br>2. Validates for completeness (auto-decline if incomplete).<br>3. Presents valid referrals to clinician for decision.<br>4. Generates `RRI` message based on decision. | Sends `RRI^I12` message with disposition status. | [[PRD-02 - Process & Disposition]] |
| **4** | **Track Disposition Ack** | Sends `ACK` for the `RRI` message. | Parses `ACK` and correlates it to the sent `RRI`. | Updates `RRI` message status to "Acknowledged". | [[PRD-07 - Ack Tracking]] |
| **5** | **Schedule Appointment** | Receives `SIU` (Scheduled) message. | If referral was accepted, presents patient to scheduler. After scheduling, generates `SIU` message. | Sends `SIU^S12` message with appointment details. | [[PRD-03 - Schedule Patient]] |
| **6** | **Track Schedule Ack** | Sends `ACK` for the `SIU` message. | Parses `ACK` and correlates it to the sent `SIU`. | Updates `SIU` message status to "Acknowledged". | [[PRD-07 - Ack Tracking]] |
| **7** | **Patient Encounter** | (Optionally) receives an interim update message. | Marks patient as "Encounter Complete". Can trigger an optional interim update message. | (Optionally) sends a simple Direct message with an interim status. | [[PRD-05 - Patient Encounter]] |
| **8** | **Generate Consult Note** | Receives final Consult Note C-CDA. | 1. Detects clinician has signed the final note.<br>2. Extracts clinical summary.<br>3. Generates a valid Consult Note C-CDA.<br>4. Packages C-CDA for sending. | Sends Consult Note C-CDA via Direct Secure Message. | [[PRD-04 - Generate Consult Note]] |
| **9** | **Final Acknowledgment** | Sends final `ACK` to confirm receipt of the Consult Note. | Parses `ACK` and correlates it to the sent Consult Note. | Updates internal referral state to `Closed-Confirmed`. | [[PRD-06 - Close Loop]] |
| **10** | **Monitor Acks** | - | A background job periodically checks for messages that have not been acknowledged within a defined timeframe. | A dashboard/view shows the acknowledgment status for all outbound messages. | [[PRD-07 - Ack Tracking]] |

---

## Happy Path Demo Strategy

A core goal of this PoC is to demonstrate the **full automated 360X workflow** end-to-end. To achieve this without requiring real EHR systems, the following mock scripts simulate the automated triggers that would exist in a production environment. Each has a corresponding manual UI fallback for isolated testing.

| Mock Script | Replaces | Triggers |
| :--- | :--- | :--- |
| `mockReferrer.ts` | Referring provider's EHR system | Sends the initial referral C-CDA; auto-ACKs all inbound messages (`RRI`, `SIU`, Consult Note) |
| `mockScheduler.ts` | Internal scheduling module | Auto-assigns an appointment slot when referral reaches `Accepted` |
| `mockEncounter.ts` | EHR encounter/ADT system | Sends `ADT^A04` after appointment time elapses, triggering `Encounter` state |
| `mockEhr.ts` | Clinician's EHR note-signing event | Sends `ORU^R01` with clinical note text, triggering Consult Note generation |

**With all four scripts running, the only required human action in the happy path demo is the clinician's Accept/Decline decision in PRD-02** — intentionally kept manual to demonstrate the clinical judgment step.

---

## State Machine Lifecycle

```
Received 
  ↓
Acknowledged 
  ↓
┌─────────────────────────────────────┐
│ Accepted | Declined | Pending-Info  │
└─────────────────────────────────────┘
  ↓ (if Accepted)
Scheduled
  ↓
Encounter
  ↓
Closed
  ↓
Closed-Confirmed
```

**Terminal States:** `Declined`, `Closed-Confirmed`

All state changes must go through the `transition()` function in [referralStateMachine.ts](../../src/state/referralStateMachine.ts).

---

## Key Components

- **Database:** SQLite + Drizzle ORM
- **State Machine:** Custom TypeScript (no external library)
- **Message Parsing:** HL7 V2 + C-CDA (BlueButton.js)
- **AI Reasoning:** Anthropic SDK (Claude)
- **Email Transport:** Nodemailer (SMTP) + Imapflow (IMAP)
- **UI:** Express.js with HTML

---

See [[🎯 PROJECT OVERVIEW|Project Overview]] for full details.
