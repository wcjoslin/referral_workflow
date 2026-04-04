---
up: "[[🎯 PROJECT OVERVIEW]]"
---

# Engineering Architecture: PRD-01 - Receive and Acknowledge Referral Request

**Status:** Approved ✅

This document outlines the proposed software architecture for implementing the requirements of [[../Features/PRD-01 - Receive & Acknowledge|PRD-01: Receive and Acknowledge Referral Request]].

---

## High-Level Summary

The proposed architecture consists of a background service that continuously monitors a mock Direct Secure Messaging gateway (an IMAP inbox) for incoming referral messages. When a message is received, the service will process it, validate the presence of a C-CDA attachment, and immediately dispatch a Message Delivery Notification (MDN) to the original sender to acknowledge receipt. Subsequently, it will parse the C-CDA document using `@kno2/bluebutton` to extract key patient and referral information, holding it in memory for the next stage of the workflow. The system is designed to be modular, allowing for easy testing and future expansion.

---

## Technology Stack

The project uses a **Node.js/TypeScript** stack.

- **Language:** TypeScript (Node.js 20+)
- **C-CDA Parsing:** `@kno2/bluebutton` – The industry-standard library for converting C-CDA XML into a developer-friendly JSON object
- **Email Transport (Outbound):** `nodemailer` – For sending MDN acknowledgments via the mock SMTP gateway
- **Email Transport (Inbound):** `imapflow` – For polling the mock IMAP inbox for new referral messages
- **Testing:** `jest` with `ts-jest` – Standard TypeScript testing framework

> **Note:** The `hl7` (npm) package is a project-wide dependency for HL7 V2 message construction but is **not used in PRD-01**. PRD-01 only sends an email-format MDN (RFC 3798) via `nodemailer`. The `hl7` package is first used in [[../Features/PRD-02 - Process & Disposition|PRD-02]] for `RRI^I12` generation.

**Justification:** This stack keeps the entire project in a single language and runtime. `@kno2/bluebutton` is the primary reason for choosing Node.js — it is the most actively maintained, industry-tested C-CDA parser available. TypeScript adds type safety that is especially valuable when working with complex healthcare data structures.

---

## System Components

The application will be broken down into the following discrete modules:

### 1. **Inbox Monitor (`inboxMonitor.ts`)**
- **Responsibility:** Periodically polls the mock IMAP inbox for new messages
- **Mechanism:** Runs on a configurable polling interval (e.g., every 10 seconds) using `imapflow`
- **Output:** When a new message is found, passes the raw email content to the `Message Processor`

### 2. **Message Processor (`messageProcessor.ts`)**
- **Responsibility:** Receives a raw email, extracts the sender's address, and identifies the C-CDA attachment
- **Logic:**
  - Determines the sender address for the MDN response
  - Immediately triggers the `MDN Service`
  - Checks for a `.xml` or `.cda` attachment
  - If an attachment is found, passes it to the `C-CDA Parser`
  - If not, logs an internal error as per the acceptance criteria

### 3. **C-CDA Parser (`cdaParser.ts`)**
- **Responsibility:** Uses `@kno2/bluebutton` to extract required fields from the C-CDA XML
- **Interface:** A function that takes the C-CDA file content as a string
- **Output:** A structured `ReferralData` TypeScript object containing the patient's name, DOB, and reason for referral

### 4. **MDN Service (`mdnService.ts`)**
- **Responsibility:** Constructs and sends a standards-compliant MDN email reply back to the original sender using `nodemailer`
- **Format:** An MDN is an **email-protocol notification** (RFC 3798), not an HL7 V2 message. It is a `multipart/report` email with two parts:
  - **Part 1 — Human-readable:** A plain-text body (e.g., `"Your referral message was received and is being processed."`)
  - **Part 2 — Machine-readable:** A `message/disposition-notification` block containing:
    - `Original-Message-ID`: The `Message-ID` header of the inbound referral email
    - `Final-Recipient`: The Direct address of the receiving system
    - `Disposition`: `automatic-action/MDN-sent-automatically; processed`
- **Key point:** The `Message-ID` of the inbound email must be extracted by the `Message Processor` and passed to this service. No HL7 library is used here — this is handled entirely by `nodemailer`

---

## Data Models

The `C-CDA Parser` will produce an in-memory data object defined as a TypeScript interface.

**In-Memory `ReferralData` Object:**

```typescript
interface Patient {
  firstName: string;
  lastName: string;
  dateOfBirth: string; // ISO 8601 format: YYYY-MM-DD
}

interface ReferralData {
  sourceMessageId: string;
  patient: Patient;
  reasonForReferral: string;
  isCdaValid: boolean;
}
```

This object will be logged to the console for now and will serve as the input for the services developed in [[../Features/PRD-02 - Process & Disposition|PRD-02]].

---

## API Design

There are no external web APIs for this service. The "API" consists of the internal function signatures that connect the components.

```typescript
// cdaParser.ts
function parseCda(cdaXmlContent: string): ReferralData

// messageProcessor.ts
// FetchMessageObject is the message type provided by imapflow
async function processInboundMessage(msg: FetchMessageObject): Promise<void>
// 1. Trigger MDN send-back
// 2. Extract attachment
// 3. cdaParser.parseCda(attachment)
// 4. Log the resulting ReferralData object

// inboxMonitor.ts
async function pollInbox(): Promise<void>
// Loops on interval, calling processInboundMessage for each new email
```

---

## User Flow

The following sequence diagram illustrates the automated workflow.

```
Referring Provider's System
    ↓ (sends referral C-CDA via email)
Mock Direct Gateway (SMTP/IMAP)
    ↓ (loop: poll for messages)
Inbox Monitor
    ↓ (new message found)
Message Processor
    ├→ MDN Service → Gateway → Referring Provider (MDN acknowledgment)
    └→ C-CDA Parser → parse C-CDA → log ReferralData
```

---

## Prerequisite for PRD-02: Persistence Layer

PRD-01 is intentionally stateless — parsed data lives in memory only. However, **before coding on [[../Features/PRD-02 - Process & Disposition|PRD-02]] begins**, a persistence layer must be established. Every PRD from PRD-02 onward requires reading and writing referral state to a database.

**Decision: SQLite + Drizzle ORM**

- **SQLite** — File-based, zero infrastructure, no separate server or Docker container required. Ideal for a PoC. Migrating to PostgreSQL later is a one-line config change in Drizzle
- **Drizzle ORM** (`drizzle-orm`, `@drizzle-team/drizzle-kit`) — TypeScript-native schema definitions, type-safe queries, and auto-generated migrations

**Initial Schema:**

The schema will include tables for `patients`, `referrals`, `outbound_messages`, `skill_executions`, and supporting indexes.

---

## Related Documents

- [[../Features/PRD-01 - Receive & Acknowledge|PRD-01 Requirements]]
- [[../Features/PRD-02 - Process & Disposition|PRD-02 (depends on persistence layer)]]
- [[../🎯 PROJECT OVERVIEW|Project Overview]]
