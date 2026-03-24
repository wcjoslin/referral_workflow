# ENGINEERING-PRD-03: Schedule Patient and Notify Referrer

**Status:** Draft — pending approval
**Depends on:** PRD-02 complete (referral in `Accepted` state)

---

## 1. Overview

When a referral transitions to `Accepted`, the mock scheduler auto-assigns an appointment and sends an `SIU^S12` (Schedule Information Unsolicited — New Appointment) HL7 V2 message to the referring provider. A manual scheduling UI serves as a fallback and for isolated testing.

---

## 2. State Transition

No state machine changes needed — `Accepted → Scheduled` is already defined.

```
Acknowledged → Accepted → Scheduled   ← PRD-03 covers this step
```

---

## 3. Schema Changes

**One new column** on `referrals`:

| Column | Type | Notes |
|---|---|---|
| `scheduled_provider` | `text` | Clinician assigned to the appointment (may differ from the reviewer) |

`appointment_date` (already exists) will store a full ISO 8601 datetime string (e.g., `"2025-05-01T10:00:00"`). `appointment_location` (already exists) stores the room/location name.

Migration: `0002_add_scheduled_provider.sql`

---

## 4. New Files

```
src/modules/prd03/
  mockScheduler.ts       — auto-assigns appointment on Accepted
  siuBuilder.ts          — builds HL7 V2 SIU^S12 pipe-delimited message
  schedulingService.ts   — core scheduling logic: conflict check, DB write, SIU send
  resourceCalendar.ts    — in-memory mock availability calendar

src/views/
  schedulerQueue.html    — list of Accepted referrals awaiting scheduling
  scheduleAppointment.html — manual scheduling form

tests/unit/prd03/
  siuBuilder.test.ts
  schedulingService.test.ts
  resourceCalendar.test.ts
```

---

## 5. Module Design

### 5.1 `resourceCalendar.ts`

In-memory mock calendar. Hardcoded rooms and equipment with pre-blocked time slots.

```typescript
export interface TimeSlot {
  start: Date;
  end: Date;
}

export interface Resource {
  id: string;
  name: string;
  blockedSlots: TimeSlot[];
}

// Returns any resources conflicting with the proposed slot
export function checkConflicts(
  resourceIds: string[],
  proposedStart: Date,
  durationMinutes: number,
): Resource[];

// Returns the mock resource catalogue
export function getResources(): Resource[];
```

Mock data: 3–4 resources (e.g., `echo-lab`, `stress-test-room`, `exam-room-1`, `exam-room-2`), each with a few pre-blocked slots.

---

### 5.2 `siuBuilder.ts`

Builds a pipe-delimited HL7 V2 SIU^S12 — same approach as `rriBuilder.ts`, no third-party library.

**Segments:** MSH | SCH | PID | PRD (4 segments, CRLF-separated)

```typescript
export interface SiuOptions {
  messageControlId: string;     // UUID
  appointmentId: string;        // referralId as string
  startDatetime: string;        // HL7 format: YYYYMMDDHHMMSS
  durationMinutes: number;      // e.g. 60
  appointmentType: string;      // e.g. "Cardiology Consult"
  locationName: string;
  scheduledProvider: string;
  patientFirstName: string;
  patientLastName: string;
  patientDob: string;           // YYYYMMDD
  referrerAddress: string;
  sendingFacility: string;
}

export function buildSiu(opts: SiuOptions): string;
```

---

### 5.3 `schedulingService.ts`

Core logic for recording an appointment, checking conflicts, sending SIU, and transitioning state.

```typescript
export class SchedulingConflictError extends Error {
  constructor(public conflicts: Resource[]) { ... }
}

export interface AppointmentDetails {
  appointmentDatetime: string;  // ISO 8601
  durationMinutes: number;
  locationName: string;
  scheduledProvider: string;
  resourceIds?: string[];       // optional resources to check for conflicts
}

// Called by both mockScheduler and the manual UI route
export async function scheduleReferral(
  referralId: number,
  details: AppointmentDetails,
): Promise<void>;
// 1. Load referral + patient from DB (throw if not found or wrong state)
// 2. checkConflicts() — throw SchedulingConflictError if any
// 3. UPDATE referrals: appointmentDate, appointmentLocation, scheduledProvider, state → Scheduled
// 4. buildSiu() + send via nodemailer SMTP
// 5. INSERT outbound_messages (type: 'SIU')
```

---

### 5.4 `mockScheduler.ts`

Fires non-blocking after `dispositionService.accept()`. Assigns a slot 7 days from now at 10:00 AM.

```typescript
// Called from dispositionService.accept() — non-blocking (no await at call site)
export async function onReferralAccepted(referralId: number): Promise<void>;
// Builds AppointmentDetails with fixed defaults, calls scheduleReferral()
// Logs result or error — never throws to caller
```

---

## 6. Integration Point

`dispositionService.accept()` gains one non-blocking call at the end (mirrors how Gemini is fired in PRD-02):

```typescript
// Inside accept(), after DB update and RRI send:
void mockScheduler.onReferralAccepted(referralId).catch((err) =>
  console.error('[MockScheduler] Failed:', err)
);
```

---

## 7. New Express Routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/scheduler/queue` | Renders `schedulerQueue.html` — lists all `Accepted` referrals |
| `GET` | `/referrals/:id/schedule` | Renders `scheduleAppointment.html` — manual scheduling form |
| `POST` | `/referrals/:id/schedule` | Body: `AppointmentDetails` — calls `scheduleReferral()`, returns JSON |

---

## 8. SIU^S12 Message Structure

```
MSH|^~\&|REFERRAL-WF|360X|REFERRER|HOSPITAL|<datetime>||SIU^S12|<controlId>|P|2.5.1
SCH|<apptId>||||||<apptType>|||||<duration>^min||||<startDatetime>
PID|||<patientId>||<lastName>^<firstName>||<dob>|
PRD|RP|||||<referrerAddress>
```

---

## 9. UI Pages

**`schedulerQueue.html`** — minimal table view:
- Columns: Patient name, Referral ID, Reason for Referral, Date Received, Action (→ Schedule)
- Fetches `/api/scheduler/queue` (new JSON endpoint) on load

**`scheduleAppointment.html`** — form with:
- Date + Time picker
- Location dropdown (populated from `getResources()`)
- Provider name field
- Resource checkboxes (optional equipment/room)
- Submit → POST `/referrals/:id/schedule`
- Conflict warning rendered inline if `SchedulingConflictError` returned

---

## 10. No New npm Dependencies

`SIU^S12` built manually (same as RRI). All other functionality uses existing packages.

---

## 11. Tests

| File | Tests |
|---|---|
| `siuBuilder.test.ts` | All 4 segments present; correct datetime format; pipe escaping |
| `resourceCalendar.test.ts` | Conflict detected for overlapping slot; no conflict for free slot |
| `schedulingService.test.ts` | Happy path: DB updated, state → Scheduled, SIU logged; conflict throws; wrong-state referral throws |
