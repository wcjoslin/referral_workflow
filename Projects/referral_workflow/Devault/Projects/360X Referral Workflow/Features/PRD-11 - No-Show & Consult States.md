---
up: "[[📋 PRD Index]]"
same: "[[PRD-10 - UI Modernization & CCDA Viewer]]"
---

# PRD-11: No-Show & Consult States

**Status:** Ready for Dev  
**Team:** Clinical Workflow & State Management  
**Module:** `prd11/`

---

## Overview

### Context

This document introduces two new states to the 360X Closed Loop Referral lifecycle that were not covered in earlier PRDs: **No-Show** and **Consult**.

The current workflow assumes that once an appointment is scheduled, the patient will attend and the encounter will proceed normally through to closure. In practice, patients sometimes fail to appear for their scheduled specialist visit, and specialists sometimes need to engage in further consultation with the referring provider before the referral can be considered complete.

Without explicit handling for these scenarios, the workflow has no mechanism to notify the referring physician of a missed appointment, prompt rescheduling, or pause closure pending a specialist-to-referrer consultation.

### Goal

- Add a **No-Show** state that is reachable from **Scheduled**, enabling the system to notify the referring physician that the patient did not attend, and allowing a new appointment to be booked using the existing referral document.
- Add a **Consult** state that is reachable from **Encounter**, enabling the specialist to flag that additional consultation with the referring provider is required before the loop can be closed. This state reintroduces a clinician-facing confirmation step before the referral proceeds to **Closed**.

---

## User Stories & Acceptance Criteria

### As a Clinician, I want to record that a patient did not show up for their appointment...

**AC1:** When a referral is in the `Scheduled` state, a "Mark No-Show" button must be visible on the referral detail page.

**AC2:** Clicking "Mark No-Show" must transition the referral state from `Scheduled` to `No-Show` and send a plain-text notification to the referring physician informing them that the patient did not attend.

**AC3:** The notification to the referring provider must include the patient name, the original appointment date/time, and the specialist's contact information.

**AC4:** The outbound notification must be logged in the `outboundMessages` table with `messageType = 'NoShowNotification'`.

### As a Clinician, I want to schedule a new appointment after a no-show...

**AC1:** When a referral is in the `No-Show` state, a "Schedule New Appointment" button must be visible at the bottom of the referral detail page (in the same location as the disposition decision card).

**AC2:** Clicking "Schedule New Appointment" must navigate the clinician to the existing appointment scheduling page (`/referrals/:id/schedule`), reusing the same form and workflow as the initial scheduling step.

**AC3:** Successfully scheduling a new appointment from the `No-Show` state must transition the referral back to `Scheduled`.

**AC4:** The original referral document (C-CDA data, reason for referral, patient demographics) must remain the source of truth — no new referral document is created.

### As a Specialist, I want to flag that further consultation is needed before closing the referral...

**AC1:** When a referral is in the `Encounter` state, a "Request Consultation" button must be visible on the referral detail page.

**AC2:** Clicking "Request Consultation" must transition the referral state from `Encounter` to `Consult` and send a notification to the referring provider that the specialist has requested further consultation.

**AC3:** The outbound notification must be logged in the `outboundMessages` table with `messageType = 'ConsultRequest'`.

### As a Referring Clinician, I want to confirm or resolve a consultation request...

**AC1:** When a referral is in the `Consult` state, a consultation confirmation card must be displayed on the referral detail page, in the same location as the original disposition decision card from the `Acknowledged` phase.

**AC2:** The consultation card must include a clinician ID input field and a "Confirm Consultation" button.

**AC3:** Clicking "Confirm Consultation" with a valid clinician ID must transition the referral from `Consult` to `Closed`.

**AC4:** The clinician ID and timestamp of the consultation confirmation must be recorded.

---

## Technical Specifications

### State Machine

New states added to `ReferralState` in `src/state/referralStateMachine.ts`:
- `NO_SHOW: 'No-Show'`
- `CONSULT: 'Consult'`

