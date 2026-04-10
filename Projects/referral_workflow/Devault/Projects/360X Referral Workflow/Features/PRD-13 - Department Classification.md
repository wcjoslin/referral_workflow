---
up: "[[📋 PRD Index]]"
prev: "[[PRD-12 - Prior Authorization]]"
---

# PRD-13: Department Classification & Administrative Routing

**Status:** Drafting  
**Team:** Clinical Workflow & Disposition  
**Module:** `prd02/`

---

## Overview

### Context

The existing AI step in PRD-02 performs a clinical "sufficiency" assessment — evaluating whether the referral has enough clinical information for a specialist to act on. In practice, clinicians — not AI — should make clinical judgements. The AI's highest-value contribution is in **administrative triage**: helping coordinators route referrals to the right department, identify what equipment will be needed, and quickly understand what care is being requested.

This PRD repurposes the AI assessment into an **administrative routing assistant**. It reads the inbound C-CDA (Reason for Referral, Chief Complaint, problems, medications, diagnostic results) and emits a department classification, required equipment list, and a plain-language care-request summary. The assessment remains strictly advisory — it never auto-declines a referral. Coordinators can always override the AI's suggestion via the review screen.

### Goal

The primary goal of this feature is to:
1. **Route referrals to the correct department** based on free-text fields and clinical context clues, so coordinators know which queue each referral belongs to
2. **Surface required equipment and diagnostic resources** so coordinators can verify availability before accepting
3. **Provide a succinct care-request summary** at the top of the review screen so coordinators can triage in seconds

### Scope

**In Scope:**
- Department/equipment/summary extraction via Gemini 2.5 Flash
- Extending `resourceCalendar` with a `department` field per resource
- Surfacing routing results on the referral review screen with editable controls
- Department badge and filter dropdown on the inbox/dashboard view
- Unsupported-department and unsupported-equipment warnings
- Manual override of department and equipment (persisted per referral)
- Unit tests for routing classification and override endpoint

**Out of Scope:**
- Auto-decline based on routing classification
- Actual equipment booking at disposition time (still happens in PRD-03 at scheduling)
- Learning from clinician overrides to improve future classification accuracy
- Multi-tenant or multi-facility configurations
- Clinical decision support (the AI stays in an administrative lane)

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want incoming referrals routed to the proper queue so I know what facilities are necessary to care for the patient

**AC1:** Every newly ingested referral receives a `RoutingAssessment` with a `department` value drawn from the facility catalogue.  
**AC2:** The inbox view shows a department badge on each referral row.  
**AC3:** The inbox view offers a department filter dropdown that narrows the list to a single department.  
**AC4:** If Gemini returns a department name not present in the facility catalogue, the referral is tagged `department: "Unassigned"` and a warning badge is shown.

### As a care coordinator, I want to know what facilities are necessary for the patient care so I can check if they are available at the requested time and make a good accept/deny decision

**AC1:** The routing assessment includes a `requiredEquipment` array of resource IDs from `resourceCalendar`.  
**AC2:** The referral review screen lists each required resource by human name.  
**AC3:** If Gemini names equipment not present in the catalogue, it is shown in an "unsupported" subsection with a warning indicator.  
**AC4:** The assessment never auto-declines based on unsupported equipment — the coordinator still clicks Accept/Decline.

### As a care coordinator, I want to know what the request is from the referral so I can decide if my facility is able to handle the request in the first place

**AC1:** The routing assessment includes a 1–2 sentence plain-language `summary` describing the care request.  
**AC2:** The summary is shown as the first element on the referral review screen, above the parsed C-CDA sections.  
**AC3:** If Gemini fails or returns malformed JSON, the stored department defaults to `"Unassigned"`, the panel shows "Routing suggestion unavailable", and the rest of the review screen still works.

### As a care coordinator, I want to correct the AI's routing when it's wrong

**AC1:** The Routing panel always shows an editable department dropdown (populated from the facility catalogue plus "Unassigned"), regardless of whether the AI assessment succeeded.  
**AC2:** Changing the department persists the new value to the referral record and updates the inbox badge on next load.  
**AC3:** The override is tracked — the referral record stores both the AI-suggested department (in `aiAssessment`) and the final (possibly human-corrected) department (in `routingDepartment`), so future analytics can measure AI accuracy.  
**AC4:** The manual override control is also available for the `requiredEquipment` list (add/remove equipment from the facility catalogue).

