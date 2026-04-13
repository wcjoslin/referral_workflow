---
up: "[[📋 PRD Index]]"
prev: "[[PRD-14 - Analytics Agent (Phase 1)]]"
---

# PRD-14 (Phase 2): Analytics Agent — SQL Analytics Dashboard

**Status:** In Progress 🔧  
**Team:** Analytics & Insights  
**Module:** `analytics/`, `views/`, `scripts/`  
**Started:** 2026-04-11  
**Prerequisite:** [[PRD-14 - Analytics Agent (Phase 1)]] (unified event log)

---

## Context

Phase 1 established a unified `workflow_events` table capturing 30+ event types across all referral and prior-auth workflows. The data is there — but there's no way to visualise it. Workflow operators have no dashboard to answer questions like:

- "Which payers are denying the most prior auth requests?"
- "What is our referral acceptance rate this month?"
- "Which skills are firing most often? Are they matching?"
- "How long does a referral spend in each state on average?"

Phase 2 provides these answers as a **no-AI SQL dashboard**: deterministic aggregations over `workflow_events` and related tables, rendered with Chart.js. No agent required; pure data.

A large synthetic dataset (80 referrals, 15 prior auth requests, 40 skill evaluations across 90 days) is bundled as `seed:analytics` to demonstrate the dashboard's capabilities in a demo context.

---

## Goal

Implement a `/analytics` dashboard page that surfaces operational insights from the event log — KPIs, trend charts, outcome breakdowns, and skill effectiveness — using SQL aggregations only (no AI inference).

---

## User Stories

- As a **workflow coordinator**, I want to see today's KPIs (acceptance rate, avg days to close, PA approval rate) on a single page so I can gauge operational health at a glance.
- As a **workflow analyst**, I want to see a 30-day referral intake trend so I can identify volume spikes and seasonal patterns.
- As a **prior auth manager**, I want a breakdown of PA outcomes by payer so I can identify adversarial payers driving denials.
- As a **rules engine admin**, I want a skill effectiveness table (match rate, avg confidence per skill) so I can retire underperforming skills.
- As a **demo presenter**, I want a `seed:analytics` command that populates the database with realistic synthetic data so the dashboard shows meaningful charts.

---

## Acceptance Criteria

**AC1:** `/analytics` route returns HTTP 200 and renders a page with at least 4 KPI cards (Total Referrals, Acceptance Rate, Avg Days to Close, PA Approval Rate).

**AC2:** Daily intake line chart shows the last 30 days of `referral.received` events grouped by day.

**AC3:** State distribution bar chart shows counts for all referral states present in the database.

**AC4:** Prior auth outcomes doughnut chart shows approved / denied / pended / expired counts.

**AC5:** Denial reasons horizontal bar chart aggregates reasons from both `referral.declined` events (clinician declines) and `prior_auth.denied` events (payer denials) via `json_extract(metadata, '$.denialReason')`.

**AC6:** Skill match rates table shows each skill's evaluation count, match rate %, and avg confidence, sorted by evaluation count descending.

**AC7:** State timing table shows avg hours a referral spends per state transition, computed from consecutive events in `workflow_events`.

**AC8:** When `workflow_events` has fewer than 10 rows, an empty-state message is shown in place of charts ("Not enough data yet — run more referral workflows or use `npm run seed:analytics` to populate demo data.").

**AC9:** `npm run seed:analytics` inserts 80 patients, 80 referrals (realistic state distribution), 15 prior auth request/response pairs (3 payers), and 40 skill executions into a fresh database without errors.

**AC10:** Analytics query functions have unit tests with in-memory SQLite. KPI math is verified (acceptance rate, avg timing). Empty-dataset returns safe defaults (no divide-by-zero).

**AC11:** All existing tests pass (zero regressions).

---

## Technical Specifications

### New Files

**`src/modules/analytics/analyticsQueries.ts`**

Typed async query functions using Drizzle's `sql` template literal for `json_extract()` aggregations:

```typescript
export interface Kpis {
  totalReferrals: number;
  acceptanceRate: number;     // 0–100
  avgDaysToClose: number;
  paApprovalRate: number;     // 0–100
  noShowRate: number;         // 0–100
}

export async function getKpis(): Promise<Kpis> { ... }
export async function getReferralStateCounts(): Promise<{ state: string; count: number }[]> { ... }
export async function getDailyIntake(days: number): Promise<{ date: string; count: number }[]> { ... }
export async function getReferralFunnel(): Promise<{ state: string; count: number }[]> { ... }
export async function getPriorAuthOutcomes(): Promise<{ outcome: string; count: number }[]> { ... }
export async function getTopDenialReasons(): Promise<{ reason: string; count: number }[]> { ... }
export async function getSkillMatchRates(): Promise<{ skill: string; evaluations: number; matchRate: number; avgConfidence: number }[]> { ... }
export async function getAvgStateTimings(): Promise<{ fromState: string; toState: string; avgHours: number }[]> { ... }
```

**`src/views/analytics.html`**

- Data injected via `window.__ANALYTICS_DATA__`
- Chart.js from CDN
- Bootstrap grid, same CSS variable theme as existing views
- Matching `<!--__NAV__-->` nav injection point

**`scripts/seed-analytics-demo.ts`**

Direct SQLite inserts (bypasses SMTP/IMAP). Generates:
- 80 patients + 80 referrals across 90-day window
- 6 departments: Cardiology, Neurology, Orthopedics, Oncology, Gastroenterology, General Surgery
- 4 clinicians with varied acceptance patterns
- Full `workflow_events` event sequence per referral
- 15 prior auth request/response pairs (Blue Cross 80% approve, Aetna 50%, United Health 30%)
- 40 skill executions across 3 skills

### Route

```typescript
app.get('/analytics', async (req, res, next) => {
  const [kpis, stateCounts, dailyIntake, funnel, paOutcomes,
         denialReasons, skillRates, stateTimings] = await Promise.all([...]);
  // inject + serve analytics.html
});
```

### Nav

Add `<a href="/analytics">Analytics</a>` to `NAV_HTML` in `src/server.ts`.

### Package.json

```json
"seed:analytics": "ts-node -r ./src/scripts/node-polyfill.js scripts/seed-analytics-demo.ts"
```

---

## Deliverables

- [ ] `src/modules/analytics/analyticsQueries.ts`
- [ ] `tests/unit/analytics/analyticsQueries.test.ts`
- [ ] `src/views/analytics.html`
- [ ] Route + nav link in `src/server.ts`
- [ ] `scripts/seed-analytics-demo.ts`
- [ ] `seed:analytics` script in `package.json`

---

## Testing

```bash
npx jest tests/unit/analytics/analyticsQueries.test.ts  # query unit tests
npm test                                                  # zero regressions
npm run seed:analytics && npm run dev                    # visual verification
```

Visit `localhost:3001/analytics` after seeding.

---

## Related Documents

- [[PRD-14 - Analytics Agent (Phase 1)]] — event log infrastructure
- [[PRD-14 - Analytics Agent (Phase 3)]] — proactive insight agent (future)
- [[Analytics Agent]] — feature context and motivation
