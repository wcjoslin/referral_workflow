---
up: "[[📋 PRD Index]]"
next: "[[PRD-02 - Process & Disposition]]"
---

# PRD-01: Receive and Acknowledge Referral Request

**Status:** Approved ✅  
**Team:** Data Ingestion & Processing  
**Module:** `prd01/`

---

## Context

360 Exchange for Closed Loop Referrals, called 360X for short, is a set of protocols and standards for exchanging health information. The primary goals of 360X are to enhance communication across care transitions to improve the quality of care, decrease provider burden, and decrease cost. This is achieved through workflows that "close the referral loop," ensuring the referring provider receives information back from the specialist. 360X uses Direct Secure Messaging as the transport standard to "push" C-CDA documents between care teams.

## Goal

- Implement the inbound ingestion of C-CDA referral documents, including 360X context.
- Send feedback to the referring provider that the document has been received.
- Parse out key information to understand the referral request context and patient information.

## User Stories

- As a **Referring Provider's system**, I want to receive an automated acknowledgment (MDN) when my referral message is successfully delivered, so that I have a non-repudiable record of receipt.
- As a **Receiving System (our PoC)**, I want to automatically parse the incoming message to identify the patient and the referral reason, so that I can prepare the data for the next step in the workflow.

## Acceptance Criteria

- **AC1:** When a message containing a C-CDA file is placed in the mock inbox, a Message Delivery Notification (MDN) is sent back to the sender's address within 5 minutes.
- **AC2:** The system correctly parses the patient's name and date of birth from the C-CDA header.
- **AC3:** The system correctly extracts the `Reason for Referral` text from the C-CDA body.
- **AC4:** If a message does *not* contain a C-CDA file, an MDN is still sent, but an error is logged internally.

## Technical Specifications

**Dependencies:**
- C-CDA Parser: **@kno2/bluebutton** (Node.js/TypeScript)
- HL7 V2 Library: **hl7** (npm) for parsing and generating HL7 V2 messages
- Email Transport: **nodemailer** (outbound) and **imapflow** (inbound IMAP polling) for the mock Direct gateway

**Engineering Constraints:**
- Must listen on a **Mock Direct Gateway** (e.g., local SMTP/IMAP server) to simulate the transport layer
- The MDN is an **email-format notification** (RFC 3798), not an HL7 V2 message. It must be constructed as a `multipart/report` email reply referencing the `Message-ID` of the original inbound message
- Initial parsing can be stateless (in-memory) without requiring a database

**Test Plan:**
- Unit tests for parsing patient name, DOB, and referral reason from sample C-CDA files
- Integration test for the full inbox-to-MDN flow

**Deliverables:**
- A listener script that polls the mock inbox
- A parsing module to extract the required C-CDA fields
- A response module to construct and send the MDN

---

## Related Documents

- [[📋 PRD Index|See all PRDs]]
- [[../Architecture/360X Workflow Overview|Workflow Overview]]
- [[../Engineering/ENGINEERING-PRD-01|Engineering Specifications]]
