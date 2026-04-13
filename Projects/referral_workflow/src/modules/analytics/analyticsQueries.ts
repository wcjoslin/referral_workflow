/**
 * Analytics Query Functions — Phase 2
 *
 * All SQL aggregations for the /analytics dashboard. Uses Drizzle's sql
 * template literal with db.all() / db.get() (better-sqlite3 sync API) to
 * support json_extract() on the metadata column and GROUP BY aggregations.
 *
 * All functions accept an optional AnalyticsFilters object and are safe
 * against empty datasets (return zeros / empty arrays).
 */

import { sql, SQL } from 'drizzle-orm';
import { db } from '../../db';

// ── Filter types ──────────────────────────────────────────────────────────────

export interface AnalyticsFilters {
  department?: string; // referrals.routing_department
  clinicianId?: string; // referrals.clinician_id
  state?: string; // referrals.state
  payer?: string; // workflow_events actor 'payer:<name>'
  skillName?: string; // workflow_events actor 'skill:<name>'
  denialReason?: string; // json_extract(metadata, '$.denialReason')
  days?: number; // date window; 0 = all time; default 90
}

// ── SQL fragment helpers ──────────────────────────────────────────────────────

// Produces  AND we.created_at >= DATE('now', '-N days')  when days > 0
function dateClause(days: number | undefined, alias = 'we'): SQL | null {
  if (!days) return null;
  return sql.raw(`AND ${alias}.created_at >= DATE('now', '-${days} days')`);
}

// Produces  AND r.routing_department = 'X'  when set
function deptClause(department: string | undefined): SQL | null {
  if (!department) return null;
  return sql`AND r.routing_department = ${department}`;
}

function clinicianClause(clinicianId: string | undefined): SQL | null {
  if (!clinicianId) return null;
  return sql`AND r.clinician_id = ${clinicianId}`;
}

function stateClause(state: string | undefined, alias = 'r'): SQL | null {
  if (!state) return null;
  return sql.raw(`AND ${alias}.state = '${state.replace(/'/g, "''")}'`);
}

function payerClause(payer: string | undefined, alias = 'we'): SQL | null {
  if (!payer) return null;
  return sql`AND ${sql.raw(alias)}.actor = ${'payer:' + payer}`;
}

function skillClause(skillName: string | undefined, alias = 'we'): SQL | null {
  if (!skillName) return null;
  return sql`AND ${sql.raw(alias)}.actor = ${'skill:' + skillName}`;
}

function denialReasonClause(denialReason: string | undefined, alias = 'we'): SQL | null {
  if (!denialReason) return null;
  return sql`AND json_extract(${sql.raw(alias)}.metadata, '$.denialReason') = ${denialReason}`;
}

// Joins workflow_events to referrals when any referral-scoped filter is active
function needsReferralJoin(f: AnalyticsFilters): boolean {
  return !!(f.department || f.clinicianId || f.state);
}

// SQL fragment for JOIN workflow_events we JOIN referrals r
function referralJoinFragment(): SQL {
  return sql.raw(`JOIN referrals r ON r.id = we.entity_id AND we.entity_type = 'referral'`);
}

// SQL fragment for priorAuth → referrals two-hop join
function paReferralJoinFragment(): SQL {
  return sql.raw(
    `JOIN prior_auth_requests par ON par.id = we.entity_id AND we.entity_type = 'priorAuth'
     JOIN referrals r ON r.id = par.referral_id`,
  );
}

// Combine non-null SQL fragments into a single SQL value
function combine(...parts: (SQL | null)[]): SQL {
  const active = parts.filter((p): p is SQL => p !== null);
  if (active.length === 0) return sql.raw('');
  // Drizzle's sql.join concatenates with a separator
  return sql.join(active, sql.raw(' '));
}

// ── Filter Options ────────────────────────────────────────────────────────────

export interface FilterOptions {
  departments: string[];
  clinicians: string[];
  states: string[];
  payers: string[];
  skills: string[];
  denialReasons: string[];
}

