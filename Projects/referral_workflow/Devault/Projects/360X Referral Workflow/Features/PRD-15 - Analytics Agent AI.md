---
up: "[[📋 PRD Index]]"
prev: "[[PRD-14 - Analytics Agent (Phase 2)]]"
---

# PRD-15: Analytics Agent AI — Proactive Workflow Intelligence

**Status:** Ready for Dev  
**Team:** Clinical Workflow & Analytics  
**Module:** `analytics/`

---

## Overview

### Context

The PRD-14 analytics dashboard surfaces historical patterns visually — coordinators can see that denial rates are elevated or PA approvals are low. But translating those observations into actionable decisions requires time and domain expertise: pulling the actual referral documents, reading across them to find commonalities, then hypothesizing a root cause.

This PRD adds a UI-triggered AI agent that automates exactly that. The agent runs in two phases: first it queries the database to identify clusters that exceed statistical thresholds (denial spikes by clinician×department, PA denial patterns by payer, no-show concentrations, referrer quality issues); then for each flagged cluster it retrieves the full referral documents — clinical data JSON, prior auth records, payer responses — and sends them to Claude for pattern extraction.

The output is structured findings presented directly on the analytics page: what patterns were found, the most likely root cause, and a specific recommended action (skill rule update, referrer outreach, scheduling protocol change, or payer-specific documentation requirement checklist). The coordinator does not need to interpret raw charts — the agent does it for them.

### Goal

1. **Identify workflow anomalies automatically** from the event log and referral records, scoped to the current dashboard filter context
2. **Explain root causes** by cross-referencing full referral documents and prior auth records — not just counters
3. **Recommend specific actions** categorized by type (skill rule, referrer education, scheduling protocol, payer documentation requirement)

### Scope

**In Scope:**
- Four anomaly detection types: denial cluster, PA denial pattern, no-show cluster, pending-info cluster
- Full document context per cluster: clinical data JSON, decline reasons, PA service codes, payer denial reasons, PA review actions
- Claude-powered pattern analysis (top 3 anomalies by count)
- `POST /analytics/agent` JSON endpoint
- "Run Analysis" button in analytics filter bar
- Findings panel with per-finding cards (patterns, root cause, recommendation, confidence)
- Filter-scoped analysis — agent respects active department/clinician/days filters

**Out of Scope:**
- Automatic agent runs (scheduled/triggered) — UI-only trigger in this PRD
- Writing back to skill YAML files — agent recommends, coordinator acts manually
- Streaming responses — full await before render
- Persistent storage of agent findings — ephemeral per-run
- Email or notification delivery of findings

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to trigger an AI analysis of current referral patterns so I can understand why my workflows are underperforming without manually reviewing each referral

**AC1:** An "Run Analysis" button is visible in the analytics filter bar.  
**AC2:** Clicking the button sends the current active filters to the agent and shows a loading state on the button while awaiting results.  
**AC3:** When the agent returns, a findings panel appears above the KPI row showing ≥1 finding card (or a "No patterns detected" message if below threshold).  
**AC4:** Re-clicking with different filters updates the findings panel.

### As a care coordinator, I want each finding to tell me what documents the pattern was found in, what the root cause likely is, and what to do about it

**AC1:** Each finding card shows: anomaly label with referral count, confidence level, bulleted list of observed patterns, a single root-cause sentence, and a recommended action.  
**AC2:** The recommendation is typed — one of: "Update skill rule", "Referrer education", "Scheduling protocol", "Payer documentation requirement" — with appropriate visual treatment per type.  
**AC3:** The agent considers both the referral document (clinical data, decline reason) and the prior auth record (service code, payer denial reason, review action) when analyzing denial and PA clusters.

### As a care coordinator, I want the agent analysis to respect my current dashboard filters so I can focus on a specific department or time period

**AC1:** If the Department filter is set to "Cardiology", only Cardiology referrals appear in the agent's discovery queries.  
**AC2:** The days filter (30d / 60d / 90d / All) scopes the date range for anomaly detection.  
**AC3:** The agent header shows the active filter scope (e.g., "Cardiology · Last 90 days") so the user knows what was analyzed.

