# PRD-06: Acknowledge Final Report and Close Loop

**Status:** Drafting
**Team:** Data Ingestion & Processing

---

### Context

This PRD defines the final, reciprocal step in the 360X workflow. After the receiving provider has sent the final Consult Note C-CDA (`PRD-04`), the referring provider's system is expected to acknowledge its receipt. This acknowledgment is typically an `HL7 V2 General Acknowledgment (ACK)` message.

For the PoC happy path demo, a **Mock Referring Provider** script handles the entire referring provider side of the conversation. It listens for all inbound messages (`RRI^I12`, `SIU^S12`, and the final Consult Note C-CDA) and automatically sends back a valid `ACK` for each one. Without this, the referral loop can never fully close in the demo and PRD-07 acknowledgment tracking would always show `Pending`.

Receiving and processing these `ACK` messages allows our system to definitively confirm the loop has been successfully closed from end to end, completing the audit trail.

### Goal

The primary goal of this feature is to enable the system to:

1.  Listen for and receive inbound messages from the referring provider after the final report has been sent.
2.  Correctly parse and identify an `HL7 V2 ACK` message.
3.  Correlate the `ACK` message back to the original referral.
4.  Update the internal state of the referral to a final, confirmed closed status.

### User Stories

- As a **Mock Referring Provider**, I want to automatically send an `ACK` for every inbound message (`RRI^I12`, `SIU^S12`, Consult Note) so that the full happy path demo can complete without manual intervention on the referring side.
- As a **System**, I want to listen for messages even after I have sent the final consult note, so that I can receive the referrer's final acknowledgment.
- As a **System**, I want to parse an incoming `HL7 V2 ACK` message to confirm receipt of the consult note.
- As a **System**, I want to update the referral's status to a terminal "Confirmed Closed" state, so that I have a complete and auditable record of the entire workflow.

### Acceptance Criteria

- **AC1:** The system's inbound listener (from `PRD-01`) must remain active to receive messages for referrals in a `Closed` state.
- **AC2:** The system must be able to parse a standard `HL7 V2 ACK` message.
- **AC3:** The system must successfully extract the `Message Control ID` from the `MSA` segment of the `ACK` message to correlate it with the `MSH-10` (Message Control ID) of the outbound consult note message.
- **AC4:** Upon successful correlation, the internal state of the referral must transition from `Closed` to `Closed-Confirmed`.
- **AC5:** If a message is received that is *not* a valid `ACK` for the referral, it should be logged as an unexpected message without changing the referral's state.

---

### Technical Specifications

**Dependencies:**
-   **HL7 V2 Parser:** **`hl7`** (npm, Node.js/TypeScript) for parsing `ACK` messages.
-   **State Management:** A Node.js state machine to manage the state transition.
-   **Message Correlation Store:** A database table to map the `Message Control ID` of outbound messages to the internal referral ID, so that the incoming `ACK` can be routed correctly.

**Engineering Constraints:**
-   The system must use the existing **Mock Direct Gateway** to receive the inbound `ACK` message.
-   The state machine must be updated to include a final, terminal state: `Closed-Confirmed`.

**Test Plan:**
-   Unit tests for parsing a sample `HL7 V2 ACK` message.
-   Unit test to verify the `Message Control ID` correlation logic.
-   Integration test for the complete workflow:
    1.  System sends a Consult Note (from `PRD-04`).
    2.  A mock `ACK` message is sent to the inbound listener.
    3.  System correctly parses the `ACK`.
    4.  The referral's status is confirmed to be `Closed-Confirmed` in the system's state.

**Deliverables:**
-   A Mock Referring Provider script (`mockReferrer.ts`) that listens for all inbound messages and automatically responds with a valid `ACK` for each.
-   An update to the inbound message processing logic to handle `ACK` messages.
-   A `Closed-Confirmed` terminal state added to the state machine.
-   A mechanism to store and retrieve `Message Control ID`s for correlation (the `outbound_messages` table defined in the PRD-02 prerequisite schema).