---

## Technical Specifications

### Dependencies

- `@google/generative-ai` — already in use; prompt is rewritten, no new dependency
- No new packages required

### Engineering Constraints

- The Gemini call remains non-blocking and background-fired — the review page renders even while the assessment is in-flight, and `routingDepartment` defaults to `"Unassigned"` until Gemini returns
- The inbox filter dropdown is client-side to avoid changes to the existing data flow
- Manual overrides persist immediately to the database and survive restarts
- The AI's original suggestion is never mutated by an override — `aiAssessment` is the immutable audit trail; `routingDepartment` / `routingEquipment` hold the effective routing

### Data Models

**RoutingAssessment** (replaces `SufficiencyAssessment`):

```typescript
interface RoutingAssessment {
  department: string;                  // from facility catalogue, or "Unassigned"
  departmentConfidence: number;        // 0.0 – 1.0
  requiredEquipment: Array<{
    resourceId: string;                // matches Resource.id from resourceCalendar
    name: string;                      // human label
    supported: boolean;                // false if not in catalogue
  }>;
  summary: string;                     // 1–2 sentence care-request summary
  warnings: string[];                  // e.g. "Department 'Oncology' not offered"
}
```

**Resource** (extended with `department`):

```typescript
interface Resource {
  id: string;
  name: string;
  department: string;    // e.g. "Cardiology", "Imaging", "General"
  blockedSlots: TimeSlot[];
}
```

**New DB columns on `referrals`:**

- `routing_department TEXT NOT NULL DEFAULT 'Unassigned'` — effective department, editable
- `routing_equipment TEXT` — JSON array of resource IDs, editable

### API Design

**Override routing:**

`POST /api/referrals/:id/routing`

Request:
```json
{
  "department": "Cardiology",
  "equipment": ["echo-lab", "stress-test-room"]
}
```

Response:
```json
{
  "success": true,
  "routingDepartment": "Cardiology",
  "routingEquipment": "[\"echo-lab\",\"stress-test-room\"]"
}
```

---

## Test Plan

**Unit Tests:**
- Classifies a cardiology referral into the Cardiology department with echo-lab in requiredEquipment
- Marks equipment Gemini hallucinated (not in catalogue) as `supported: false` and adds a warning
- Sets `department: "Unassigned"` + warning when Gemini returns an unknown department
- Returns fallback with `department: "Unassigned"` on malformed JSON
- Returns fallback with `department: "Unassigned"` when `GEMINI_API_KEY` is unset
- `getDepartments()` returns the sorted unique list including all seeded departments

**Integration Tests:**
- `npm run seed && npm run dev` → open `localhost:3001`, routing panel populates within ~3s
- Inbox shows department badge; filter dropdown narrows the list
- Changing department via dropdown persists and shows on next inbox load

**Edge Cases:**
- Empty Reason for Referral → Gemini infers from problems/medications
- Unknown department from Gemini → "Unassigned" + warning, no crash
- Unknown equipment ID from Gemini → marked unsupported, no crash

---

## Deliverables

- Modified `src/modules/prd02/claudeService.ts` — new interface, rewritten prompt, catalogue-aware post-processing
- Modified `src/modules/prd02/referralService.ts` — type rename, cache update, routing column writes
- Modified `src/modules/prd03/resourceCalendar.ts` — `department` field + `getDepartments()` helper + broader seed data
- Modified `src/db/schema.ts` — `routingDepartment` and `routingEquipment` columns
- Modified `src/server.ts` — routing override endpoint + department data in routes
- Modified `src/views/referralReview.html` — Routing panel with editable controls
- Modified `src/views/dashboard.html` — department badge column + filter dropdown
- Rewritten `tests/unit/prd02/claudeService.test.ts`
- Updated `tests/unit/prd03/resourceCalendar.test.ts`

---

## Related Documents

- [[📋 PRD Index|See all PRDs]]
- [[PRD-02 - Process & Disposition|PRD-02: Process & Disposition (modified by this PRD)]]
- [[PRD-03 - Schedule Patient|PRD-03: Schedule Patient (resource catalogue extended)]]

---

## History

**Created:** 2026-04-09  
**Last Updated:** 2026-04-09  
**Version:** 1.0
