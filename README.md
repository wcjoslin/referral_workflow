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

  * **Node.js:** **[@kno2/bluebutton](https://www.google.com/search?q=https://www.npmjs.com/package/%40kno2/bluebutton)** – This is the most active fork of the original BlueButton.js. it converts complex C-CDA XML into a developer-friendly JSON object.
  * **Python:** **[pyCCDA](https://github.com/MemoirHealth/ccda-parser)** – A lightweight engine to extract demographics and clinical sections (Allergies, Meds, Problems) into Python dictionaries.
  * **HL7 V2:** **[HAPI HL7v2](https://hapifhir.github.io/hapi-hl7v2/)** (Java) or **[hl7-parser](https://www.google.com/search?q=https://github.com/cleohealth/hl7-parser)** (Python) to handle the status update messages (REF, RRI, SIU).

### **Agentic Orchestration**

  * **[LangGraph](https://www.langchain.com/langgraph):** Ideal for 360X because it supports **stateful, multi-step cycles**. You can define nodes for "Parse Message," "Check for Errors," and "Formulate Response."
  * **[CrewAI](https://www.crewai.com/):** You can set up "Specialist Agents" (e.g., a "Referral Intake Agent" that checks for missing insurance info and a "Clinical Summarizer" that ensures the Care Summary matches the Referral Reason).

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

Would you like me to provide a **Python code snippet** using a library like `LangGraph` to handle the "Wait for Appointment" vs "Send Error" logic in this workflow?

The [Official 360X Guide](https://www.google.com/search?q=https://www.youtube.com/watch%3Fv%3D3u_9XU56gP8) provides a deep dive into how DirectTrust manages the trust framework and the technical handshake required for closed-loop referrals.