---

## Technical Specifications

### Dependencies

- `@anthropic-ai/sdk` — already a project dependency; use `claude-sonnet-4-6`
- No new packages required

### Engineering Constraints

- Discovery queries use Drizzle ORM's `sql` template literals + `db.all()` (better-sqlite3 sync API) — same pattern as `analyticsQueries.ts`
- Claude call is non-streaming, full await — expected latency 5–15s for a cluster of 10 referrals
- Agent is capped at analyzing top 3 anomalies by count (prevents token explosion on large datasets)
- Each cluster is capped at 15 referral documents sent to Claude (prevents context length issues)
- `ANTHROPIC_API_KEY` must be set; if missing, discovery still runs but analysis returns `{ confidence: 'low', patterns: [], rootCause: 'Analysis unavailable — API key not configured', recommendation: '' }`
- The route reuses `parseAnalyticsFilters()` already in `server.ts` — filters arrive as request body (POST, not query params)

### Data Models

**Anomaly** (internal, Phase 1 output):

```typescript
interface Anomaly {
  type: 'denial_cluster' | 'pa_denial_pattern' | 'no_show_cluster' | 'pending_info_cluster';
  label: string;           // e.g. "dr-kim · Neurology denials (9)"
  referralIds: number[];
  paRequestIds?: number[]; // present for pa_denial_pattern
  count: number;
  context: Record<string, unknown>; // clinicianId, dept, insurer_name, serviceCode, etc.
}
```

**Finding** (Phase 2 output, one per analyzed anomaly):

```typescript
interface Finding {
  anomaly: Anomaly;
  patterns: string[];      // 2–5 bullet observations from Claude
  rootCause: string;       // single most likely explanation
  recommendation: string;  // specific actionable next step
  recommendationType: 'skill_rule_update' | 'referrer_education' | 'scheduling_protocol' | 'payer_documentation_requirement';
  confidence: 'high' | 'medium' | 'low';
}
```

**AgentResult** (API response):

```typescript
interface AgentResult {
  findings: Finding[];
  anomaliesFound: number;
  anomaliesAnalyzed: number;  // capped at 3
  filterContext: string;       // human label, e.g. "Cardiology · Last 90 days"
  generatedAt: string;         // ISO timestamp
}
```

### Anomaly Detection Thresholds

| Type | Query | Threshold |
|---|---|---|
| `denial_cluster` | GROUP BY clinician_id, routing_department WHERE state='Declined' | count ≥ 4 |
| `pa_denial_pattern` | JOIN prior_auth_responses WHERE outcome='denied' GROUP BY insurer_name, service_code | count ≥ 4 |
| `no_show_cluster` | GROUP BY routing_department WHERE state='No-Show' | count ≥ 4 |
| `pending_info_cluster` | GROUP BY referrer_address WHERE state='Pending-Information' | count ≥ 3 |

All queries respect the `AnalyticsFilters` date window and any active department/clinician filter.

### Claude Prompt Design

Each anomaly sends a structured context block to Claude:

```
System: You are a healthcare workflow analyst. Identify patterns in referral documents that explain a workflow anomaly.

Anomaly: [anomaly.label] — [count] referrals

[For each referral in cluster:]
--- Referral #[id] ---
Reason for referral: [text]
Problems/Diagnoses: [clinical_data.problems as code: display list]
Medications: [clinical_data.medications]
Decline reason: [if applicable]
AI routing warnings: [ai_assessment.warnings]
PA service: [service_display] | Payer: [insurer_name]
PA denial reason: [denial_reason]
PA review action: [review_action]
---

Return ONLY valid JSON (no prose, no markdown fences):
{
  "patterns": ["...", "..."],
  "rootCause": "...",
  "recommendation": "...",
  "recommendationType": "skill_rule_update|referrer_education|scheduling_protocol|payer_documentation_requirement",
  "confidence": "high|medium|low"
}
```