export function getFilterOptions(): FilterOptions {
  const departments = db
    .all<{ v: string }>(
      sql`SELECT DISTINCT routing_department AS v FROM referrals
          WHERE routing_department IS NOT NULL AND routing_department != 'Unassigned'
          ORDER BY v`,
    )
    .map((r) => r.v);

  const clinicians = db
    .all<{ v: string }>(
      sql`SELECT DISTINCT clinician_id AS v FROM referrals
          WHERE clinician_id IS NOT NULL ORDER BY v`,
    )
    .map((r) => r.v);

  const states = db
    .all<{ v: string }>(sql`SELECT DISTINCT state AS v FROM referrals ORDER BY v`)
    .map((r) => r.v);

  const payers = db
    .all<{ v: string }>(
      sql`SELECT DISTINCT REPLACE(actor, 'payer:', '') AS v FROM workflow_events
          WHERE actor LIKE 'payer:%' ORDER BY v`,
    )
    .map((r) => r.v);

  const skills = db
    .all<{ v: string }>(
      sql`SELECT DISTINCT REPLACE(actor, 'skill:', '') AS v FROM workflow_events
          WHERE actor LIKE 'skill:%' ORDER BY v`,
    )
    .map((r) => r.v);

  const denialReasons = db
    .all<{ v: string }>(
      sql`SELECT DISTINCT json_extract(metadata, '$.denialReason') AS v
          FROM workflow_events
          WHERE event_type IN ('referral.declined', 'prior_auth.denied')
            AND metadata IS NOT NULL
            AND v IS NOT NULL
          ORDER BY v`,
    )
    .map((r) => r.v);

  return { departments, clinicians, states, payers, skills, denialReasons };
}

// ── KPI Cards ────────────────────────────────────────────────────────────────

export interface Kpis {
  totalReferrals: number;
  acceptanceRate: number;
  avgDaysToClose: number;
  paApprovalRate: number;
  noShowRate: number;
}

export function getKpis(f: AnalyticsFilters = {}): Kpis {
  const refJoin = needsReferralJoin(f) ? referralJoinFragment() : null;
  const refClauses = combine(deptClause(f.department), clinicianClause(f.clinicianId), stateClause(f.state));
  const dateCl = dateClause(f.days ?? 90);

  const rc = db.get<{ total: number; accepted: number; declined: number }>(sql`
    SELECT
      COUNT(DISTINCT CASE WHEN we.event_type = 'referral.received' THEN we.entity_id END) AS total,
      COUNT(DISTINCT CASE WHEN we.event_type = 'referral.accepted' THEN we.entity_id END) AS accepted,
      COUNT(DISTINCT CASE WHEN we.event_type IN ('referral.declined', 'referral.auto_declined') THEN we.entity_id END) AS declined
    FROM workflow_events we
    ${combine(refJoin)}
    WHERE we.entity_type = 'referral'
    ${refClauses}
    ${dateCl ?? sql.raw('')}
  `) ?? { total: 0, accepted: 0, declined: 0 };

  const tr = db.get<{ avg_days: number | null }>(sql`
    SELECT AVG((close_time - receive_time) / 86400000.0) AS avg_days
    FROM (
      SELECT
        we.entity_id,
        MIN(CASE WHEN we.event_type = 'referral.received' THEN CAST(strftime('%s', we.created_at) AS INTEGER) * 1000 END) AS receive_time,
        MAX(CASE WHEN we.event_type IN ('referral.closed_confirmed', 'referral.closed') THEN CAST(strftime('%s', we.created_at) AS INTEGER) * 1000 END) AS close_time
      FROM workflow_events we
      ${combine(refJoin)}
      WHERE we.entity_type = 'referral'
      ${refClauses}
      GROUP BY we.entity_id
      HAVING receive_time IS NOT NULL AND close_time IS NOT NULL
    )
  `) ?? { avg_days: null };

  // PA sub-query uses two-hop join for referral-scoped filters
  const paJoin = needsReferralJoin(f) ? paReferralJoinFragment() : null;
  const pa = db.get<{ approved: number; total: number }>(sql`
    SELECT
      COUNT(CASE WHEN we.event_type = 'prior_auth.approved' THEN 1 END) AS approved,
      COUNT(CASE WHEN we.event_type IN ('prior_auth.approved', 'prior_auth.denied', 'prior_auth.expired') THEN 1 END) AS total
    FROM workflow_events we
    ${combine(paJoin)}
    WHERE we.entity_type = 'priorAuth'
    ${combine(payerClause(f.payer), deptClause(f.department), clinicianClause(f.clinicianId))}
  `) ?? { approved: 0, total: 0 };

  const ns = db.get<{ no_shows: number; encounters: number }>(sql`
    SELECT
      COUNT(CASE WHEN we.event_type = 'referral.no_show' THEN 1 END) AS no_shows,
      COUNT(CASE WHEN we.event_type IN ('referral.encounter_complete', 'referral.no_show') THEN 1 END) AS encounters
    FROM workflow_events we
    ${combine(refJoin)}
    WHERE we.entity_type = 'referral'
    ${refClauses}
  `) ?? { no_shows: 0, encounters: 0 };

  const dispositioned = Number(rc.accepted) + Number(rc.declined);
  return {
    totalReferrals: Number(rc.total),
    acceptanceRate:
      dispositioned > 0 ? Math.round((Number(rc.accepted) / dispositioned) * 1000) / 10 : 0,
    avgDaysToClose:
      tr.avg_days != null ? Math.round(Number(tr.avg_days) * 10) / 10 : 0,
    paApprovalRate:
      Number(pa.total) > 0
        ? Math.round((Number(pa.approved) / Number(pa.total)) * 1000) / 10
        : 0,
    noShowRate:
      Number(ns.encounters) > 0
        ? Math.round((Number(ns.no_shows) / Number(ns.encounters)) * 1000) / 10
        : 0,
  };
}

