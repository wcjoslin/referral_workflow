# Engineering Spec: PRD-02 — Process and Disposition Referral

## 1. Overview

PRD-02 is where the referral first touches the database and gains a lifecycle. It receives the parsed output from PRD-01, performs extended C-CDA parsing (payer, problems, allergies, medications, diagnostics), writes the patient and referral records to SQLite, auto-declines incomplete referrals, and presents a review UI for valid referrals. The clinician's Accept or Decline decision generates an HL7 V2 `RRI^I12` message sent back via the mock Direct gateway.

**Outcome:** A clinician can open `http://localhost:3000/referrals/:id/review`, read the parsed referral, see a Claude AI sufficiency summary, and click Accept or Decline. The state machine advances and the referring provider receives an RRI.

---

## 2. Architecture

```
inboxMonitor
    │
    ▼
processInboundMessage()          ← PRD-01 (returns ProcessedMessage, unchanged logic)
    │
    ▼
referralService.ingestReferral() ← PRD-02 entry point
    ├─ parseExtendedCda()         ← expand existing cdaParser.ts
    ├─ validateRequiredSections() ← auto-decline gate
    ├─ DB write: patient + referral (state: Received → Acknowledged)
    ├─ claudeService.assessSufficiency() ← advisory only, non-blocking
    └─ [if valid] queue for clinician review

Express UI: GET /referrals/:id/review
Express API: POST /referrals/:id/disposition
    ├─ dispositionService.accept() or .decline()
    ├─ rriBuilder.buildRri()
    ├─ mdnService.sendDirectMessage() ← reuse nodemailer transport
    └─ state transition: Acknowledged → Accepted | Declined
```

---

## 3. Breaking Change: `processInboundMessage` Return Type

PRD-02 needs the raw C-CDA XML to run extended parsing. Currently `processInboundMessage` returns `ReferralData` which does not carry the raw XML.

**Change:** Update the return type to `ProcessedMessage`:

```typescript
// src/modules/prd01/messageProcessor.ts

export interface ProcessedMessage {
  referralData: ReferralData;
  rawCdaXml: string | null; // null if no attachment was found
}

export async function processInboundMessage(
  rawEmail: Buffer | string,
): Promise<ProcessedMessage>
```

`referralData` is the same object as before. `rawCdaXml` carries the raw attachment content for PRD-02's extended parser.

**Impact on existing tests:** `messageProcessor.test.ts` assertions will need updating to destructure `{ referralData }` from the result. All existing assertions remain logically identical.

---

## 4. Extended C-CDA Parsing

### 4.1. New types in `bluebutton.d.ts`

Add type declarations for the additional BlueButton sections used in PRD-02:

```typescript
interface BBEntry {
  code?: { code: string; system: string; name: string };
  value?: unknown;
  text?: string;
}

interface BBPayer {
  plan?: { name: string; id: string };
  member_id?: string;
}

interface BBAllergy {
  allergen?: { name: string };
  reaction?: Array<{ name: string }>;
  severity?: { name: string };
  status?: { name: string };
}

interface BBMedication {
  product?: { name: string; code: string };
  dose?: { value: number; unit: string };
  route?: { name: string };
  status?: string;
}

interface BBProblem {
  name?: string;
  code?: { code: string; system: string };
  status?: { name: string };
  onset?: { date: Date | null };
}

interface BBResult {
  name?: string;
  value?: number | string;
  unit?: string;
  date?: { date: Date | null };
}
```

Add these sections to `BBData`:

```typescript
interface BBData {
  demographics: BBSection<BBDemographicsEntry>;
  chief_complaint: { text: string; entries: BBEntry[] };
  payers?: { entries: BBPayer[]; text: string };
  allergies?: { entries: BBAllergy[]; text: string };
  medications?: { entries: BBMedication[]; text: string };
  problems?: { entries: BBProblem[]; text: string };
  results?: { entries: BBResult[]; text: string };
}
```

### 4.2. New function: `parseExtendedCda()`

Add to `src/modules/prd01/cdaParser.ts`:

```typescript
export interface ExtendedReferralData extends ReferralData {
  payer: string;           // insurance plan name, empty string if absent
  problems: string[];      // active problem names
  allergies: string[];     // allergen names
  medications: string[];   // medication names
  diagnosticResults: string[]; // result names
  missingOptionalSections: string[]; // sections present in schema but empty in this doc
}

export function parseExtendedCda(
  cdaXml: string,
  sourceMessageId: string,
): ExtendedReferralData
```

