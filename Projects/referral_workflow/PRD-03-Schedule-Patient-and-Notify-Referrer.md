# PRD-03: Schedule Patient and Notify Referrer

**Status:** Drafting
**Team:** Clinical Workflow & Integration Team

---

### Context

Following a successful "Accept" disposition in PRD-02, the patient is now in the receiving provider's system and needs to be scheduled for an appointment. This workflow is the critical "next step" that moves the patient from a waiting list to a confirmed visit.

For the PoC happy path demo, scheduling is handled by a **Mock Scheduling Service** — a script that automatically assigns an appointment slot (e.g., 7 days from acceptance) and sends a scheduling event to the system when a referral transitions to `Accepted`. This removes the manual scheduler step from the happy path while still allowing a human scheduler UI for isolated testing.

In a real deployment, this mock service would be replaced by an event emitted from the provider's scheduling module (e.g., an internal webhook or HL7 `SIU` inbound from an EHR scheduling system). The final step in both cases is to close the communication loop with the referring provider by transmitting an `SIU^S12` message.

### Goal

The primary goal of this feature is to define the workflow and system actions required to:

1.  Present a newly accepted referral to a scheduler for an appointment.
2.  Capture the details of the scheduled appointment (date, time, location, provider).
3.  Consider resource and equipment constraints during scheduling.
4.  Automatically generate and transmit an `HL7 V2 SIU^S12` (Appointment Scheduled) message to the original referring provider.
5.  Update the internal state of the referral to `Scheduled`.

### User Stories

- As a **Mock Scheduling Service**, I want to automatically assign an appointment slot when a referral is accepted so that the happy path demo can proceed without a manual scheduling step.
- As a **Scheduler**, I want to see a list of all accepted referrals awaiting scheduling so that I can manage my work queue when the automated service is not in use.
- As a **Scheduler**, I want to input the appointment details for a patient so that I can confirm their visit in the system via the UI fallback.
- As a **Scheduler**, I want the system to be aware of resource constraints (like equipment or room availability) so that I don't accidentally double-book a required asset.
- As a **System**, I want to automatically send an `SIU^S12` appointment notification to the referring provider so that they are kept informed of the patient's status.

### Acceptance Criteria

- **AC1:** When a referral transitions to `Accepted`, the Mock Scheduling Service must automatically assign an appointment (date, time, location, clinician) and trigger the scheduling workflow. A scheduler UI queue must also exist as a fallback for manual scheduling.
- **AC2:** The scheduler's UI must provide fields to enter the appointment date, time, location, and assigned clinician.
- **AC3:** The system shall flag any appointments that require equipment or resources that have their own separate calendar and are unavailable at the selected time.
- **AC4:** Upon saving the appointment details, the system must generate a valid `HL7 V2 SIU^S12` message.
- **AC5:** The `SIU^S12` message must be transmitted via the mock Direct Secure Messaging gateway.
- **AC6:** The internal state of the referral must transition from `Accepted` to `Scheduled`.

---

### Technical Specifications

**Dependencies:**
-   **HL7 V2 Library:** **`hl7`** (npm, Node.js/TypeScript) for generating `SIU^S12` messages.
-   **State Management:** A Node.js state machine to manage the referral's state lifecycle.
-   **C-CDA Parser (for UI context):** **`@kno2/bluebutton`** (Node.js/TypeScript) to display key patient info to the scheduler.
-   **Resource/Asset Schedules:** Access to calendars for key equipment or specialized rooms.

**Engineering Constraints:**
-   The system must use the existing **Mock Direct Gateway** (e.g., local SMTP server) to send the outbound `SIU^S12` message.
-   The application's state machine must be updated to include a `Scheduled` state, representing a transition from the `Accepted` state.

**Test Plan:**
-   Unit tests for the generation of a valid `SIU^S12` message, ensuring all required segments (e.g., MSH, SCH, PID) are correctly populated.
-   Unit tests to check for scheduling conflicts against a mock resource calendar.
-   Integration test to verify the complete workflow:
    1.  Scheduler saves an appointment.
    2.  System generates and sends the `SIU^S12` message via the mock gateway.
    3.  The referral's status is confirmed to be `Scheduled` in the system's state.

**Deliverables:**
-   A Mock Scheduling Service (`mockScheduler.ts`) that auto-assigns an appointment slot when a referral reaches `Accepted` state.
-   A "Scheduling" UI component for manual scheduling (fallback).
-   A module to construct and send the `HL7 V2 SIU^S12` message.
-   An update to the state machine to handle the `Accepted` → `Scheduled` transition.
-   A module for querying resource/asset availability.
