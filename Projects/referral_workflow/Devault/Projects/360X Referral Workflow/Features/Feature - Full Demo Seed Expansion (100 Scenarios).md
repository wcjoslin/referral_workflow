---
title: Feature - Full Demo Seed Expansion (100 Scenarios)
tags: [feature, demo, seed, analytics]
up: "[[📋 PRD Index]]"
---

## Full Demo Seed Expansion — 100 Referral Scenarios

**Status:** Ready for Dev  
**Team:** Engineering  
**Epic:** [[PRD-15 - Analytics Agent AI]] (prerequisite)  
**Priority:** High

### Context

The current `seed:full-demo` script produces 20 referrals. While sufficient to demonstrate the analytics dashboard exists, the dataset is too sparse for the Analytics Agent (PRD-15) to surface meaningful patterns. A real specialist clinic handles 100+ referrals per day. The agent's anomaly-detection thresholds require minimum cluster sizes (e.g., ≥4 denials from the same clinician×department combination) before a pattern is flagged as meaningful rather than noise.

This feature expands the seed script to 100 scenarios, with deliberate concentration of specific patterns to ensure the agent has enough signal to generate actionable findings.

---

### Goal

- Expand `scripts/seed-full-demo.ts` from 20 → 100 scenarios
- Introduce concentrated patterns that cross anomaly thresholds for all 4 detection types
- Maintain full document authenticity — all scenarios still run through real fixture ingestion
- Remain idempotent — re-run clears and re-inserts cleanly

---

### User Stories

- As a demo presenter, I want the analytics dashboard to show realistic volume and variety so that it feels like a production system rather than a toy.
- As the Analytics Agent, I need cluster sizes above threshold so that I can generate findings rather than reporting "no patterns detected."
- As a developer, I want the seed script to be idempotent so that I can re-run it at any time without manual DB cleanup.

---

### Acceptance Criteria

- **AC1:** `npm run seed:full-demo` completes successfully and inserts exactly 100 referrals (clears previous seed data first).
- **AC2:** After seeding, `SELECT clinician_id, routing_department, COUNT(*) FROM referrals WHERE state='Declined' GROUP BY clinician_id, routing_department` shows dr-kim/Neurology ≥9 and dr-rodriguez/Oncology ≥7.
- **AC3:** After seeding, `SELECT insurer_name, service_code, COUNT(*) FROM prior_auth_requests par JOIN prior_auth_responses resp ON resp.request_id=par.id WHERE resp.outcome='denied' GROUP BY insurer_name, service_code` shows Aetna/93306 ≥11.
- **AC4:** After seeding, `SELECT routing_department, COUNT(*) FROM referrals WHERE state='No-Show' GROUP BY routing_department` shows Cardiology ≥10.
- **AC5:** After seeding, `SELECT referrer_address, COUNT(*) FROM referrals WHERE state='Pending-Information' GROUP BY referrer_address` shows at least one address with ≥6.
- **AC6:** `npx tsc --noEmit` passes with zero errors after changes.

---

## Technical Specifications

### Target Scenario Distribution (100 total)

| # Range | Pattern | Dept | Clinician | End State | Count |
|---|---|---|---|---|---|
| 1–20 | Existing scenarios | varied | varied | varied | 20 |
| 21–29 | Denial cluster A | Neurology | dr-kim | Declined ("Insufficient clinical information") | 9 |
| 30–36 | Denial cluster B | Oncology | dr-rodriguez | Declined ("Patient does not meet criteria") | 7 |
| 37–47 | PA denial pattern | Cardiology | varied | Scheduled + PA Denied (Aetna/echocardiography 93306) | 11 |
| 48–57 | No-show cluster | Cardiology | varied | No-Show | 10 |
| 58–63 | Pending-info cluster | Gastroenterology | dr-rodriguez | Pending-Information (same referrer address) | 6 |
| 64–83 | Happy-path baseline | varied | varied | Closed-Confirmed | 20 |
| 84–93 | In-progress | varied | varied | Scheduled (future appt) | 10 |
| 94–100 | Stalled | varied | varied | Encounter | 7 |

**Total concentrated patterns:**
- Denial cluster: 9 + 7 = 16 declines with clear clinician×dept concentration
- PA denial pattern: 11 Aetna/echocardiography denials
- No-show cluster: 10 Cardiology no-shows
- Pending-info cluster: 6 same-referrer pending-info requests
- Happy-path baseline: 30+ Closed-Confirmed (existing 10 + 20 new)

### Engineering Constraints

- Scenarios run sequentially to avoid SQLite write contention
- 4-second wait after all scenarios before re-applying departments (same pattern as current script — wins race against Claude's background routing assessment)
- All new scenarios use existing fixtures (`demo-full-workflow.xml`, `demo-no-show.xml`, `demo-incomplete-info.xml`) — no new fixtures needed
- PA denial scenarios (37–47) use Aetna as insurer + service code 93306 (echocardiography) for signal concentration
- Pending-info scenarios (58–63) use a fixed referrer address `dr-incomplete@referring.direct` to trigger the pending-info cluster query

### Deliverables

- Modified `scripts/seed-full-demo.ts` — expanded `SCENARIOS` array from 20 → 100 entries
- No other files modified

### Dependencies

- No new dependencies
- Prerequisite for [[PRD-15 - Analytics Agent AI]] — agent needs this data to surface findings

---

## Related Documents

- [[📋 PRD Index|PRD Index]]
- [[PRD-15 - Analytics Agent AI|PRD-15: Analytics Agent AI (consumer of this data)]]
- [[PRD-14 - Analytics Agent (Phase 2)|PRD-14 Phase 2: Analytics Dashboard (existing seed script lives here)]]

---

## History

**Created:** 2026-04-12  
**Last Updated:** 2026-04-12  
**Version:** 1.0
