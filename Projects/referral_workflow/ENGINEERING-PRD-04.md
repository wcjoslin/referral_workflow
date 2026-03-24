# ENGINEERING-PRD-04: Generate and Send Final Consult Note

## 1. Overview

PRD-04 closes the clinical loop by generating a **Consult Note C-CDA** from the specialist's clinical findings and transmitting it back to the referring provider via Direct Secure Messaging. The referral transitions from **Encounter → Closed**.

**Trigger:** After the encounter is marked complete (PRD-05), clinical note text arrives — either automatically via `mockEhr.ts` or manually through the UI. The text is structured by the Gemini API into C-CDA sections, wrapped in a valid Consult Note XML document, and sent to the referrer.

---

## 2. Architecture

```
encounterService (PRD-05)
  └── non-blocking → mockEhr.onEncounterComplete(referralId)
        └── consultNoteService.generateAndSend({ referralId, noteText })
              ├── claudeConsultNote.structureNote(noteText, patientContext)
              │     └── Gemini API → { chiefComplaint, assessment, plan, ... }
              ├── ccdaBuilder.buildConsultNote(structuredSections, patient, referral)
              │     └── xmlbuilder2 → C-CDA XML string
              ├── SMTP send C-CDA to referrer
              ├── Log to outbound_messages (messageType: 'ConsultNote')
              └── transition(Encounter → Closed)

Manual fallback:
  GET  /referrals/:id/consult-note   → form with text area for clinical notes
  POST /referrals/:id/consult-note   → calls consultNoteService.generateAndSend()
```

Both the mock EHR trigger and the manual UI converge on `consultNoteService.generateAndSend()` — the trigger layer is replaceable.

---

## 3. New Files

```
src/modules/prd04/
  oruParser.ts            — parse ORU^R01 HL7 V2, extract OBX clinical note text
  claudeConsultNote.ts    — Gemini API call to structure free-text into C-CDA sections
  ccdaBuilder.ts          — build Consult Note C-CDA XML using xmlbuilder2
  consultNoteService.ts   — orchestrator: structure → build → send → log → transition
  mockEhr.ts              — auto-fires after encounter with sample clinical note text

src/views/
  consultNoteAction.html  — manual "Sign & Send Consult Note" form

tests/unit/prd04/
  oruParser.test.ts
  ccdaBuilder.test.ts
  consultNoteService.test.ts
```

---

## 4. Config Changes

No new env vars — uses existing `GEMINI_API_KEY` and `@google/generative-ai` SDK (same as PRD-02 sufficiency assessment).

No new ports — the mock EHR calls the service directly (same pattern as mockScheduler/mockEncounter). No separate ORU listener needed for the PoC.

---

## 5. Dependencies

```
xmlbuilder2          — C-CDA XML generation (new)
@google/generative-ai — Gemini API (already installed, reused from PRD-02)
```

---

## 6. Module Details

### 6.1 `oruParser.ts`

Parses HL7 V2 `ORU^R01` messages. Extracts:
- `messageControlId` (MSH-10)
- `patientId` (PID-3)
- `noteText` — concatenated OBX-5 fields (observation values)

```typescript
export interface OruData {
  messageControlId: string;
  patientId: string;
  noteText: string;
}
export function parseOru(raw: string): OruData;
```

### 6.2 `claudeConsultNote.ts`

Calls Gemini API to structure free-text clinical notes into discrete C-CDA sections:

```typescript
export interface ConsultNoteSections {
  chiefComplaint: string;
  historyOfPresentIllness: string;
  assessment: string;
  plan: string;
  physicalExam: string;
}

export async function structureNote(
  noteText: string,
  patientContext: { firstName: string; lastName: string; reasonForReferral: string },
): Promise<ConsultNoteSections>;
```

**Prompt strategy:** Ask Gemini to return a JSON object with the 5 section keys. Include patient context for grounding. Fallback: if parsing fails, place all text in `assessment`.

### 6.3 `ccdaBuilder.ts`

Generates a Consult Note C-CDA document using `xmlbuilder2`:

```typescript
export interface CcdaBuildOptions {
  patient: { firstName: string; lastName: string; dateOfBirth: string };
  referral: { reasonForReferral: string; referrerAddress: string };
  sections: ConsultNoteSections;
  documentId: string;
  effectiveTime: Date;
}

export function buildConsultNoteCcda(opts: CcdaBuildOptions): string;
```

Output: Valid C-CDA XML with:
- `<ClinicalDocument>` root with proper namespace and template IDs
- `<recordTarget>` with patient demographics
- `<component><structuredBody>` containing sections:
  - Chief Complaint (LOINC 10154-3)
  - History of Present Illness (LOINC 10164-2)
  - Assessment (LOINC 51848-0)
  - Plan of Treatment (LOINC 18776-5)
  - Physical Exam (LOINC 29545-1)

### 6.4 `consultNoteService.ts`

Orchestrates the full pipeline:

```typescript
export interface ConsultNoteOptions {
  referralId: number;
  noteText: string;
}

export async function generateAndSend(opts: ConsultNoteOptions): Promise<void>;
export class ReferralNotFoundError extends Error {}
```

Steps:
1. Load referral + patient from DB
2. Validate state is `Encounter` via `transition()`
3. Call `structureNote()` to get structured sections from Claude
4. Call `buildConsultNoteCcda()` to generate XML
5. Send C-CDA via SMTP to `referral.referrerAddress`
6. Log to `outbound_messages` with `messageType: 'ConsultNote'`
7. Update referral state to `Closed`

### 6.5 `mockEhr.ts`

Non-blocking trigger from encounter completion:

```typescript
export async function onEncounterComplete(referralId: number): Promise<void>;
```

Generates sample clinical note text (hardcoded for PoC — a realistic cardiology consult note) and calls `generateAndSend()`.

Wired from `encounterService.markEncounterComplete()` the same way mockScheduler/mockEncounter are wired:
```typescript
void onEncounterComplete(referralId).catch(err => console.error(...));
```

### 6.6 `consultNoteAction.html`

Manual fallback UI:
- Shows patient name, referral reason, current state
- Text area for entering/pasting clinical note text
- "Generate & Send Consult Note" button
- Status bar for success/error feedback
- Disabled/hidden if referral is not in `Encounter` state

---

## 7. Server Routes

```typescript
GET  /referrals/:id/consult-note   // Render manual consult note form
POST /referrals/:id/consult-note   // { noteText: string } → generateAndSend()
```

Error responses follow existing patterns (404 for not found, 409 for invalid state).

---

## 8. Test Plan

### Unit Tests
- `oruParser.test.ts`: parse valid ORU^R01, extract noteText from OBX segments
- `ccdaBuilder.test.ts`: output is valid XML, contains all 5 sections, has correct LOINC codes, includes patient demographics
- `consultNoteService.test.ts`: transitions state to Closed, sends SMTP, logs outbound message, handles not-found and wrong-state errors

### Mock Strategy
- Gemini API mocked in tests (return predetermined structured sections)
- nodemailer mocked (same as other service tests)
- In-memory SQLite (same as other service tests)

---

## 9. Demo Flow

After accepting and the auto-cascade fires:
```
Accept → mockScheduler → Scheduled → mockEncounter → Encounter → mockEhr → Closed
```

The review URL at each stage shows the current state. The consult note C-CDA is sent to the referrer's Direct address, and the outbound message is logged for PRD-06 ACK tracking.
