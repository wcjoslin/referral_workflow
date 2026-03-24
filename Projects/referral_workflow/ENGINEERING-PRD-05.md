# ENGINEERING-PRD-05: Patient Encounter and Interim Updates

**Status:** Draft — pending approval
**Depends on:** PRD-03 complete (referral in `Scheduled` state)

---

## 1. Overview

When a scheduled appointment occurs, the referral transitions from `Scheduled` to `Encounter`. A mock encounter trigger fires automatically after scheduling to keep the happy-path demo fully automated. An optional interim Direct Secure Message notifies the referring provider that the patient has been seen.

---

## 2. State Transition

No state machine changes needed — `Scheduled → Encounter` is already defined.

```
Accepted → Scheduled → Encounter   ← PRD-05 covers this step
```

---

## 3. Schema Changes

None. The existing `referrals` table already tracks state. Interim messages are logged to `outbound_messages` with `messageType: 'InterimUpdate'`.

---

## 4. New Files

```
src/modules/prd05/
  encounterService.ts    — marks encounter complete, sends optional interim message
  adtParser.ts           — parses ADT^A04 HL7 V2 message to extract referral ID
  mockEncounter.ts       — auto-fires encounter after scheduling (non-blocking)

src/views/
  encounterAction.html   — manual "Mark Encounter Complete" + optional interim message UI

tests/unit/prd05/
  adtParser.test.ts
  encounterService.test.ts
```

---

## 5. Module Design

### 5.1 `adtParser.ts`

Parses an inbound HL7 V2 ADT^A04 message to extract the referral/appointment ID. Used by the encounter service when processing real ADT messages.

```typescript
export interface AdtData {
  messageControlId: string;  // MSH-10
  patientId: string;         // PID-3
  appointmentId: string;     // PV1-19 (visit number = referral ID)
}

export function parseAdt(raw: string): AdtData;
// Throws if message type is not ADT^A04 or required fields are missing
```

### 5.2 `encounterService.ts`

Core logic: validates state, transitions to Encounter, optionally sends an interim update.

```typescript
export interface EncounterOptions {
  referralId: number;
  sendInterimUpdate?: boolean;  // default true for demo
}

export async function markEncounterComplete(opts: EncounterOptions): Promise<void>;
// 1. Load referral from DB
// 2. Validate state is Scheduled, transition to Encounter
// 3. UPDATE referrals.state
// 4. If sendInterimUpdate: build plain-text message, send via SMTP, log to outbound_messages
```

The interim message is a plain-text Direct Secure Message (not HL7):
```
Subject: Interim Update — Referral #<id>

Patient <name> was seen for their initial consultation on <date>.
A final consult note will follow upon completion of all evaluations.
```

### 5.3 `mockEncounter.ts`

Fires non-blocking after `schedulingService.scheduleReferral()` completes. For the demo, fires immediately (no delay) to keep the pipeline moving.

```typescript
export async function onReferralScheduled(referralId: number): Promise<void>;
// Calls markEncounterComplete({ referralId, sendInterimUpdate: true })
// Logs result — never throws to caller
```

---

## 6. Integration Point

`schedulingService.scheduleReferral()` gains one non-blocking call at the end:

```typescript
void mockEncounter.onReferralScheduled(referralId).catch((err) =>
  console.error('[MockEncounter] Failed:', err.message)
);
```

---

## 7. New Express Routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/referrals/:id/encounter` | Renders `encounterAction.html` — encounter status + manual action |
| `POST` | `/referrals/:id/encounter` | Body: `{ sendInterimUpdate?: boolean }` — marks encounter complete |

---

## 8. UI Page

**`encounterAction.html`** — simple page showing:
- Patient name, referral reason, scheduled appointment details
- Current state badge
- "Mark Encounter Complete" button (with checkbox for sending interim update)
- Status confirmation after action

---

## 9. No New npm Dependencies

All functionality uses existing packages (nodemailer for SMTP).

---

## 10. Tests

| File | Tests |
|---|---|
| `adtParser.test.ts` | Extracts correct fields from valid ADT^A04; throws on wrong message type; throws on missing fields |
| `encounterService.test.ts` | Happy path: state → Encounter, interim message sent + logged; without interim: state transitions but no SMTP call; wrong-state throws; not-found throws |