New transitions:
```
SCHEDULED   → [ENCOUNTER, NO_SHOW]
NO_SHOW     → [SCHEDULED]
ENCOUNTER   → [CLOSED, CONSULT]
CONSULT     → [CLOSED]
```

### Service Modules (`src/modules/prd11/`)

**`noShowService.ts`**
- `markNoShow(referralId: string): Promise<void>`
  - Validates state is `Scheduled`
  - Transitions to `No-Show`
  - Sends plain-text SMTP notification to `referral.referrerAddress`
  - Logs to `outboundMessages` with `messageType = 'NoShowNotification'`

**`consultService.ts`**
- `markConsult(referralId: string): Promise<void>`
  - Validates state is `Encounter`
  - Transitions to `Consult`
  - Sends SMTP notification to `referral.referrerAddress`
  - Logs to `outboundMessages` with `messageType = 'ConsultRequest'`
- `resolveConsult(referralId: string, clinicianId: string): Promise<void>`
  - Validates state is `Consult`
  - Transitions to `Closed`
  - Records clinician ID and timestamp

Both services follow the same pattern as `src/modules/prd05/encounterService.ts`.

### Scheduling Service Update

`src/modules/prd03/schedulingService.ts` must be updated to allow the `NO_SHOW → SCHEDULED` transition in addition to the existing `ACCEPTED → SCHEDULED` path. The existing `/referrals/:id/schedule` endpoint and form are reused with no UI changes.

### Server Routes (`src/server.ts`)

Three new POST endpoints:
- `POST /referrals/:id/no-show` — calls `markNoShow()`
- `POST /referrals/:id/consult` — calls `markConsult()`
- `POST /referrals/:id/consult/resolve` — calls `resolveConsult()` with `{ clinicianId }` body

### UI (`src/views/referralReview.html`)

- **Timeline:** Add `No-Show` and `Consult` step nodes; both are conditional (rendered based on whether the referral passed through those states)
- **`Scheduled` state:** Show "Mark No-Show" button (warning/orange style)
- **`No-Show` state:** Show "Schedule New Appointment" button (primary/blue style) linking to existing `/referrals/:id/schedule`
- **`Encounter` state:** Show "Request Consultation" button (secondary style)
- **`Consult` state:** Show consultation confirmation card (mirrors disposition card layout)

### Database

No schema changes required. `referrals.state` is a free-text field. Appointment fields (`appointmentDate`, `appointmentLocation`, `scheduledProvider`) are overwritten on reschedule after no-show.

### Test Plan

- **`tests/unit/prd11/noShowService.test.ts`** — happy path, invalid state transition error, DB/SMTP mocks
- **`tests/unit/prd11/consultService.test.ts`** — markConsult, resolveConsult, invalid state, mocks
- **`tests/unit/referralStateMachine.test.ts`** — extend existing tests to cover new states and transitions

### Engineering Constraints

- All state transitions must go through `transition()` in `referralStateMachine.ts` — no direct DB state writes
- SMTP transport must use the existing nodemailer configuration from `src/config.ts`
- No new npm dependencies

### Dependencies

- PRD-03 (Scheduling) — `scheduleReferral()` is reused for rescheduling after no-show
- PRD-05 (Encounter) — `Encounter` state is the entry point for `Consult`
- PRD-06 (Close Loop) — `Closed` state entered from both `Encounter` (existing) and `Consult` (new)

### Deliverables

- `src/state/referralStateMachine.ts` (updated)
- `src/modules/prd11/noShowService.ts` (new)
- `src/modules/prd11/consultService.ts` (new)
- `src/modules/prd03/schedulingService.ts` (updated)
- `src/server.ts` (updated)
- `src/views/referralReview.html` (updated)
- `tests/unit/prd11/noShowService.test.ts` (new)
- `tests/unit/prd11/consultService.test.ts` (new)

---

## Related Documents

- [[📋 PRD Index|See all PRDs]]
- [[PRD-03 - Schedule Patient|PRD-03: Schedule Patient]]
- [[PRD-05 - Patient Encounter|PRD-05: Patient Encounter]]
- [[PRD-06 - Close Loop|PRD-06: Close Loop]]