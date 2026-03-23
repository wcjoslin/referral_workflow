# PRD-05: Patient Encounter and Interim Updates

**Status:** Drafting
**Team:** Clinical Workflow & Integration Team

---

### Context

This PRD addresses the workflow between the patient being scheduled (`PRD-03`) and the final consult note being generated (`PRD-04`). While not always required by the 360X standard, providing interim updates can be critical for complex or long-running referral cases.

For the PoC happy path demo, encounter completion is handled by a **Mock Encounter Trigger** — a script that automatically fires an `HL7 V2 ADT^A04` (Patient Arrived/Encounter) event after a configurable delay from the scheduled appointment time. This transitions the referral to `Encounter` state without requiring a manual UI action, keeping the happy path fully automated.

A manual "Mark Encounter Complete" UI action is also provided for isolated testing.

### Goal

The primary goal of this feature is to define the workflow and system actions required to:

1.  Track the status of a patient encounter after they have been scheduled.
2.  Provide a mechanism for a clinician or system agent to record that an encounter has occurred.
3.  Optionally, generate and transmit a notification to the referring provider to indicate that the patient has been seen or that the referral is still in progress.
4.  Update the internal state of the referral to `Encounter`, signifying the patient has been seen at least once.

### User Stories

- As a **Mock Encounter Trigger**, I want to automatically fire an `ADT^A04` event after the scheduled appointment time elapses so that the happy path demo transitions to `Encounter` state without a manual step.
- As a **Clinician**, I want to manually mark that a scheduled appointment has been completed via the UI so the system knows the patient was seen (fallback for isolated testing).
- As a **System**, I want to track that an encounter has taken place to provide a more accurate status for long-running referrals.
- As a **System**, I want to have the ability to send an "interim update" to the referring provider, such as "Patient seen, tests pending," so they are aware of the ongoing process.

### Acceptance Criteria

- **AC1:** The system must listen for an inbound `ADT^A04` event from the Mock Encounter Trigger and automatically transition the referral from `Scheduled` to `Encounter`. A manual "Mark Encounter Complete" UI action must also be available as a fallback.
- **AC2:** Upon marking the encounter as complete, the referral's internal state must transition from `Scheduled` to `Encounter`.
- **AC3:** The system shall provide an optional feature to generate and send a simple `Direct Secure Message` to the original referring provider.
- **AC4:** This interim message should contain a simple, clear status, such as "Patient has been seen for their initial consultation on [Date]. A final report will follow upon completion of all tests."
- **AC5:** The transmission of this interim message must be logged against the referral record.

---

### Technical Specifications

**Dependencies:**
-   **State Management:** A Node.js state machine to manage the referral's state lifecycle.
-   **Mock Direct Gateway:** The existing mock gateway for sending messages.

**Engineering Constraints:**
-   The interim update does not need to be a formal HL7 or C-CDA document. For this PRD, a simple, text-based `Direct Secure Message` is sufficient.
-   The application's state machine must be updated to include an `Encounter` state, representing a transition from the `Scheduled` state. This state indicates that the patient has been seen, and the system is now awaiting a final note to be signed (`PRD-04`).

**Test Plan:**
-   Unit tests to verify the state transition from `Scheduled` to `Encounter`.
-   Integration test to verify that the optional "Send Interim Update" action correctly generates and transmits a message via the mock gateway.
-   Verify that the referral's history log correctly reflects that an encounter occurred and an interim message was sent.

**Deliverables:**
-   A Mock Encounter Trigger script (`mockEncounter.ts`) that sends an `ADT^A04` event after a configurable delay from the appointment time.
-   An `ADT^A04` listener that processes the encounter event and triggers the state transition.
-   A manual "Mark Encounter Complete" UI action (fallback).
-   A module to construct and send the optional interim `Direct Secure Message`.
-   A state machine update to handle the `Scheduled` → `Encounter` transition.
