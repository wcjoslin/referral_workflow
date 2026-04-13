/**
 * Analytics Agent — PRD-15
 *
 * Two-phase AI agent for proactive workflow intelligence.
 *
 * Phase 1 — Discovery (SQL, ~50ms): runs GROUP BY / HAVING queries to find
 * anomaly clusters that exceed reporting thresholds.
 *
 * Phase 2 — Analysis (Claude claude-sonnet-4-6, per anomaly): fetches full
 * referral + PA documents for each cluster and sends them to Claude for
 * pattern extraction, root-cause identification, and recommendation generation.
 *
 * Top 3 anomalies by count are analyzed; each cluster is capped at 15 docs.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { AnalyticsFilters } from './analyticsQueries';

// ── Data Models ───────────────────────────────────────────────────────────────

export interface Anomaly {
  type: 'denial_cluster' | 'pa_denial_pattern' | 'no_show_cluster' | 'pending_info_cluster';
  label: string;
  referralIds: number[];
  paRequestIds?: number[];
  count: number;
  context: Record<string, unknown>;
}

export interface Finding {
  anomaly: Anomaly;
  patterns: string[];
  rootCause: string;
  recommendation: string;
  recommendationType:
    | 'skill_rule_update'
    | 'referrer_education'
    | 'scheduling_protocol'
    | 'payer_documentation_requirement';
  confidence: 'high' | 'medium' | 'low';
}

export interface AgentResult {
  findings: Finding[];
  anomaliesFound: number;
  anomaliesAnalyzed: number;
  filterContext: string;
  generatedAt: string;
}

// ── SQL helpers ───────────────────────────────────────────────────────────────

function escSql(s: string): string {
  return s.replace(/'/g, "''");
}

function buildReferralFilterClauses(filters: AnalyticsFilters, alias = 'r'): string {
  const parts: string[] = [];
  // referrals.created_at is stored as integer Unix timestamp (ms); date filtering
  // is applied via workflow_events in the dashboard. Here we only filter by
  // categorical dimensions that are meaningful for anomaly clustering.
  if (filters.department) parts.push(`${alias}.routing_department = '${escSql(filters.department)}'`);
  if (filters.clinicianId) parts.push(`${alias}.clinician_id = '${escSql(filters.clinicianId)}'`);
  return parts.length > 0 ? 'AND ' + parts.join(' AND ') : '';
}

// ── Phase 1 — Discovery ───────────────────────────────────────────────────────

export function discoverAnomalies(filters: AnalyticsFilters): Anomaly[] {
  const fc = buildReferralFilterClauses(filters);
  const anomalies: Anomaly[] = [];

  // 1. Denial cluster: GROUP BY clinician_id × routing_department, threshold ≥ 4
  const denialRows = db.all<{
    clinician_id: string;
    routing_department: string;
    n: number;
    ids: string;
  }>(sql.raw(`
    SELECT clinician_id, routing_department,
           COUNT(*) AS n,
           GROUP_CONCAT(id) AS ids
    FROM referrals r
    WHERE state = 'Declined' ${fc}
    GROUP BY clinician_id, routing_department
    HAVING n >= 4
    ORDER BY n DESC
    LIMIT 5
  `));
  for (const row of denialRows) {
    anomalies.push({
      type: 'denial_cluster',
      label: `${row.clinician_id} · ${row.routing_department} denials (${row.n})`,
      referralIds: row.ids.split(',').map(Number),
      count: Number(row.n),
      context: { clinicianId: row.clinician_id, department: row.routing_department },
    });
  }

  // 2. PA denial pattern: GROUP BY insurer_name × service_code, threshold ≥ 4
  // (prior_auth_requests.created_at is also an integer timestamp — no date filter applied)
  const paDeptJoin = filters.department
    ? `JOIN referrals rdept ON rdept.id = par.referral_id AND rdept.routing_department = '${escSql(filters.department)}'`
    : '';

  const paRows = db.all<{
    insurer_name: string;
    service_code: string;
    service_display: string;
    n: number;
    pa_ids: string;
    ref_ids: string;
  }>(sql.raw(`
    SELECT par.insurer_name, par.service_code,
           COALESCE(par.service_display, par.service_code) AS service_display,
           COUNT(*) AS n,
           GROUP_CONCAT(par.id) AS pa_ids,
           GROUP_CONCAT(par.referral_id) AS ref_ids
    FROM prior_auth_requests par
    JOIN prior_auth_responses resp ON resp.request_id = par.id
    ${paDeptJoin}
    WHERE resp.outcome = 'denied'
    GROUP BY par.insurer_name, par.service_code
    HAVING n >= 4
    ORDER BY n DESC
    LIMIT 5
  `));
  for (const row of paRows) {
    anomalies.push({
      type: 'pa_denial_pattern',
      label: `${row.insurer_name} · ${row.service_display} (${row.service_code}) PA denials (${row.n})`,
      referralIds: row.ref_ids ? row.ref_ids.split(',').map(Number).filter(Boolean) : [],
      paRequestIds: row.pa_ids.split(',').map(Number),
      count: Number(row.n),
      context: { insurerName: row.insurer_name, serviceCode: row.service_code, serviceDisplay: row.service_display },
    });
  }

  // 3. No-show cluster: GROUP BY routing_department, threshold ≥ 4
  const noShowRows = db.all<{
    routing_department: string;
    n: number;
    ids: string;
  }>(sql.raw(`
    SELECT routing_department,
           COUNT(*) AS n,
           GROUP_CONCAT(id) AS ids
    FROM referrals r
    WHERE state = 'No-Show' ${fc}
    GROUP BY routing_department
    HAVING n >= 4
    ORDER BY n DESC
    LIMIT 5
  `));
  for (const row of noShowRows) {
    anomalies.push({
      type: 'no_show_cluster',
      label: `${row.routing_department} no-shows (${row.n})`,
      referralIds: row.ids.split(',').map(Number),
      count: Number(row.n),
      context: { department: row.routing_department },
    });
  }

  // 4. Pending-info cluster: GROUP BY referrer_address, threshold ≥ 3
  const pendingRows = db.all<{
    referrer_address: string;
    n: number;
    ids: string;
  }>(sql.raw(`
    SELECT referrer_address,
           COUNT(*) AS n,
           GROUP_CONCAT(id) AS ids
    FROM referrals r
    WHERE state = 'Pending-Information' ${fc}
    GROUP BY referrer_address
    HAVING n >= 3
    ORDER BY n DESC
    LIMIT 5
  `));
  for (const row of pendingRows) {
    anomalies.push({
      type: 'pending_info_cluster',
      label: `Pending-info from ${row.referrer_address} (${row.n})`,
      referralIds: row.ids.split(',').map(Number),
      count: Number(row.n),
      context: { referrerAddress: row.referrer_address },
    });
  }

  return anomalies.sort((a, b) => b.count - a.count);
}

// ── Phase 2 — Document Fetching ───────────────────────────────────────────────

interface ReferralDoc {
  id: number;
  reasonForReferral: string | null;
  clinicalData: string | null;
  declineReason: string | null;
  aiAssessment: string | null;
}

interface PaDoc {
  referralId: number;
  serviceCode: string;
  serviceDisplay: string | null;
  insurerName: string;
  denialReason: string | null;
  reviewAction: string | null;
}

function fetchReferralDocs(ids: number[]): Map<number, ReferralDoc> {
  const capped = ids.slice(0, 15);
  if (capped.length === 0) return new Map();
  const rows = db.all<ReferralDoc>(sql.raw(`
    SELECT id,
           reason_for_referral AS reasonForReferral,
           clinical_data       AS clinicalData,
           decline_reason      AS declineReason,
           ai_assessment       AS aiAssessment
    FROM referrals
    WHERE id IN (${capped.join(',')})
  `));
  return new Map(rows.map((r) => [r.id, r]));
}

function fetchPaDocsByReferralIds(referralIds: number[]): Map<number, PaDoc> {
  const capped = referralIds.slice(0, 15);
  if (capped.length === 0) return new Map();
  const rows = db.all<PaDoc>(sql.raw(`
    SELECT par.referral_id   AS referralId,
           par.service_code  AS serviceCode,
           par.service_display AS serviceDisplay,
           par.insurer_name  AS insurerName,
           resp.denial_reason AS denialReason,
           resp.review_action AS reviewAction
    FROM prior_auth_requests par
    JOIN prior_auth_responses resp ON resp.request_id = par.id
    WHERE par.referral_id IN (${capped.join(',')})
    ORDER BY resp.received_at DESC
  `));
  // One PA doc per referral — keep the first (most recent by ORDER BY above)
  const map = new Map<number, PaDoc>();
  for (const row of rows) {
    if (!map.has(row.referralId)) map.set(row.referralId, row);
  }
  return map;
}

// ── Phase 2 — Prompt Builder ──────────────────────────────────────────────────

function buildClaudePrompt(
  anomaly: Anomaly,
  referralDocs: Map<number, ReferralDoc>,
  paByReferral: Map<number, PaDoc>,
): string {
  const blocks = anomaly.referralIds.slice(0, 15).map((id) => {
    const r = referralDocs.get(id);
    if (!r) return `--- Referral #${id} ---\n(document unavailable)`;

    let clinicalSummary = '(not available)';
    if (r.clinicalData) {
      try {
        const cd = JSON.parse(r.clinicalData) as {
          problems?: string[];
          medications?: string[];
          allergies?: string[];
        };
        const parts: string[] = [];
        if (cd.problems?.length) parts.push(`Problems: ${cd.problems.join(', ')}`);
        if (cd.medications?.length) parts.push(`Medications: ${cd.medications.join(', ')}`);
        if (cd.allergies?.length) parts.push(`Allergies: ${cd.allergies.join(', ')}`);
        if (parts.length) clinicalSummary = parts.join(' | ');
      } catch {
        // JSON parse failed — leave default
      }
    }

    let warnings = '(none)';
    if (r.aiAssessment) {
      try {
        const aa = JSON.parse(r.aiAssessment) as { warnings?: string[] };
        if (aa.warnings?.length) warnings = aa.warnings.join('; ');
      } catch {
        // JSON parse failed — leave default
      }
    }

    const pa = paByReferral.get(id);
    const paLines: string[] = [];
    if (pa) {
      paLines.push(`PA service: ${pa.serviceDisplay ?? pa.serviceCode} | Payer: ${pa.insurerName}`);
      if (pa.denialReason) paLines.push(`PA denial reason: ${pa.denialReason}`);
      if (pa.reviewAction) paLines.push(`PA review action: ${pa.reviewAction}`);
    }

    return [
      `--- Referral #${id} ---`,
      `Reason for referral: ${r.reasonForReferral ?? '(not provided)'}`,
      `Clinical summary: ${clinicalSummary}`,
      r.declineReason ? `Decline reason: ${r.declineReason}` : null,
      `AI routing warnings: ${warnings}`,
      ...paLines,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  });

  return `Anomaly: ${anomaly.label} — ${anomaly.count} referrals

${blocks.join('\n\n')}

Return ONLY valid JSON (no prose, no markdown fences):
{
  "patterns": ["...", "..."],
  "rootCause": "...",
  "recommendation": "...",
  "recommendationType": "skill_rule_update|referrer_education|scheduling_protocol|payer_documentation_requirement",
  "confidence": "high|medium|low"
}`;
}

// ── Phase 2 — Claude Analysis ─────────────────────────────────────────────────

const VALID_REC_TYPES: Finding['recommendationType'][] = [
  'skill_rule_update',
  'referrer_education',
  'scheduling_protocol',
  'payer_documentation_requirement',
];
const VALID_CONFIDENCE: Finding['confidence'][] = ['high', 'medium', 'low'];

function makeFallback(anomaly: Anomaly, reason: string): Finding {
  return {
    anomaly,
    patterns: [],
    rootCause: reason,
    recommendation: '',
    recommendationType: 'skill_rule_update',
    confidence: 'low',
  };
}

function extractRetryDelaySecs(err: unknown): number | null {
  if (err && typeof err === 'object' && 'errorDetails' in err) {
    const details = (err as { errorDetails: unknown[] }).errorDetails;
    for (const d of details) {
      if (
        d &&
        typeof d === 'object' &&
        '@type' in d &&
        (d as Record<string, unknown>)['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
      ) {
        const delay = (d as Record<string, unknown>)['retryDelay'];
        if (typeof delay === 'string') return parseFloat(delay) || null;
      }
    }
  }
  return null;
}

export async function analyzeAnomaly(anomaly: Anomaly, attempt = 0): Promise<Finding> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return makeFallback(anomaly, 'Analysis unavailable — GEMINI_API_KEY not configured');

  const referralDocs = fetchReferralDocs(anomaly.referralIds);
  const paByReferral = fetchPaDocsByReferralIds(anomaly.referralIds);
  const userPrompt = buildClaudePrompt(anomaly, referralDocs, paByReferral);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction:
      'You are a healthcare workflow analyst. Identify patterns in referral documents that explain a workflow anomaly.',
  });

  try {
    const result = await model.generateContent(userPrompt);
    const rawText = result.response.text().trim();
    const json = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const parsed = JSON.parse(json) as {
      patterns: unknown;
      rootCause: unknown;
      recommendation: unknown;
      recommendationType: unknown;
      confidence: unknown;
    };

    return {
      anomaly,
      patterns: Array.isArray(parsed.patterns) ? (parsed.patterns as string[]) : [],
      rootCause: typeof parsed.rootCause === 'string' ? parsed.rootCause : 'Unknown root cause',
      recommendation: typeof parsed.recommendation === 'string' ? parsed.recommendation : '',
      recommendationType: VALID_REC_TYPES.includes(
        parsed.recommendationType as Finding['recommendationType'],
      )
        ? (parsed.recommendationType as Finding['recommendationType'])
        : 'skill_rule_update',
      confidence: VALID_CONFIDENCE.includes(parsed.confidence as Finding['confidence'])
        ? (parsed.confidence as Finding['confidence'])
        : 'low',
    };
  } catch (err) {
    const is429 = err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 429;
    if (is429 && attempt < 2) {
      const delaySecs = extractRetryDelaySecs(err) ?? 65;
      console.warn(`[AnalyticsAgent] Rate limited for "${anomaly.label}" — retrying in ${delaySecs}s`);
      await new Promise((r) => setTimeout(r, delaySecs * 1000));
      return analyzeAnomaly(anomaly, attempt + 1);
    }
    console.error(`[AnalyticsAgent] analyzeAnomaly failed for "${anomaly.label}":`, err);
    return makeFallback(anomaly, 'Pattern analysis failed — see server logs');
  }
}

// ── Filter context label ──────────────────────────────────────────────────────

function buildFilterContext(filters: AnalyticsFilters): string {
  const parts: string[] = [];
  if (filters.department) parts.push(filters.department);
  if (filters.clinicianId) parts.push(filters.clinicianId);
  const days = filters.days ?? 90;
  parts.push(days === 0 ? 'All time' : `Last ${days} days`);
  return parts.join(' · ');
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runAnalyticsAgent({
  filters,
}: {
  filters: AnalyticsFilters;
}): Promise<AgentResult> {
  const anomalies = discoverAnomalies(filters);
  const topThree = anomalies.slice(0, 3);

  // Run sequentially to stay within Gemini rate limits
  const findings: Finding[] = [];
  for (const anomaly of topThree) {
    findings.push(await analyzeAnomaly(anomaly));
  }

  return {
    findings,
    anomaliesFound: anomalies.length,
    anomaliesAnalyzed: topThree.length,
    filterContext: buildFilterContext(filters),
    generatedAt: new Date().toISOString(),
  };
}
