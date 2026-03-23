# PRD-02: Process and Disposition Referral

## 1. Overview

### 1.1. Context

This document outlines the second major workflow in the 360X Closed Loop Referral process: the processing and disposition of an inbound referral. After a referral has been successfully received and acknowledged (as described in PRD-01), the receiving provider's clinical team must review the referral package to determine if they can accept the patient.

This workflow focuses on parsing the clinical and administrative data from the inbound C-CDA document, presenting it to a clinician in a usable format, and capturing their decision to **accept** or **decline** the referral. This decision, or "disposition," is a critical step that dictates the next actions in the patient's care journey and the information that must be communicated back to the referring provider.

Some health centers will require other "optional" sections listed in the Referral C-CDA form, depending on what type of care the center can provide. So not only do they need completed sections, the information within it can also dictate whether a referral is accepted or denied.

### 1.2. Goal

This workflow aims to equip clinicians with the necessary information, extracted from the referral C-CDA, to make an informed disposition decision, and automatically decline a referral if the CCDA does not contain all required sections. The system will then generate and transmit the appropriate 360X-compliant message to inform the referring provider of the outcome.

The ultimate goal is to learn restrictions from clinician's output to automate the acceptance or rejection of referrals based on what clinicians decide. For the initial proof-of-concept, the primary check will be full field validation. A subsequent workflow will be designed to handle denials based on specific data within the C-CDA.

### 1.3. Scope

-   **In Scope:**
    -   Parsing detailed clinical and administrative sections from the inbound C-CDA Referral Note.
    -   Automatically declining a referral if the C-CDA does not contain all required sections.
    -   Creating a user interface (UI) for clinicians to review the parsed referral data for referrals that pass automatic validation.
    -   Providing functionality for the clinician to select "Accept" or "Decline" and document a reason.
    -   Generating an HL7 V2 RRI^I12 message to reflect the disposition decision (both manual and automatic).
    -   Sending the RRI^I12 message back to the referring provider via the mock Direct Secure Messaging gateway.
-   **Out of Scope:**
    -   Patient scheduling (covered in the next workflow).
    -   Advanced automation of the disposition decision based on *values* within clinical data (this is a future goal).
    -   Management of provider directories or insurance validation beyond what is present in the C-CDA.

## 2. User Stories & Acceptance Criteria

### 2.1. As a Clinician, I want to review a summary of a valid referral so that I can quickly understand the patient's case.

-   **AC1:** The system shall parse the following sections from the inbound C-CDA document:
    -   Patient Demographics
    -   Payer Information
    -   Reason for Referral
    -   Problems/Allergies/Medications
    -   Relevant Diagnostic Results
-   **AC2:** A dedicated "Referral Review" screen shall display the parsed information in a clean, human-readable format.
-   **AC3:** If any optional section of the C-CDA is missing or empty, it should be clearly flagged in the UI.

### 2.2. As a Clinician, I want to accept or decline the referral so that I can manage the patient queue.

-   **AC1:** The Referral Review screen must contain clear "Accept" and "Decline" action buttons.
-   **AC2:** If the clinician chooses to "Decline," they must be prompted to select a reason from a predefined list (e.g., "Out of Scope," "Insufficient Information," "Patient Unreachable") or enter a free-text reason.
-   **AC3:** Upon selecting a disposition, the system shall record the decision, the responsible clinician, and the timestamp.

### 2.3. As a System, I want to inform the referring provider of the disposition so that the referral loop is updated.

-   **AC1:** When a clinician accepts a referral, the system must generate an HL7 V2 RRI^I12 message with a status of "Accepted."
-   **AC2:** When a clinician declines a referral, the system must generate an HL7 V2 RRI^I12 message with a status of "Rejected" and include the reason for rejection.
-   **AC3:** The generated message shall be sent via the mock Direct Secure Messaging gateway back to the original sender.
-   **AC4:** The internal state of the referral must be updated from "Received" to "Accepted" or "Declined."

### 2.4. As a System, I want to automatically decline a referral if the C-CDA is incomplete, so that clinicians only spend time on viable referrals.
-   **AC1:** The system shall define a list of "required" C-CDA sections for a referral to be considered complete (e.g., Patient Demographics, Reason for Referral, Payer Information).
-   **AC2:** Upon receiving a referral, the system must validate the presence and completeness of all required C-CDA sections.
-   **AC3:** If one or more required sections are missing or empty, the system shall automatically trigger the "Decline" workflow.
-   **AC4:** The reason for the automatic declination shall be logged as "Incomplete C-CDA" or a similar clear, automated message.
-   **AC5:** An HL7 V2 RRI^I12 message with a "Rejected" status and the "Incomplete C-CDA" reason must be automatically generated and sent to the referring provider.

## 3. Technical Implementation Details

### 3.1. Data Parsing

-   The system will use the **`@kno2/bluebutton`** (Node.js/TypeScript) library to extract the required sections.
-   The parsing logic must be robust enough to handle variations in C-CDA structure from different EHRs.

### 3.2. Disposition Message (HL7 V2 RRI^I12)

-   The **Referral Result - Interactive (RRI^I12)** message is the standard for communicating a referral disposition in 360X.
-   The system will use the **`hl7`** (npm) library (Node.js/TypeScript) to construct the message.
-   **Key Segments:**
    -   **MSH:** Message Header
    -   **MSA:** Message Acknowledgment (carries the accept/reject code)
    -   **RF1:** Referral Information (links back to the original referral)
    -   **PRD:** Provider Information (identifies the responding provider)

### 3.3. State Management

-   The referral's `state` column in the **SQLite database** (introduced as a prerequisite before this PRD) must be updated on every disposition decision.
-   The state for the specific referral ID must transition from `Acknowledged` to `Accepted` or `Declined`. This prevents duplicate processing and allows for clear tracking.
-   All disposition decisions must record the responsible clinician and a timestamp in the `referrals` table.