`recommendationType` semantics:
- `payer_documentation_requirement` — agent identified that a specific payer requires documentation not typically included in referrals for this service type (e.g., "Aetna requires prior conservative treatment records for echocardiography prior auths")
- `skill_rule_update` — a PRD-09 skill could be added/modified to auto-flag or auto-handle this pattern
- `referrer_education` — the referring provider is systematically omitting information; outreach would prevent recurrence
- `scheduling_protocol` — no-show or time-outlier pattern suggests a departmental scheduling process issue

### API Design

**Endpoint:** `POST /analytics/agent`

**Request:**
```json
{
  "department": "Cardiology",
  "days": 90
}
```
(Same fields as `AnalyticsFilters` — all optional; empty body = no filters applied)

**Response:**
```json
{
  "findings": [
    {
      "anomaly": {
        "type": "pa_denial_pattern",
        "label": "Aetna · Echocardiography (93306) PA denials (11)",
        "referralIds": [128, 131, 137],
        "paRequestIds": [5, 8, 14],
        "count": 11,
        "context": { "insurerName": "Aetna", "serviceCode": "93306" }
      },
      "patterns": [
        "All 11 referrals lacked prior conservative management documentation",
        "Aetna review action code A4 (additional information required) present in 9 of 11 responses",
        "Diagnoses uniformly include I25.10 (CAD) without documented stress test results"
      ],
      "rootCause": "Aetna requires documented prior conservative treatment and stress test results before approving echocardiography for CAD patients; referrals are missing this documentation at submission.",
      "recommendation": "Add a payer-specific checklist for Aetna echocardiography submissions requiring: (1) prior stress test results, (2) documented conservative management ≥3 months.",
      "recommendationType": "payer_documentation_requirement",
      "confidence": "high"
    }
  ],
  "anomaliesFound": 3,
  "anomaliesAnalyzed": 3,
  "filterContext": "Cardiology · Last 90 days",
  "generatedAt": "2026-04-12T14:30:00.000Z"
}
```

---

## Test Plan

**Unit Tests:**
- `discoverAnomalies()` returns denial cluster when ≥4 declines exist for same clinician×dept
- `discoverAnomalies()` returns empty array when all clusters are below threshold
- `discoverAnomalies()` respects `days` filter — referrals outside window excluded
- `analyzeAnomaly()` returns fallback finding when `ANTHROPIC_API_KEY` is unset
- `analyzeAnomaly()` strips MD code fences from Claude response before JSON parse
- `runAnalyticsAgent()` caps analysis at 3 anomalies even if 5 are detected

**Integration Tests:**
- `POST /analytics/agent` with empty filters → 200 with `findings` array
- `POST /analytics/agent` with `{ "department": "Cardiology" }` → only Cardiology anomalies in findings
- Full run with seeded 100-referral dataset → at least 3 findings, each with non-empty `rootCause`

**Edge Cases:**
- All referrals in Closed-Confirmed state (no anomalies) → `{ findings: [], anomaliesFound: 0 }`
- Claude returns malformed JSON → finding renders with `confidence: 'low'` and fallback copy
- Cluster has 0 associated PA records → PA fields excluded from prompt without error

---

## Deliverables

- **New:** `src/modules/analytics/analyticsAgent.ts` — discovery SQL + Claude integration
- **Modified:** `src/server.ts` — `POST /analytics/agent` route
- **Modified:** `src/views/analytics.html` — "Run Analysis" button + findings panel + `runAgent()` + `renderFindings()`
- **Prerequisite:** [[Feature - Full Demo Seed Expansion (100 Scenarios)]] must be run before testing

---

## Related Documents

- [[📋 PRD Index|PRD Index]]
- [[PRD-14 - Analytics Agent (Phase 2)|PRD-14 Phase 2: Analytics Dashboard (event data source)]]
- [[PRD-09 - Agent Skills|PRD-09: Agent Skills (skill_rule_update recommendations reference this)]]
- [[Feature - Full Demo Seed Expansion (100 Scenarios)|Seed expansion prerequisite]]

---

## History

**Created:** 2026-04-12  
**Last Updated:** 2026-04-12  
**Version:** 1.0
