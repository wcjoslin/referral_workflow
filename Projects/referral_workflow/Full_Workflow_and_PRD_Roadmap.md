# Full 360x Referral Workflow and PRD Roadmap

This document provides a comprehensive overview of the end-to-end 360x closed-loop referral workflow, detailing the interactions between the referring provider, the receiving provider, and the agentic AI orchestrating the process. It also maps each step of the workflow to the corresponding Product Requirements Document (PRD) that will guide its development.

---

## Workflow Actors

*   **Referring Provider:** The system (e.g., an EHR) that initiates the referral.
*   **Receiving Provider:** The system at the specialist's office that receives and processes the referral. This is the system we are building.
*   **Agentic AI Orchestrator:** The "brain" of the receiving system. It parses documents, manages state, and triggers actions.

---

## End-to-End Workflow Diagram & PRD Alignment

| Step | Action | Referring Provider | Agentic AI Orchestrator | Receiving Provider (System) | Relevant PRD(s) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **Initiate Referral** | Sends Referral C-CDA via Direct Secure Message. | - | Ingests inbound message. | `PRD-01` |
| **2** | **Acknowledge Receipt** | Receives MDN acknowledgment. | Triggers MDN send-back. | Sends MDN to confirm message delivery. | `PRD-01` |
| **3** | **Process & Disposition** | Receives `RRI` (Accept/Decline) message. | 1. Parses C-CDA.<br>2. Validates for completeness (auto-decline if incomplete).<br>3. Presents valid referrals to clinician for decision.<br>4. Generates `RRI` message based on decision. | Sends `RRI^I12` message with disposition status. | `PRD-02` |
| **4** | **Track Disposition Ack** | Sends `ACK` for the `RRI` message. | Parses `ACK` and correlates it to the sent `RRI`. | Updates `RRI` message status to "Acknowledged". | `PRD-07` |
| **5** | **Schedule Appointment** | Receives `SIU` (Scheduled) message. | If referral was accepted, presents patient to scheduler. After scheduling, generates `SIU` message. | Sends `SIU^S12` message with appointment details. | `PRD-03` |
| **6** | **Track Schedule Ack** | Sends `ACK` for the `SIU` message. | Parses `ACK` and correlates it to the sent `SIU`. | Updates `SIU` message status to "Acknowledged". | `PRD-07` |
| **7** | **Patient Encounter** | (Optionally) receives an interim update message. | Marks patient as "Encounter Complete". Can trigger an optional interim update message. | (Optionally) sends a simple Direct message with an interim status. | `PRD-05` |
| **8** | **Generate Consult Note** | Receives final Consult Note C-CDA. | 1. Detects clinician has signed the final note.<br>2. Extracts clinical summary.<br>3. Generates a valid Consult Note C-CDA.<br>4. Packages C-CDA for sending. | Sends Consult Note C-CDA via Direct Secure Message. | `PRD-04` |
| **9** | **Final Acknowledgment** | Sends final `ACK` to confirm receipt of the Consult Note. | Parses `ACK` and correlates it to the sent Consult Note. | Updates internal referral state to `Closed-Confirmed`. | `PRD-06` |
| **10** | **Monitor Acks** | - | A background job periodically checks for messages that have not been acknowledged within a defined timeframe. | A dashboard/view shows the acknowledgment status for all outbound messages. | `PRD-07` |

---

## Happy Path Demo Strategy

A core goal of this PoC is to demonstrate the **full automated 360X workflow** end-to-end. To achieve this without requiring real EHR systems, the following mock scripts simulate the automated triggers that would exist in a production environment. Each has a corresponding manual UI fallback for isolated testing.

| Mock Script | Replaces | Triggers |
| :--- | :--- | :--- |
| `mockReferrer.ts` | Referring provider's EHR system | Sends the initial referral C-CDA; auto-ACKs all inbound messages (`RRI`, `SIU`, Consult Note) |
| `mockScheduler.ts` | Internal scheduling module | Auto-assigns an appointment slot when referral reaches `Accepted` |
| `mockEncounter.ts` | EHR encounter/ADT system | Sends `ADT^A04` after appointment time elapses, triggering `Encounter` state |
| `mockEhr.ts` | Clinician's EHR note-signing event | Sends `ORU^R01` with clinical note text, triggering Consult Note generation |

With all four scripts running, the only required human action in the happy path demo is the **clinician's Accept/Decline decision** in PRD-02 — intentionally kept manual to demonstrate the clinical judgment step.

---

## PRD Development Roadmap

This table illustrates the logical order in which the PRDs can be developed to build the complete workflow incrementally.

1.  **`PRD-01: Receive and Acknowledge Referral`**: The foundational step. You must be able to receive and acknowledge a referral before any other processing can happen.

> **Engineering Prerequisite before coding PRD-02:** A persistence layer must be in place before any further PRD development begins. PRD-01 is intentionally stateless (in-memory), but PRD-02 requires storing referral records for the clinician UI, and every subsequent PRD reads from and writes to persistent state. See the "Prerequisite for PRD-02" section in `ENGINEERING-PRD-01.md` for the database decision and initial schema.

2.  **`PRD-02: Process and Disposition Referral`**: The core logic of the referral process. This determines if a patient can even be seen.
3.  **`PRD-03: Schedule Patient and Notify Referrer`**: The logical next step for any accepted referral.
4.  **`PRD-04: Generate and Send Final Consult Note`**: This is the primary goal of the workflow—sending the final report back to the referrer.
5.  **`PRD-05: Patient Encounter and Interim Updates`**: Fills the gap between scheduling and the final note, adding more detail to the patient journey.
6.  **`PRD-06: Acknowledge Final Report and Close Loop`**: Implements the final handshake, allowing the system to definitively confirm the loop is closed.
7.  **`PRD-07: Referrer-Side Acknowledgment Tracking`**: A "horizontal" feature that enhances the robustness of the entire system. It can be developed in parallel with the other PRDs or implemented after the core workflow is established to add a layer of auditing and error tracking.
