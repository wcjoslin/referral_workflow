# PRD-04: Generate and Send Final Consult Note

**Status:** Drafting
**Team:** Clinical Data & Interoperability Team

---

### Context

This PRD addresses the final and most critical step in the 360X closed-loop referral process: sending the results of the patient encounter back to the original referring provider.

For the PoC, the trigger is a **mock `HL7 V2 ORU^R01` message** sent by a mock EHR script. This script simulates an EHR firing a "note signed" event after a clinician completes their documentation. The system runs an `ORU` listener that receives this message, extracts the clinical note text, and kicks off the C-CDA generation pipeline automatically — no manual UI step required on the happy path.

A manual "Sign & Send Consult Note" UI action is also provided as a developer convenience for testing individual steps in isolation.

The trigger layer is intentionally designed as a replaceable module. Swapping the mock `ORU^R01` script for a real EHR integration (live `ORU` listener or FHIR `DocumentReference` subscription) should require changes only to the trigger layer, not to the C-CDA generation or transmission logic downstream.

### Goal

The primary goal is to define an automated workflow for generating and transmitting a standards-compliant Consult Note C-CDA back to the referring provider. This includes:

1.  **Mock EHR Trigger (PoC):** A mock EHR script sends an `HL7 V2 ORU^R01` message containing a clinical note and the patient/referral identifiers. The system's `ORU` listener receives this message and automatically begins the closing process. A manual UI fallback also exists for isolated testing.
2.  **Extracting Content:** Claude (`@anthropic-ai/sdk`) parses the note text to extract and structure the relevant clinical summary.
3.  **Generating the C-CDA:** The structured summary is packaged into a valid Consult Note C-CDA document using `xmlbuilder2`.
4.  **Transmitting and Closing:** The C-CDA is sent via the mock Direct Secure Messaging gateway, and the referral's state is updated to `Closed`.

### User Stories

- As a **Mock EHR Script**, I want to send an `ORU^R01` message when a clinician signs their note so that the receiving system can automatically begin the closing process without a manual UI step.
- As a **Clinician**, I want a fallback "Sign & Send Consult Note" UI action so that I can manually trigger the closing process during development or when the automated trigger is unavailable.
- As a **System**, I want to take the clinician's free-text note and generate a standards-compliant Consult Note C-CDA so that the referring provider receives a structured, interoperable document.
- As a **System**, I want to ensure the generated Consult Note C-CDA is valid and correctly represents the clinician's summary so that the referring provider receives accurate information.

### Acceptance Criteria

- **AC1:** The system must run an `ORU^R01` listener that accepts inbound HL7 V2 messages from the mock EHR script, extracts the clinical note text and patient/referral identifiers, and automatically triggers the C-CDA generation pipeline. A manual UI fallback ("Sign & Send Consult Note") must also be available for isolated testing.
- **AC2:** Upon submission, Claude (`@anthropic-ai/sdk`) must successfully extract and structure the clinical text into the required sections of a Consult Note C-CDA (e.g., Assessment, Plan, Chief Complaint).
- **AC3:** The system shall generate a valid C-CDA document conforming to the "Consult Note" template, with the extracted text placed in the appropriate summary section.
- **AC4:** The generated C-CDA document shall be transmitted via the mock Direct Secure Messaging gateway back to the original referring provider.
- **AC5:** The internal state of the referral must transition from `Scheduled` to `Closed` upon successful transmission.

---

### Technical Specifications

**Dependencies:**
-   **ORU Listener:** A separate HL7 V2 listener service (distinct from the Direct inbox monitor) that receives `ORU^R01` messages from the mock EHR script on a configurable port/channel.
-   **C-CDA Generation:** An XML generation library (e.g., `xmlbuilder2`, Node.js/TypeScript) to construct the Consult Note C-CDA document.
-   **AI Reasoning:** **`@anthropic-ai/sdk`** — Claude is used to extract and structure the clinical summary text from the signed note into the appropriate C-CDA sections.
-   **State Management:** The custom TypeScript state machine module (`referralStateMachine.ts`) to transition the referral to `Closed`.

**Engineering Constraints:**
-   The system must use the existing **Mock Direct Gateway** for outbound messages.
-   The generated C-CDA must pass validation against standard C-CDA schemas for a Consult Note.
-   The trigger layer (manual UI input) must be implemented as a separate, replaceable module. The C-CDA generation and transmission logic must not be coupled to the trigger source, so that a future `HL7 V2 ORU` listener or FHIR subscription can be swapped in without rewriting downstream logic.

**Test Plan:**
-   Unit test for parsing an inbound `ORU^R01` message and extracting patient/referral identifiers and note text.
-   Unit tests for Claude's ability to extract and structure clinical summary text from sample free-text notes.
-   Unit tests for the generation of a valid Consult Note C-CDA from structured input.
-   Unit test to verify the C-CDA output passes schema validation.
-   Integration test for the full happy path: mock EHR script sends `ORU^R01` → system parses it → Claude structures the note → C-CDA generated and transmitted via mock gateway → referral state transitions to `Closed`.

**Deliverables:**
-   A mock EHR script (`mockEhr.ts`) that generates and sends a sample `ORU^R01` message for a given referral ID.
-   An `ORU^R01` listener service (separate from the Direct inbox monitor).
-   A "Sign & Send Consult Note" UI fallback component.
-   A trigger module (designed as a replaceable interface for production).
-   A Claude-powered module for extracting and structuring clinical text into C-CDA sections.
-   A module for generating and packaging the Consult Note C-CDA using `xmlbuilder2`.
-   A state machine update to handle the `Encounter` → `Closed` transition.
