---
title: Feature - No-Show & Consult Demo Scenarios
tags: [feature, demo, prd11]
aliases: [No-Show Demo, Consult Demo, Demo Workflows]
up: "[[📋 PRD Index]]"
---

## No-Show & Consult Demo Scenarios

**Status:** Ready for Dev  
**Team:** Full-Stack  
**Epic:** Demo Experience  
**Priority:** High

### Context

PRD-11 implemented the `No-Show` and `Consult` states in the state machine along with their services and UI cards (`noShowCard`, `rescheduleCard`, `consultRequestCard`, `consultConfirmCard`). However, the Demo Launcher has no scenarios that drive a referral into these states. The existing mock cascade (accept → schedule → encounter) automatically advances past `Scheduled` before the clinician can interact with the No-Show UI, making both states invisible in demos.

This feature adds two new demo scenarios to the Demo Launcher that showcase each of these states with real interactable UI, and extends the `Consult` state to support medication enrichment (via FHIR or manual entry) as the resolution action.

---

### Goal

- Add a **No-Show demo** that lands a referral at `Scheduled` state (appointment in the past), lets the clinician mark it as a no-show, and then reschedule via the existing scheduling form.
- Add a **Consult demo** that lands a referral at `Consult` state with a specialist note requesting medication history, and lets the clinician resolve it by fetching medications from FHIR or entering them manually.

---

### User Stories

- As a demo presenter, I want to launch a no-show scenario so that I can show what happens when a patient misses their appointment and how the referral is rescheduled.
- As a demo presenter, I want to launch a consult scenario so that I can demonstrate the specialist consultation request flow and the FHIR medication lookup feature.
- As a clinician using the app, I want to see a consultation note from the specialist explaining what additional information is needed so that I know how to resolve the consult before the referral can close.
- As a clinician, I want to be able to fetch the patient's medication history from FHIR or enter it manually when resolving a consultation request so that I can provide the specialist with the needed information.

---

### Acceptance Criteria

- **AC1:** The Demo Launcher shows two new scenario cards — "No-Show" and "Consult" — styled with distinct colors alongside the existing four.
- **AC2:** Launching the No-Show scenario produces a referral at `Scheduled` state with an appointment date in the past; the `noShowCard` is visible on the review page.
- **AC3:** Clicking "Mark No-Show" transitions the referral to `No-Show`; the `rescheduleCard` appears with the "Schedule New Appointment" link; clicking it opens the scheduling form; submitting transitions back to `Scheduled`.
- **AC4:** Launching the Consult scenario produces a referral at `Consult` state with a specialist consultation request note stored in `clinicalData.consultRequest`; that note is displayed in the `consultConfirmCard`.
- **AC5:** The `consultConfirmCard` shows two enrichment options: "Fetch Medications from FHIR" (calls `GET /referrals/:id/fhir-medications`) and "Enter Medications Manually" (textarea + save button, calls `POST /referrals/:id/medications`).
- **AC6:** `GET /referrals/:id/fhir-medications` searches FHIR by patient name + DOB and returns `{ fhirPatientId, medications }`; if no match is found, the UI displays a clear "No FHIR match" message and prompts manual entry.
- **AC7:** `POST /referrals/:id/medications` accepts `{ medications: string[], source: 'fhir' | 'manual' }` and persists the medication list into `referral.clinicalData`; returns `{ success: true }`.
- **AC8:** After saving medications (either path), the clinician can enter a Clinician ID and click "Confirm Consultation" to transition the referral to `Closed`.
- **AC9:** The Consult demo fixture (demo-consult.xml) uses Michael Kihn demographics (matching the public HAPI FHIR sandbox) so the FHIR medication lookup returns results.

---

## Technical Specifications

### Dependencies

- `src/modules/prd08/fhirClient.ts` — reuse `searchPatient()` and `getMedications()` for the FHIR lookup route; no new dependencies.
- `src/modules/prd11/` — existing `noShowService.ts` and `consultService.ts` handle the state transitions; no changes required.

### Engineering Constraints

- Both demo scenario functions (`launchNoShow`, `launchConsult`) must **bypass the mock cascade** (accept → schedule → encounter) by directly updating the DB to the target state. This is required because `schedulingService.scheduleReferral()` non-blockingly fires `mockEncounter`, which would skip past the states the demos need to show. Pattern follows the existing payer-rejection scenario.
- The `GET /referrals/:id/fhir-medications` route reads patient name + DOB from the `patients` table and queries FHIR; it does not modify DB state.
- Medications saved via `POST /referrals/:id/medications` are persisted as `EnrichedClinicalItem[]`-shaped objects in `referral.clinicalData.medications` (consistent with the enrichment schema from PRD-08).

### Test Plan

- **Unit Tests:** Test `GET /referrals/:id/fhir-medications` returns 200 with medications array and 404 for invalid referral; test `POST /referrals/:id/medications` with both sources correctly updates `clinicalData`.
- **Integration Tests:** Launch no-show scenario → verify referral state = Scheduled → mark no-show → verify state = No-Show → reschedule → verify state = Scheduled. Launch consult scenario → verify state = Consult and consultRequest note present → save medications (FHIR or manual) → confirm consultation → verify state = Closed.
- **Edge Cases:** FHIR server unavailable or returns no match for medication lookup; manual medication entry with empty textarea; attempting to confirm consultation before saving medications.

### Deliverables

- `tests/fixtures/demo-no-show.xml` — Complete C-CDA for Jordan Davis (DOB 1988-03-14).
- `tests/fixtures/demo-consult.xml` — C-CDA for Michael Kihn (matching HAPI FHIR demographics) with medications section intentionally omitted.
- `src/demoScenarios.ts` — `launchNoShow()` and `launchConsult()` functions.
- `src/server.ts` — Wire new scenarios in `POST /demo/launch`; add `GET /referrals/:id/fhir-medications` and `POST /referrals/:id/medications` routes.
- `src/views/referralReview.html` — Enhanced `consultConfirmCard`: consultation request note, FHIR fetch section, manual entry section.
- `src/views/demoLauncher.html` — Two new scenario cards (orange for No-Show, purple for Consult).

---

## Design Notes

**No-Show demo flow:**
```
Demo Launcher → [Launch No-Show] → Referral at Scheduled state
  ↓ noShowCard visible
[Mark No-Show] → state = No-Show → rescheduleCard visible
[Schedule New Appointment] → /referrals/:id/schedule form
[Submit] → state = Scheduled
```

**Consult demo flow:**
```
Demo Launcher → [Launch Consult] → Referral at Consult state
  consultConfirmCard shows:
    "Specialist Note: requires complete medication history..."
    [Option 1] Query FHIR Record → shows medications list → [Save FHIR Medications]
    [Option 2] textarea → [Save Manual Medications]
  [Confirm Consultation] (with Clinician ID) → state = Closed
```

---

## Related Documents

- [[PRD-11 - No-Show & Consult States]]
- [[Feature - Demo Launcher Message Preview]]
- [[📋 PRD Index]]