// ── Referral State Distribution ───────────────────────────────────────────────

export interface StateCount {
  state: string;
  count: number;
}

export function getReferralStateCounts(f: AnalyticsFilters = {}): StateCount[] {
  const whereClauses: (SQL | null)[] = [];
  if (f.department) whereClauses.push(sql`routing_department = ${f.department}`);
  if (f.clinicianId) whereClauses.push(sql`clinician_id = ${f.clinicianId}`);
  if (f.state) whereClauses.push(sql`state = ${f.state}`);

  const whereFragment =
    whereClauses.filter((c): c is SQL => c !== null).length > 0
      ? sql`WHERE ${sql.join(
          whereClauses.filter((c): c is SQL => c !== null),
          sql` AND `,
        )}`
      : sql.raw('');

  const rows = db.all<{ state: string; count: number }>(sql`
    SELECT state, COUNT(*) AS count
    FROM referrals
    ${whereFragment}
    GROUP BY state
    ORDER BY count DESC
  `);
  return rows.map((r) => ({ state: r.state, count: Number(r.count) }));
}

// ── Daily Intake Trend ────────────────────────────────────────────────────────

export interface DailyCount {
  date: string;
  count: number;
}

export function getDailyIntake(f: AnalyticsFilters = {}): DailyCount[] {
  const days = f.days ?? 90;
  const refJoin = needsReferralJoin(f) ? referralJoinFragment() : null;
  const refClauses = combine(deptClause(f.department), clinicianClause(f.clinicianId), stateClause(f.state));
  const dateCl = days > 0 ? sql.raw(`AND we.created_at >= DATE('now', '-${days} days')`) : null;

  const rows = db.all<{ date: string; count: number }>(sql`
    SELECT
      DATE(we.created_at) AS date,
      COUNT(*) AS count
    FROM workflow_events we
    ${combine(refJoin)}
    WHERE we.event_type = 'referral.received'
    ${refClauses}
    ${dateCl ?? sql.raw('')}
    GROUP BY DATE(we.created_at)
    ORDER BY date ASC
  `);
  return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
}

// ── Referral Funnel ───────────────────────────────────────────────────────────

export interface FunnelStep {
  state: string;
  count: number;
}

const FUNNEL_ORDER = [
  'referral.received',
  'referral.acknowledged',
  'referral.accepted',
  'referral.scheduled',
  'referral.encounter_complete',
  'referral.closed',
  'referral.closed_confirmed',
];

const FUNNEL_LABELS: Record<string, string> = {
  'referral.received': 'Received',
  'referral.acknowledged': 'Acknowledged',
  'referral.accepted': 'Accepted',
  'referral.scheduled': 'Scheduled',
  'referral.encounter_complete': 'Encounter Complete',
  'referral.closed': 'Closed',
  'referral.closed_confirmed': 'Closed (Confirmed)',
};

