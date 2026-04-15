---
title: Referral Row Preview Dropdown
tags: [feature, dashboard, ux]
up: "[[_INDEX]]"
---

## Referral Row Preview Dropdown

**Status:** In Progress
**Team:** Engineering
**Epic:** Dashboard UX Improvements
**Priority:** Medium

### Context

The dashboard home page displays referrals as a flat table where clicking any row navigates away to the full review page. Coordinators triaging a queue have no way to quickly assess a referral without losing their list context. Every "peek" at a referral requires a full page load and back-navigation, which fragments the triage workflow.

This feature adds an inline expandable preview row beneath each referral in the dashboard table, surfacing the most clinically relevant details and the next-step action button. For most states, the user can take the next action directly from the dashboard without navigating away.

---

### Goal

- Allow coordinators to preview referral details inline on the dashboard without navigating to the full review page.
- Expose the state-appropriate next-step action (Accept/Decline, Schedule, No-Show, Consult, Confirm) directly in the preview row.
- Improve the table's visual clarity so row boundaries are immediately obvious.

---

### User Stories

- As a care coordinator, I want to expand a referral row to see patient demographics, clinical info, and prior auth status so that I can triage the queue without leaving the dashboard.
- As a care coordinator, I want to accept or decline a referral directly from the dashboard row so that I can action the queue without opening each referral individually.
- As a care coordinator, I want the referral ID to be a direct hyperlink to the full review page so that I can jump straight there when I need more detail.

---

### Acceptance Criteria

- **AC1:** Clicking anywhere on a referral row (except the referral # link) expands an inline preview below that row; clicking again collapses it.
- **AC2:** The referral # in each row is a hyperlink that navigates directly to `/referrals/:id/review` without triggering the row expand.
- **AC3:** Row borders are visually distinct (2px solid separator) so the table is easy to scan.
- **AC4:** The preview panel displays: current state badge, patient demographics, referral details, most recent prior authorization, clinical information (truncated), and routing suggestion (AI summary + department).
- **AC5:** A state-appropriate action form is shown at the bottom of the preview: Accept/Decline for Acknowledged, inline schedule form for Accepted, Mark No-Show for Scheduled, Request Consultation for Encounter, Confirm Consultation for Consult.
- **AC6:** Submitting an action from the preview reloads the dashboard row with the updated state without requiring manual navigation.
- **AC7:** Detail data is fetched lazily on first expand and cached; subsequent expands/collapses are instant with no network request.
- **AC8:** The inline schedule form includes Date & Time, Location (dropdown), and Provider (text) — all required fields — matching the existing `/referrals/:id/schedule` POST API.

---

## Technical Specifications

### Dependencies

- No new npm packages required.
- Reuses existing `getResources()` from `src/modules/prd03/resourceCalendar.ts` for the location dropdown.
- Reuses existing `priorAuthRequests` table query pattern from `src/server.ts`.

### Engineering Constraints

- Must not change any database schema.
- Client-side code must remain vanilla JS (no React/Vue/framework).
- The preview API endpoint is read-only; no side effects.

### New API Endpoint

`GET /api/referrals/:id/preview`

Returns:
```json
{
  "referral": { "id", "state", "reasonForReferral", "referrerAddress", "declineReason", "createdAt", "routingDepartment", "aiAssessment", "clinicalData", "appointmentDate", "appointmentLocation", "scheduledProvider" },
  "patient": { "firstName", "lastName", "dateOfBirth" },
  "priorAuth": { "id", "state", "insurerName", "serviceCode", "serviceDisplay", "createdAt" } | null,
  "resources": [{ "id", "name", "department" }]
}
```

Returns 404 `{ "error": "Not found" }` if referral does not exist.

### Files Modified

| File | Change |
|------|--------|
| `src/server.ts` | Add `GET /api/referrals/:id/preview` endpoint |
| `src/views/dashboard.html` | Row UX, borders, expand/collapse logic, `renderPreview()`, `renderActionSection()` |

### Test Plan

- **Manual:** Seed demo data (`npm run seed`), start dev server (`npm run dev`), verify each AC against the running UI.
- **Regression:** `npm test` — all existing unit tests must continue to pass (no logic changed, only new read-only endpoint + view layer).
- **Edge Cases:** Referral with no prior auth (priorAuth = null), referral with no clinical data (clinicalData = null), referral with no AI assessment (aiAssessment = null), terminal state rows (Declined, Closed-Confirmed).

### Deliverables

- `GET /api/referrals/:id/preview` endpoint in `src/server.ts`
- Updated `src/views/dashboard.html` with inline expand/preview/action UX
- This feature doc

---

## Design Notes

Preview panel layout (2-column grid):

```
┌─────────────────────────────────────────────────────┐
│  Current State: [Acknowledged]  Dept: Cardiology     │
├──────────────────────┬──────────────────────────────┤
│ Patient Demographics │ Referral Details              │
│  Name, DOB           │  Reason, Referrer, Date       │
├──────────────────────┼──────────────────────────────┤
│ Prior Authorization  │ Routing Suggestion            │
│  Insurer, Code, State│  AI summary, dept             │
├──────────────────────┴──────────────────────────────┤
│ Clinical Information                                  │
│  Problems | Allergies | Medications | Results         │
├─────────────────────────────────────────────────────┤
│ [ACTION SECTION — state-dependent inline form]       │
└─────────────────────────────────────────────────────┘
```

---

## Related Documents

- [[../Ideas|Ideas & Backlog]]
- [[In Progress|In Progress Work]]
- [[PRD-02 Process and Disposition Referral]]
- [[PRD-03 Schedule Patient and Notify Referrer]]
