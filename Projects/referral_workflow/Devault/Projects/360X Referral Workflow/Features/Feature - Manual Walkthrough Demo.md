---
title: Feature - Manual Walkthrough Demo
tags: [feature, demo]
aliases: [Walkthrough Demo]
up: "[[📋 PRD Index]]"
---

# Manual Walkthrough Demo

**Status:** In Progress  
**Team:** Will Joslin  
**Epic:** [[📋 PRD Index]]  
**Priority:** High

### Context

The 360X Referral Workflow system now covers every major step in the referral lifecycle — prior authorization (PRD-12), referral intake and disposition (PRD-01/02), scheduling and encounter (PRD-03/05), consult note generation (PRD-04), loop closure (PRD-06), skills/rules engine (PRD-09), and claims attachment (CMS-0053-F). 

The existing Demo Launcher runs automated scripts that advance most state transitions invisibly — the user only manually clicks "Accept" on the review page. This is useful for showing the full pipeline quickly, but it bypasses all the individual UI interactions and intermediate states that demonstrate the system's real depth.

A guided walkthrough demo is needed that puts the presenter in full control of every click, allowing them to navigate through each screen and manually trigger every state transition across all seven workflow paths.

---

### Goal

- Give presenters a single guided page at `/demo/walkthrough` that sequences every UI interaction and state transition in the system
- Cover all 7 distinct workflow paths including happy path, PA denial/retry, async pend, referral decline, pending-information, no-show/reschedule, and claims attachment
- Replace automated mock-script steps with manual trigger buttons so nothing advances without a deliberate presenter action
- Pre-seed appropriate test data for each path so setup is instant

---

### User Stories

- As a presenter, I want a step-by-step guided page so that I can click through the entire referral workflow without knowing the internal URL structure.
- As a presenter, I want manual trigger buttons for automated steps (e.g., "Simulate Referrer ACK") so that I control the timing of every state transition.
- As a presenter, I want each step to show a checkmark when complete so that I can see my progress and recover from interruptions.
- As a presenter, I want a "Reset Demo" button so that I can start a fresh walkthrough without restarting the server.

---

### Acceptance Criteria

- **AC1:** `/demo/walkthrough` page exists and is accessible from the nav.
- **AC2:** "Reset Demo" seeds fresh patients and referrals for all 7 paths and returns IDs used by the step links.
- **AC3:** Each step shows a live completion indicator that resolves when the referral/PA reaches the expected state.
- **AC4:** All state transitions are reachable via this page — no state is skipped or only reachable via automated scripts.
- **AC5:** "Simulate Referrer ACK" button transitions a `Closed` referral to `Closed-Confirmed`.
- **AC6:** "Simulate Info Reply" button transitions a `Pending-Information` referral to `Acknowledged`.
- **AC7:** "Inject 277 Request" button inserts a claims attachment request into the DB and it appears in the claims queue.
- **AC8:** TypeScript compiles clean and lint passes with no new errors.

---

## Technical Specifications

### Dependencies

- No new npm packages — uses existing Express, Drizzle ORM, and existing service functions.

### Engineering Constraints

- All trigger endpoints under `/demo/walkthrough/` — clearly namespaced so they are obviously demo-only and not part of production API surface.
- The walkthrough page must not break or interfere with the existing Demo Launcher or any existing routes.
- Seed data uses distinct patient names (e.g., "WalkA Patient") to avoid collisions with other demo data.

### Deliverables

- `src/views/demoWalkthrough.html` — guided walkthrough UI with 7 path cards, step links, trigger buttons, and live completion indicators
- New routes in `src/server.ts`:
  - `GET /demo/walkthrough` — serve page
  - `POST /demo/walkthrough/seed` — seed all path data, return IDs
  - `POST /demo/walkthrough/ack/:referralId` — simulate referrer ACK (`Closed → Closed-Confirmed`)
  - `POST /demo/walkthrough/info-reply/:referralId` — simulate info reply (`Pending-Information → Acknowledged`)
  - `POST /demo/walkthrough/inject-277` — insert 277 claim attachment request into DB
- Nav link: "Walkthrough" added alongside "Demo Launcher" in shared nav

### The 7 Paths

| Path | Name | Key Interactions | Terminal State |
|------|------|-----------------|----------------|
| A | PA + Full Happy Path | PA form → Approve → Accept → Schedule → Encounter → Consult Note → ACK | Closed-Confirmed |
| B | PA Denied → Resubmit | PA (denied) → Resubmit → Approve | PA: Approved |
| C | PA Pended → Async | PA (pended) → watch poll | PA: Approved |
| D | Referral Declined | Review → Decline | Declined |
| E | Pending Info → Resolved | Trigger info reply → Accept | Accepted |
| F | No-Show & Reschedule | Mark no-show → new appointment | Scheduled |
| G | Claims Attachment | Inject 277 → view → send 275 | Sent |

### Seed Data per Path

| Path | Seeded Data |
|------|------------|
| A | Patient + referral in `Acknowledged` state with full clinical data |
| B/C | Patient only (PA submitted live) |
| D | Patient + referral in `Acknowledged` state |
| E | Patient + referral in `Pending-Information` state |
| F | Patient + referral in `Scheduled` state with past appointment |
| G | Patient only (277 injected via trigger) |

### Test Plan

- **Manual:** Walk through all 7 paths end-to-end and confirm all state transitions complete
- **Compile:** `npm run build` exits 0
- **Lint:** `npm run lint` exits 0 with no new errors

---

## Related Documents

- [[PRD-12 - Prior Authorization]]
- [[📋 PRD Index]]

---