export function getReferralFunnel(f: AnalyticsFilters = {}): FunnelStep[] {
  const refJoin = needsReferralJoin(f) ? referralJoinFragment() : null;
  const refClauses = combine(deptClause(f.department), clinicianClause(f.clinicianId), stateClause(f.state));

  const rows = db.all<{ event_type: string; count: number }>(sql`
    SELECT we.event_type, COUNT(DISTINCT we.entity_id) AS count
    FROM workflow_events we
    ${combine(refJoin)}
    WHERE we.event_type IN (
      'referral.received', 'referral.acknowledged', 'referral.accepted',
      'referral.scheduled', 'referral.encounter_complete',
      'referral.closed', 'referral.closed_confirmed'
    )
    AND we.entity_type = 'referral'
    ${refClauses}
    GROUP BY we.event_type
  `);

  const counts = new Map(rows.map((r) => [r.event_type, Number(r.count)]));
  return FUNNEL_ORDER.filter((et) => counts.has(et)).map((et) => ({
    state: FUNNEL_LABELS[et],
    count: counts.get(et) ?? 0,
  }));
}

// ── Prior Auth Outcomes ───────────────────────────────────────────────────────

export interface PriorAuthOutcome {
  outcome: string;
  count: number;
}

export function getPriorAuthOutcomes(f: AnalyticsFilters = {}): PriorAuthOutcome[] {
  const paJoin = needsReferralJoin(f) ? paReferralJoinFragment() : null;
  const days = f.days ?? 90;
  const dateCl = days > 0 ? sql.raw(`AND we.created_at >= DATE('now', '-${days} days')`) : null;

  const rows = db.all<{ outcome: string; count: number }>(sql`
    SELECT
      REPLACE(we.event_type, 'prior_auth.', '') AS outcome,
      COUNT(*) AS count
    FROM workflow_events we
    ${combine(paJoin)}
    WHERE we.event_type IN ('prior_auth.approved', 'prior_auth.denied', 'prior_auth.pended', 'prior_auth.expired')
    ${combine(
      payerClause(f.payer),
      deptClause(f.department),
      clinicianClause(f.clinicianId),
      dateCl,
    )}
    GROUP BY we.event_type
    ORDER BY count DESC
  `);
  return rows.map((r) => ({ outcome: r.outcome, count: Number(r.count) }));
}

// ── Top Denial Reasons ────────────────────────────────────────────────────────

export interface DenialReason {
  reason: string;
  count: number;
}

export function getTopDenialReasons(f: AnalyticsFilters = {}): DenialReason[] {
  // Collect referral-decline reasons
  const refJoin = needsReferralJoin(f) ? referralJoinFragment() : null;
  const refClauses = combine(deptClause(f.department), clinicianClause(f.clinicianId), stateClause(f.state));
  const drFilter = f.denialReason ? sql`AND json_extract(we.metadata, '$.denialReason') = ${f.denialReason}` : sql.raw('');

  const referralDeclines = db.all<{ reason: string; count: number }>(sql`
    SELECT
      COALESCE(json_extract(we.metadata, '$.denialReason'), 'No reason given') AS reason,
      COUNT(*) AS count
    FROM workflow_events we
    ${combine(refJoin)}
    WHERE we.event_type = 'referral.declined'
      AND we.metadata IS NOT NULL
    ${refClauses}
    ${drFilter}
    GROUP BY reason
  `);

  // Collect PA-denial reasons (payer + referral-scoped)
  const paJoin = needsReferralJoin(f) ? paReferralJoinFragment() : null;
  const paPayerFilter = payerClause(f.payer);
  const paDrFilter = f.denialReason
    ? sql`AND json_extract(we.metadata, '$.denialReason') = ${f.denialReason}`
    : sql.raw('');

  const paDenials = db.all<{ reason: string; count: number }>(sql`
    SELECT
      COALESCE(json_extract(we.metadata, '$.denialReason'), 'No reason given') AS reason,
      COUNT(*) AS count
    FROM workflow_events we
    ${combine(paJoin)}
    WHERE we.event_type = 'prior_auth.denied'
      AND we.metadata IS NOT NULL
    ${combine(paPayerFilter, deptClause(f.department), clinicianClause(f.clinicianId))}
    ${paDrFilter}
    GROUP BY reason
  `);

  // Merge + aggregate in JS
  const totals = new Map<string, number>();
  for (const { reason, count } of [...referralDeclines, ...paDenials]) {
    totals.set(reason, (totals.get(reason) ?? 0) + Number(count));
  }

  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));
}

