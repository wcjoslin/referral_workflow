---
title: Feature - Demo Launcher Message Preview
tags: [feature, demo, ui]
aliases: [Demo Launcher C-CDA Preview]
up: "[[📋 PRD Index]]"
---

## Demo Launcher Message Preview

**Status:** Approved ✅  
**Team:** Frontend / Full-Stack  
**Epic:** Demo Experience  
**Priority:** High

### Context

The Demo Launcher page presents four pre-canned referral scenarios via a grid of launch cards. Each scenario is clearly labeled with its expected outcome, but the page gives no visibility into the actual Direct message and C-CDA document that is transmitted to kick off the workflow. Clinicians and technical evaluators demoing the system have no way to understand what clinical data is being sent — they see only the launch button and a state progression log.

This creates a gap in the demo narrative: the most interesting artifact (the inbound referral document) is invisible until the workflow is already running. The fix is to show the envelope metadata and C-CDA content inline alongside each scenario card, before launch.

---

### Goal

- Give demo viewers clear visibility into the Direct message envelope (From, To, Subject, Attachment) that initiates each scenario.
- Surface the actual C-CDA document content using the `@kno2/ccdaview` viewer (per PRD-10) so reviewers can see patient, problems, medications, and clinical narrative before and after launch.
- Redesign the page layout from a 2×2 grid of opaque launch cards to a vertical list of two-column rows where scenarios and their message previews are side-by-side.

---

### User Stories

- As a demo viewer, I want to see what Direct message and C-CDA file is being sent for each scenario so that I can understand the input before the workflow runs.
- As a demo presenter, I want the C-CDA document to be rendered in a readable viewer alongside the scenario card so that I can walk through the clinical content during a demo.
- As a developer, I want the C-CDA viewer on this page to use the same `@kno2/ccdaview` component specified in PRD-10 so that implementation is consistent across the application.

---

### Acceptance Criteria

- **AC1:** The Demo Launcher page displays 4 scenario rows stacked vertically (not a 2×2 grid), each row containing a scenario card (left) and a message preview panel (right).
- **AC2:** Each message preview panel shows the Direct message envelope: From, To, Subject, and Attachment filename.
- **AC3:** Each message preview panel includes a rendered C-CDA viewer (`@kno2/ccdaview` `<sialia>` component) loading the corresponding fixture XML via `GET /demo/fixture/:scenario`.
- **AC4:** The per-scenario log panel (SSE state transitions) is shown inline within the scenario card after launch, not as a shared bottom panel.
- **AC5:** The fixture endpoint `GET /demo/fixture/:scenario` returns the correct XML file with `Content-Type: text/html; charset=utf-8` (required by ccdaview).
- **AC6:** Launching one scenario disables all four launch buttons; buttons re-enable when the terminal state is reached.

---

## Technical Specifications

### Dependencies

- `@kno2/ccdaview` (^2.0.2) — Riot.js-based C-CDA structured document viewer; renders as `<sialia src="...">` custom element. Aligned with PRD-10.
- `bootstrap` (^4.x) — Peer dependency required by ccdaview; served as static files.
- `jquery` (^3.x) — Peer dependency for Bootstrap 4 and ccdaview; served as static files.

### Engineering Constraints

- Static vendor bundles served from `node_modules/` via Express static routes (no build system change).
- Fixture XML files served via `GET /demo/fixture/:scenario` endpoint reading from `tests/fixtures/demo-{scenario}.xml`; path-traversal safe (allowlist of 4 valid scenario names).
- No changes to the SSE stream endpoint or the `POST /demo/launch` handler.
- Bootstrap 4 loaded only on the demo launcher page (not globally injected) to avoid conflicts with existing pages.

### Test Plan

- **Unit Tests:** Verify `GET /demo/fixture/:scenario` returns 200 with correct XML for valid scenarios and 404 for unknown scenarios.
- **Integration Tests:** Load demo launcher page → confirm 4 rows visible → confirm sialia components load their src URLs → launch scenario → confirm per-card log updates.
- **Edge Cases:** Invalid scenario name on fixture endpoint; ccdaview load failure (sialia not rendering); SSE stream closed before terminal state.

### Deliverables

- Updated `src/views/demoLauncher.html` — vertical two-column layout with email envelope preview and `<sialia>` C-CDA viewer per scenario.
- Updated `src/server.ts` — `GET /demo/fixture/:scenario` endpoint + static routes for ccdaview/bootstrap/jquery bundles.
- Installed npm packages: `@kno2/ccdaview`, `bootstrap`, `jquery`.

---

## Design Notes

**Page Layout (per scenario row):**
```
+--------------------------------+  +------------------------------------------+
| [Color-coded header]           |  | 📬 Direct Message                        |
| Scenario Title                 |  | FROM  Dr. Name <referrer@hospital.direct> |
| Patient · Specialty            |  | TO    receiving@specialist.direct         |
| Description                    |  | SUBJ  Referral — Demo Patient             |
| Expected outcome badge         |  | ATT   referral.xml  [C-CDA]               |
| [Launch →] button              |  +------------------------------------------+
| — — — — — — — — — — — — — — —|  | C-CDA Document (scrollable, ~450px)      |
| [State transition log, hidden  |  | <sialia src="/demo/fixture/scenario">    |
|  until launched]               |  | (Patient, Problems, Meds, Allergies...)  |
+--------------------------------+  +------------------------------------------+
```

---

## Related Documents

- [[PRD-10 - UI Modernization & CCDA Viewer]]
- [[📋 PRD Index]]
- [[../Backlog & Ideas/In Progress]]