The function:
1. Calls the existing `parseCda()` to get base fields (reuse, don't duplicate)
2. Calls `BlueButton(cdaXml)` again (or accept the doc as a parameter — see note below) to extract the additional sections
3. Maps each section to a flat string array for easy rendering
4. Populates `missingOptionalSections` with the names of any sections that were empty

> **Implementation note:** To avoid parsing the XML twice, `parseExtendedCda` will call `BlueButton(cdaXml)` directly and extract both base and extended fields in a single pass, making `parseCda` an internal detail. The `parseCda` export stays for backward compatibility.

### 4.3. Required sections for auto-decline

The following three sections are required. Missing any one triggers automatic decline:

| Section | BlueButton field | Validation check |
|---|---|---|
| Patient Demographics | `data.demographics.entries[0]` | first name, last name, and DOB all present |
| Reason for Referral | `data.chief_complaint.text` | non-empty after trim |
| Payer Information | `data.payers.entries[0]` | at least one entry present |

Optional sections (flagged in UI but not blocking): problems, allergies, medications, diagnostic results.

---

## 5. New Files

```
src/
  modules/
    prd02/
      referralService.ts     # ingest, auto-decline, DB write
      claudeService.ts       # Claude API sufficiency assessment
      rriBuilder.ts          # builds RRI^I12 as HL7 V2 pipe-delimited string
      dispositionService.ts  # accept/decline, state transition, RRI send
  server.ts                  # Express app (routes for UI + disposition API)
  views/
    referralReview.html      # static HTML template for clinician review UI
```

---

## 6. `referralService.ts` — Ingest Flow

```typescript
export async function ingestReferral(
  processed: ProcessedMessage,
): Promise<number | null>  // returns referralId, or null if auto-declined
```

Steps:
1. If `processed.referralData.isCdaValid` is false, call `autoDecline()` and return null
2. Call `parseExtendedCda(processed.rawCdaXml, processed.referralData.sourceMessageId)`
3. Validate required sections — if any missing, call `autoDecline()` and return null
4. DB write:
   - `INSERT INTO patients` with firstName, lastName, dateOfBirth
   - `INSERT INTO referrals` with state `Received`, then immediately transition to `Acknowledged`
5. Fire `claudeService.assessSufficiency()` as a non-blocking background call — store result in memory keyed by referralId for the UI to read
6. Return `referralId`

**`autoDecline()` internal flow:**
- Build `RRI^I12` with rejection code `AR` and reason `"Incomplete C-CDA: <list of missing sections>"`
- Call `dispositionService.sendRri()` to transmit via Direct gateway
- Log the auto-decline to console (no DB record written for invalid referrals — they never make it to the DB)

---

## 7. `claudeService.ts` — Sufficiency Assessment

Single function:

```typescript
export interface SufficiencyAssessment {
  sufficient: boolean;
  summary: string;      // 1–2 sentence plain-language assessment
  concerns: string[];   // specific gaps or flags
}

export async function assessSufficiency(
  extendedData: ExtendedReferralData,
): Promise<SufficiencyAssessment>
```

**Prompt strategy:** Pass a structured summary of the parsed fields (not raw XML) to Claude. Ask it to evaluate whether the referral has sufficient clinical information for a specialist to act on. Return structured JSON using Claude's tool use / structured output.

**Model:** `claude-haiku-4-5-20251001` — fast and cheap, this is an advisory call, not a critical one.

**Failure behavior:** If the API call throws, return `{ sufficient: true, summary: 'Assessment unavailable', concerns: [] }`. Claude's assessment is advisory — it must never block the workflow.

---

## 8. `rriBuilder.ts` — RRI^I12 Construction

Build the HL7 V2 message as a pipe-delimited string. No third-party HL7 library — the structure is simple and deterministic enough to build directly.

```typescript
export interface RriOptions {
  messageControlId: string;   // MSH-10 — unique per message, used for ACK tracking
  referralId: number;         // links back to the referral record
  sourceMessageId: string;    // original inbound Message-ID
  referrerAddress: string;    // Direct address to send to
  acceptCode: 'AA' | 'AR';   // AA = accept, AR = reject
  declineReason?: string;     // populated when acceptCode = 'AR'
  sendingFacility: string;    // from config.receiving.directAddress
}

export function buildRri(opts: RriOptions): string
```

**Segments generated:**

- `MSH` — message header, encoding chars, sending/receiving facility, datetime, `RRI^I12`
- `MSA` — message acknowledgment: `MSA|AA|{messageControlId}` or `MSA|AR|{messageControlId}|{declineReason}`
- `RF1` — referral information: links to original referral via `sourceMessageId`
- `PRD` — provider detail: receiving facility name and Direct address

`messageControlId` must be a UUID (`crypto.randomUUID()`) logged to `outbound_messages` for ACK tracking in PRD-06/07.

---

## 9. `dispositionService.ts`

```typescript
export async function accept(
  referralId: number,
  clinicianId: string,
): Promise<void>

export async function decline(
  referralId: number,
  clinicianId: string,
  reason: string,
): Promise<void>
```

Each function:
1. Loads the referral from DB, validates it is in `Acknowledged` state
2. Calls `transition(current, next)` from `referralStateMachine.ts` — throws on invalid state
3. Updates `referrals` table: `state`, `clinicianId`, `declineReason` (if declining), `updatedAt`
4. Builds `RRI^I12` via `rriBuilder.buildRri()`
5. Sends via `nodemailer` to `referrerAddress` (Direct gateway SMTP)
6. Inserts row to `outbound_messages`: `messageType: 'RRI'`, `status: 'Pending'`, `sentAt: now`

```typescript
// Internal — also used by auto-decline
export async function sendRri(
  rriMessage: string,
  toAddress: string,
  messageControlId: string,
  referralId: number | null,  // null for auto-declined referrals not yet in DB
): Promise<void>
```

---

## 10. Express Server (`src/server.ts`)

```typescript
import express from 'express';
const app = express();
app.use(express.json());

// Render referral review UI
GET  /referrals/:id/review

// Submit disposition decision
POST /referrals/:id/disposition
  body: { decision: 'Accept' | 'Decline', clinicianId: string, declineReason?: string }
  → calls dispositionService.accept() or .decline()
  → responds 200 on success, 400/409 on invalid state or bad input

// Health check
GET  /health
```

The review page (`referralReview.html`) is a single HTML file rendered server-side by substituting a JSON data block. It displays:

- Patient name, DOB
- Reason for referral
- Payer information
- Problems, allergies, medications (tables)
- Diagnostic results
- Claude sufficiency assessment (summary + concerns list)
- Missing optional sections highlighted in amber
- Accept / Decline buttons with a reason field that appears on Decline

**No frontend framework.** Plain HTML + inline CSS. This is a PoC review screen, not a product UI.

New dependency: `express`, `@types/express`

---

## 11. State Transitions in PRD-02

| Trigger | From | To | Where |
|---|---|---|---|
| `ingestReferral()` called | — | `Received` | DB insert |
| MDN sent (PRD-01 confirmed) | `Received` | `Acknowledged` | immediately after insert |
| Clinician clicks Accept | `Acknowledged` | `Accepted` | `dispositionService.accept()` |
| Clinician clicks Decline | `Acknowledged` | `Declined` | `dispositionService.decline()` |
| Auto-decline (incomplete CDA) | *(never entered DB)* | — | no state change |

> Auto-declined referrals never reach the DB. An RRI rejection is still sent to the referrer, but no patient or referral record is created. This is intentional — incomplete submissions should not pollute the referral table.

---

## 12. New Environment Variables

```
# Already defined in config.ts — no new vars required.
# Express server port:
PORT=3000    # optional, default 3000
```

Add `PORT` to `.env.example`.

---

## 13. Dependencies

| Package | Purpose | New? |
|---|---|---|
| `express` | Review UI and disposition API | Yes |
| `@types/express` | TypeScript types | Yes |
| `@anthropic-ai/sdk` | Claude sufficiency call | Already in package.json |
| `crypto` | `randomUUID()` for message control IDs | Node built-in |

---

## 14. Test Plan

### Unit tests (`tests/unit/prd02/`)

**`rriBuilder.test.ts`**
- Accept RRI: `MSA` segment contains `AA`, no decline reason in message
- Decline RRI: `MSA` segment contains `AR`, decline reason present
- `messageControlId` appears in `MSH-10`
- `sourceMessageId` appears in `RF1`

**`referralService.test.ts`**
- Auto-decline fires when `isCdaValid: false` (no DB write, RRI sent)
- Auto-decline fires when payer section missing (no DB write, RRI sent)
- Valid referral: patient and referral records inserted, state `Acknowledged`
- `claudeService.assessSufficiency` is called once for valid referrals
- `claudeService` failure does not throw — ingest still succeeds

**`dispositionService.test.ts`**
- Accept: state transitions to `Accepted`, RRI `AA` sent, `outbound_messages` row inserted
- Decline: state transitions to `Declined`, RRI `AR` sent with reason, `outbound_messages` row inserted
- Calling accept on a `Declined` referral throws `InvalidStateTransitionError`

**`claudeService.test.ts`**
- Returns structured `SufficiencyAssessment` for valid input (mock Anthropic SDK)
- Returns safe fallback `{ sufficient: true, summary: 'Assessment unavailable', concerns: [] }` when API throws

### Updates to existing tests

**`messageProcessor.test.ts`** — update 4 assertions to destructure `{ referralData }` from `processInboundMessage` result. No logic changes.

### Integration test (manual — requires mock gateway)

1. Send email with complete C-CDA to mock inbox
2. Server starts, referral ingested, DB record created
3. `GET /referrals/1/review` renders review page with patient data and Claude assessment
4. POST `{ decision: 'Accept', clinicianId: 'dr-smith' }` → state updates to `Accepted`, RRI appears in mock gateway sent folder
5. Repeat with incomplete C-CDA — auto-decline fires, RRI rejection sent, no DB record created

---

## 15. Definition of Done

- [ ] `tsc --noEmit` passes with zero errors
- [ ] All existing tests pass (including updated `messageProcessor.test.ts`)
- [ ] All new unit tests pass
- [ ] `GET /referrals/:id/review` renders correctly for a seeded referral record
- [ ] `POST /referrals/:id/disposition` with Accept and Decline both produce correct RRI output
- [ ] Auto-decline path confirmed via test — no spurious DB records
- [ ] `outbound_messages` row created for every RRI sent