// ── Skill Match Rates ─────────────────────────────────────────────────────────

export interface SkillMatchRate {
  skill: string;
  evaluations: number;
  matchRate: number;
  avgConfidence: number;
}

export function getSkillMatchRates(f: AnalyticsFilters = {}): SkillMatchRate[] {
  const refJoin = needsReferralJoin(f) ? referralJoinFragment() : null;
  const refClauses = combine(deptClause(f.department), clinicianClause(f.clinicianId), stateClause(f.state));

  const rows = db.all<{
    skill: string;
    evaluations: number;
    matched: number;
    avg_confidence: number | null;
  }>(sql`
    SELECT
      REPLACE(we.actor, 'skill:', '') AS skill,
      COUNT(*) AS evaluations,
      SUM(CASE WHEN json_extract(we.metadata, '$.matched') = 1 THEN 1 ELSE 0 END) AS matched,
      AVG(CAST(json_extract(we.metadata, '$.confidence') AS REAL)) AS avg_confidence
    FROM workflow_events we
    ${combine(refJoin)}
    WHERE we.event_type = 'skill.evaluated'
    ${combine(skillClause(f.skillName), refClauses)}
    GROUP BY we.actor
    ORDER BY evaluations DESC
  `);

  return rows.map((r) => ({
    skill: r.skill,
    evaluations: Number(r.evaluations),
    matchRate:
      Number(r.evaluations) > 0
        ? Math.round((Number(r.matched) / Number(r.evaluations)) * 1000) / 10
        : 0,
    avgConfidence:
      r.avg_confidence != null ? Math.round(Number(r.avg_confidence) * 1000) / 1000 : 0,
  }));
}

// ── Average State Timings ─────────────────────────────────────────────────────

export interface StateTiming {
  fromState: string;
  toState: string;
  avgHours: number;
}

export function getAvgStateTimings(f: AnalyticsFilters = {}): StateTiming[] {
  const refJoin = needsReferralJoin(f) ? referralJoinFragment() : null;
  const refClauses = combine(deptClause(f.department), clinicianClause(f.clinicianId), stateClause(f.state));

  // When filters are active we restrict the set of entity_ids first, then self-join
  const entityFilter =
    needsReferralJoin(f)
      ? sql`AND e1.entity_id IN (
          SELECT we.entity_id FROM workflow_events we
          ${combine(refJoin)}
          WHERE we.entity_type = 'referral'
          ${refClauses}
        )`
      : sql.raw('');

  const rows = db.all<{
    from_state: string;
    to_state: string;
    avg_hours: number;
  }>(sql`
    SELECT
      from_state,
      to_state,
      ROUND(AVG(duration_hours), 1) AS avg_hours
    FROM (
      SELECT
        e1.to_state AS from_state,
        e2.to_state AS to_state,
        (CAST(strftime('%s', e2.created_at) AS REAL) - CAST(strftime('%s', e1.created_at) AS REAL)) / 3600.0 AS duration_hours
      FROM workflow_events e1
      JOIN workflow_events e2
        ON e1.entity_id = e2.entity_id
        AND e1.entity_type = 'referral'
        AND e2.entity_type = 'referral'
        AND e2.created_at > e1.created_at
        AND e1.to_state IS NOT NULL
        AND e2.to_state IS NOT NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM workflow_events e3
        WHERE e3.entity_id = e1.entity_id
          AND e3.entity_type = 'referral'
          AND e3.created_at > e1.created_at
          AND e3.created_at < e2.created_at
          AND e3.to_state IS NOT NULL
      )
      ${entityFilter}
    )
    WHERE from_state IS NOT NULL AND to_state IS NOT NULL
    GROUP BY from_state, to_state
    ORDER BY avg_hours ASC
  `);

  return rows.map((r) => ({
    fromState: r.from_state,
    toState: r.to_state,
    avgHours: Number(r.avg_hours),
  }));
}

// ── Event Count (empty-state gate) ───────────────────────────────────────────

export function getEventCount(): number {
  const row = db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM workflow_events`);
  return Number(row?.count ?? 0);
}
