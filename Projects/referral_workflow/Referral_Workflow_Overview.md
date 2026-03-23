To create a proof of concept (PoC) for the **360X Closed Loop Referral** process, you need to bridge the gap between traditional healthcare interoperability standards (Direct Secure Messaging, HL7 V2, and C-CDA) and modern agentic AI.

The 360X protocol is essentially a **state machine** where two organizations exchange status updates until a referral is "closed" by a final clinical report.

-----

## 1\. Step-by-Step 360X Workflow

The 360X process uses **Direct Secure Messaging** as the transport layer. The "intelligence" of the loop is maintained through specific HL7 V2 messages or C-CDA documents attached to those messages.

| Step | Actor | Action | Technical Payload |
| :--- | :--- | :--- | :--- |
| **1. Initiation** | Referring Provider | Sends referral request. | **C-CDA** (Referral Note) + **HL7 V2 REF^I12** |
| **2. Receipt** | Receiving Provider | Confirms message delivery. | **Direct MDN** (Message Delivery Notification) |
| **3. Disposition** | Receiving Provider | Accepts or declines the referral. | **HL7 V2 RRI^I12** (Accept/Decline status) |
| **4. Scheduling** | Receiving Provider | Notifies that the patient is scheduled. | **HL7 V2 SIU^S12** (Appointment Scheduled) |
| **5. Encounter** | Receiving Provider | Patient is seen; interim updates sent. | **Direct Message** (Optional) |
| **6. Closing** | Receiving Provider | Sends final consult report. | **C-CDA** (Consult Note) |
| **7. Completion**| Referring Provider | Acknowledges report receipt. | **HL7 V2 ACK** (Closes the loop) |

-----

## 2\. Open Source C-CDA Repositories

To simulate a patient care scenario, you need high-fidelity sample documents.

  * **[HL7 C-CDA Examples](https://github.com/HL7/C-CDA-Examples):** The official repository for C-CDA R2.1 samples. Look in the `/Referrals - Planned and Completed` folder for your specific use case.
  * **[Smart Health IT / SyntheticMass](https://synthea.mitre.org/):** While primarily FHIR-based, the **Synthea** tool can generate thousands of "synthetic patients" with full histories in C-CDA format. This is the best tool for "simulating a scenario" from scratch.
  * **[CHB Sample C-CDAs](https://github.com/chb/sample_ccdas):** A collection of samples from various EHR vendors (Epic, Cerner, Allscripts) to test your parser's resilience against "real-world" formatting differences.

-----

## 3\. Libraries for Ingestion, Parsing, and Logic

For an **Agentic AI** approach, you want libraries that convert XML into clean JSON for the LLM to process.

### **Parsing & Ingestion**

  * **C-CDA (Node.js):** **[@kno2/bluebutton](https://www.npmjs.com/package/@kno2/bluebutton)** – The industry-standard fork of BlueButton.js. Converts complex C-CDA XML into a developer-friendly JSON object. This is the primary C-CDA parsing library for this project.
  * **HL7 V2 (Node.js):** **[hl7](https://www.npmjs.com/package/hl7)** – A Node.js library for parsing and generating HL7 V2 messages (REF, RRI, SIU, ACK).
  * **Email Transport (Node.js):** **[nodemailer](https://nodemailer.com/)** (outbound SMTP) and **[imapflow](https://imapflow.com/)** (inbound IMAP polling) to connect to the mock Direct gateway.

### **Agentic Orchestration**

  * **[Anthropic SDK for Node.js](https://www.npmjs.com/package/@anthropic-ai/sdk):** Used directly for AI reasoning steps (e.g., C-CDA completeness validation, clinical text extraction). Provides full access to Claude models without requiring a heavyweight framework.
  * **State Machine:** A custom TypeScript state machine module (`referralStateMachine.ts`) to manage the 360X referral state lifecycle (`Received → Acknowledged → Accepted/Declined → Scheduled → Encounter → Closed → Closed-Confirmed`). The lifecycle is linear and deterministic — no third-party state machine library is needed. State transitions are persisted to the SQLite database on every change.
  * **AI Reasoning (targeted):** Direct `@anthropic-ai/sdk` calls are used only where clinical reasoning is genuinely required: (1) **PRD-02** — evaluating whether C-CDA content is clinically sufficient for the specialty; (2) **PRD-04** — extracting and structuring clinical text from a signed note into a valid Consult Note C-CDA. All other workflow steps are deterministic and do not invoke the LLM.

-----

## 4\. Technical Layout for the PoC Application

### **Layer 1: The Simulator (Transport)**

Since setting up a full HISP is difficult, use a **Mock Direct Gateway**.

  * Use a basic **SMTP server** (e.g., [Mailtrap](https://mailtrap.io/) or a local Dockerized Postfix) to mimic the "Push" nature of Direct.
  * Write a script to wrap your C-CDA/HL7 payloads in an S/MIME-like envelope (or just plain MIME for the PoC).

### **Layer 2: The Agentic Orchestrator (The "Brain")**

1.  **Ingestion:** A listener script polls the "Inbox."
2.  **Parsing Node:** The agent uses `@kno2/bluebutton` to turn the incoming C-CDA into JSON.
3.  **Validation Node (AI):** The agent compares the `Reason for Referral` in the C-CDA against your simulated specialty (e.g., Cardiology).
      * *Error Handling:* If the C-CDA is missing a "Medication List," the AI identifies this and triggers an "Information Request" message instead of an "Acceptance."
4.  **Logic Node:** Based on the 360X state, the agent generates the next HL7 V2 message (e.g., an RRI^I12 to accept).

### **Layer 3: The Feedback Loop (Closing)**

  * Simulate a "Consultation" by having the AI generate a **Consult Note C-CDA** based on a prompt: *"Write a specialist summary for a patient with the following lab results..."*
  * The system "sends" this back to the referring address, updating the local database status to `CLOSED`.

The [Official 360X Guide](https://www.google.com/search?q=https://www.youtube.com/watch%3Fv%3D3u_9XU56gP8) provides a deep dive into how DirectTrust manages the trust framework and the technical handshake required for closed-loop referrals.