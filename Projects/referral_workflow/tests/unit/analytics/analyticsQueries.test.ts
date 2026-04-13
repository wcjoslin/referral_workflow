/**
 * Unit tests for analyticsQueries.ts
 *
 * Uses in-memory SQLite (via jest.mock) to verify SQL aggregation logic,
 * KPI math, json_extract behaviour, and safe empty-dataset defaults.
 */

jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'specialist@specialist.direct' },
    database: { url: ':memory:' },
  },
}));

jest.mock('../../../src/db', () => {
  const Database = require('better-sqlite3');
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const schema = require('../../../src/db/schema');

  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      date_of_birth TEXT NOT NULL
    );
    CREATE TABLE referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      source_message_id TEXT NOT NULL UNIQUE,
      referrer_address TEXT NOT NULL,
      reason_for_referral TEXT,
      state TEXT NOT NULL DEFAULT 'Received',
      decline_reason TEXT,
      clinician_id TEXT,
      appointment_date TEXT,
      appointment_location TEXT,
      scheduled_provider TEXT,
      ai_assessment TEXT,
      routing_department TEXT NOT NULL DEFAULT 'Unassigned',
      routing_equipment TEXT,
      clinical_data TEXT,
      raw_ccda_xml TEXT,
      created_at INTEGER NOT NULL,
      priority_flag INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE prior_auth_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referral_id INTEGER,
      patient_id INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'Draft',
      claim_json TEXT NOT NULL,
      insurer_name TEXT NOT NULL,
      insurer_id TEXT NOT NULL,
      service_code TEXT NOT NULL,
      service_display TEXT,
      provider_npi TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      subscriber_id TEXT,
      subscription_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      submitted_at INTEGER
    );
    CREATE TABLE workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      from_state TEXT,
      to_state TEXT,
      actor TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_workflow_events_entity ON workflow_events (entity_type, entity_id);
    CREATE INDEX idx_workflow_events_type_time ON workflow_events (event_type, created_at);
  `);

  // Expose the raw sqlite instance so tests can seed data directly
  (global as Record<string, unknown>).__TEST_SQLITE__ = sqlite;

  return { db: drizzle(sqlite, { schema }) };
});

import {
  getKpis,
  getReferralStateCounts,
  getDailyIntake,
  getPriorAuthOutcomes,
  getTopDenialReasons,
  getSkillMatchRates,
  getEventCount,
  getFilterOptions,
} from '../../../src/modules/analytics/analyticsQueries';

// Helper to get the in-memory SQLite instance
function sqlite(): import('better-sqlite3').Database {
  return (global as Record<string, unknown>).__TEST_SQLITE__ as import('better-sqlite3').Database;
}

function clearTables(): void {
  sqlite().exec('DELETE FROM workflow_events; DELETE FROM referrals; DELETE FROM patients;');
}

const NOW = new Date('2026-04-11T12:00:00Z');
const TS = (offsetMinutes: number): string => {
  const d = new Date(NOW.getTime() + offsetMinutes * 60 * 1000);
  return d.toISOString().replace('T', ' ').replace('Z', '');
};

function insertEvent(
  eventType: string,
  entityType: string,
  entityId: number,
  actor: string,
  toState?: string,
  fromState?: string,
  metadata?: Record<string, unknown>,
  offsetMinutes = 0,
): void {
  sqlite()
    .prepare(
      `INSERT INTO workflow_events (event_type, entity_type, entity_id, actor, to_state, from_state, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventType,
      entityType,
      entityId,
      actor,
      toState ?? null,
      fromState ?? null,
      metadata ? JSON.stringify(metadata) : null,
      TS(offsetMinutes),
    );
}

function insertReferral(id: number, state: string): void {
  sqlite()
    .prepare(
      `INSERT INTO referrals (id, patient_id, source_message_id, referrer_address, state, created_at, updated_at, routing_department)
       VALUES (?, 1, ?, 'ref@test.direct', ?, ?, ?, 'Cardiology')`,
    )
    .run(id, `msg-${id}@test`, state, NOW.getTime(), NOW.getTime());
}

// ─────────────────────────────────────────────────────────────────────────────

describe('analyticsQueries', () => {
  beforeEach(() => clearTables());

  describe('getEventCount()', () => {
    it('returns 0 with empty table', () => {
      expect(getEventCount()).toBe(0);
    });

    it('counts rows correctly', () => {
      insertEvent('referral.received', 'referral', 1, 'system', 'Received');
      insertEvent('referral.acknowledged', 'referral', 1, 'system', 'Acknowledged', 'Received', undefined, 1);
      expect(getEventCount()).toBe(2);
    });
  });

  describe('getKpis()', () => {
    it('returns all zeros when no events exist', () => {
      const kpis = getKpis();
      expect(kpis.totalReferrals).toBe(0);
      expect(kpis.acceptanceRate).toBe(0);
      expect(kpis.avgDaysToClose).toBe(0);
      expect(kpis.paApprovalRate).toBe(0);
      expect(kpis.noShowRate).toBe(0);
    });

    it('calculates acceptance rate correctly', () => {
      // 3 accepted, 1 declined out of 4 dispositioned
      insertEvent('referral.received', 'referral', 1, 'system', 'Received', undefined, undefined, 0);
      insertEvent('referral.received', 'referral', 2, 'system', 'Received', undefined, undefined, 0);
      insertEvent('referral.received', 'referral', 3, 'system', 'Received', undefined, undefined, 0);
      insertEvent('referral.received', 'referral', 4, 'system', 'Received', undefined, undefined, 0);
      insertEvent('referral.accepted', 'referral', 1, 'clinician:dr-a', 'Accepted');
      insertEvent('referral.accepted', 'referral', 2, 'clinician:dr-a', 'Accepted');
      insertEvent('referral.accepted', 'referral', 3, 'clinician:dr-a', 'Accepted');
      insertEvent('referral.declined', 'referral', 4, 'clinician:dr-a', 'Declined', undefined, { denialReason: 'Out of network' });

      const kpis = getKpis();
      expect(kpis.totalReferrals).toBe(4);
      expect(kpis.acceptanceRate).toBe(75); // 3/4 = 75%
    });

    it('calculates PA approval rate correctly', () => {
      // 2 approved, 1 denied
      insertEvent('prior_auth.approved', 'priorAuth', 1, 'payer:BlueCross');
      insertEvent('prior_auth.approved', 'priorAuth', 2, 'payer:BlueCross');
      insertEvent('prior_auth.denied', 'priorAuth', 3, 'payer:Aetna', undefined, undefined, { denialReason: 'Not medically necessary' });

      const kpis = getKpis();
      expect(kpis.paApprovalRate).toBeCloseTo(66.7, 0);
    });

    it('calculates no-show rate correctly', () => {
      insertEvent('referral.encounter_complete', 'referral', 1, 'system');
      insertEvent('referral.encounter_complete', 'referral', 2, 'system');
      insertEvent('referral.no_show', 'referral', 3, 'system');

      const kpis = getKpis();
      expect(kpis.noShowRate).toBeCloseTo(33.3, 0);
    });
  });

  describe('getReferralStateCounts()', () => {
    it('returns empty array with no referrals', () => {
      expect(getReferralStateCounts()).toEqual([]);
    });

    it('groups referrals by state', () => {
      insertReferral(1, 'Accepted');
      insertReferral(2, 'Accepted');
      insertReferral(3, 'Declined');

      const counts = getReferralStateCounts();
      const accepted = counts.find((c) => c.state === 'Accepted');
      const declined = counts.find((c) => c.state === 'Declined');
      expect(accepted?.count).toBe(2);
      expect(declined?.count).toBe(1);
    });
  });

  describe('getDailyIntake()', () => {
    it('returns empty array with no events', () => {
      expect(getDailyIntake({ days: 30 })).toEqual([]);
    });

    it('groups referral.received events by day', () => {
      insertEvent('referral.received', 'referral', 1, 'system', 'Received', undefined, undefined, 0);
      insertEvent('referral.received', 'referral', 2, 'system', 'Received', undefined, undefined, 0);
      insertEvent('referral.accepted', 'referral', 1, 'clinician:dr-a', 'Accepted', undefined, undefined, 30);

      const intake = getDailyIntake({ days: 30 });
      expect(intake).toHaveLength(1); // Only referral.received events, both on same day
      expect(intake[0].count).toBe(2);
    });
  });

  describe('getPriorAuthOutcomes()', () => {
    it('returns empty array with no PA events', () => {
      expect(getPriorAuthOutcomes()).toEqual([]);
    });

    it('groups PA events by outcome label', () => {
      insertEvent('prior_auth.approved', 'priorAuth', 1, 'payer:A');
      insertEvent('prior_auth.approved', 'priorAuth', 2, 'payer:A');
      insertEvent('prior_auth.denied', 'priorAuth', 3, 'payer:B');

      const outcomes = getPriorAuthOutcomes();
      expect(outcomes.find((o) => o.outcome === 'approved')?.count).toBe(2);
      expect(outcomes.find((o) => o.outcome === 'denied')?.count).toBe(1);
    });
  });

  describe('getTopDenialReasons()', () => {
    it('returns empty array with no denial events', () => {
      expect(getTopDenialReasons()).toEqual([]);
    });

    it('aggregates denial reasons across referral.declined and prior_auth.denied', () => {
      insertEvent('referral.declined', 'referral', 1, 'clinician:dr-a', undefined, undefined, {
        denialReason: 'Out of network',
      });
      insertEvent('prior_auth.denied', 'priorAuth', 2, 'payer:Aetna', undefined, undefined, {
        denialReason: 'Out of network',
      });
      insertEvent('prior_auth.denied', 'priorAuth', 3, 'payer:United', undefined, undefined, {
        denialReason: 'Not medically necessary',
      });

      const reasons = getTopDenialReasons();
      const oon = reasons.find((r) => r.reason === 'Out of network');
      expect(oon?.count).toBe(2);

      const nmn = reasons.find((r) => r.reason === 'Not medically necessary');
      expect(nmn?.count).toBe(1);
    });
  });

  describe('getSkillMatchRates()', () => {
    it('returns empty array with no skill events', () => {
      expect(getSkillMatchRates()).toEqual([]);
    });

    it('computes match rate and avg confidence per skill', () => {
      insertEvent('skill.evaluated', 'referral', 1, 'skill:payer-check', undefined, undefined, {
        matched: true,
        confidence: 0.9,
      });
      insertEvent('skill.evaluated', 'referral', 2, 'skill:payer-check', undefined, undefined, {
        matched: false,
        confidence: 0.4,
      });
      insertEvent('skill.evaluated', 'referral', 3, 'skill:urgency-flag', undefined, undefined, {
        matched: true,
        confidence: 0.8,
      });

      const rates = getSkillMatchRates();

      const payerCheck = rates.find((r) => r.skill === 'payer-check');
      expect(payerCheck?.evaluations).toBe(2);
      expect(payerCheck?.matchRate).toBe(50); // 1/2 = 50%
      expect(payerCheck?.avgConfidence).toBeCloseTo(0.65, 1);

      const urgency = rates.find((r) => r.skill === 'urgency-flag');
      expect(urgency?.evaluations).toBe(1);
      expect(urgency?.matchRate).toBe(100);
    });
  });

  // ── Filter tests ──────────────────────────────────────────────────────────

  describe('filters', () => {
    beforeEach(() => {
      // Two referrals: one in Cardiology, one in Neurology
      insertReferral(10, 'Accepted');
      sqlite().prepare(`UPDATE referrals SET routing_department='Cardiology', clinician_id='dr-chen' WHERE id=10`).run();
      insertReferral(11, 'Declined');
      sqlite().prepare(`UPDATE referrals SET routing_department='Neurology', clinician_id='dr-patel' WHERE id=11`).run();

      insertEvent('referral.received', 'referral', 10, 'system', 'Received', undefined, undefined, 0);
      insertEvent('referral.accepted', 'referral', 10, 'clinician:dr-chen', 'Accepted');
      insertEvent('referral.received', 'referral', 11, 'system', 'Received', undefined, undefined, 0);
      insertEvent('referral.declined', 'referral', 11, 'clinician:dr-patel', 'Declined', undefined, { denialReason: 'Capacity unavailable' });
    });

    it('getFilterOptions() returns populated arrays after data is inserted', () => {
      const opts = getFilterOptions();
      expect(opts.departments).toContain('Cardiology');
      expect(opts.departments).toContain('Neurology');
      expect(opts.clinicians).toContain('dr-chen');
      expect(opts.clinicians).toContain('dr-patel');
      expect(opts.states).toContain('Accepted');
      expect(opts.denialReasons).toContain('Capacity unavailable');
    });

    it('getReferralStateCounts filters by department', () => {
      const cardiology = getReferralStateCounts({ department: 'Cardiology' });
      expect(cardiology.find((c) => c.state === 'Accepted')?.count).toBe(1);
      expect(cardiology.find((c) => c.state === 'Declined')).toBeUndefined();

      const neurology = getReferralStateCounts({ department: 'Neurology' });
      expect(neurology.find((c) => c.state === 'Declined')?.count).toBe(1);
      expect(neurology.find((c) => c.state === 'Accepted')).toBeUndefined();
    });

    it('getReferralStateCounts filters by clinicianId', () => {
      const counts = getReferralStateCounts({ clinicianId: 'dr-chen' });
      expect(counts.find((c) => c.state === 'Accepted')?.count).toBe(1);
      expect(counts.find((c) => c.state === 'Declined')).toBeUndefined();
    });

    it('getKpis filters by department and returns correct acceptance rate', () => {
      const kpis = getKpis({ department: 'Cardiology', days: 0 });
      // Cardiology has 1 received, 1 accepted → 100% acceptance
      expect(kpis.acceptanceRate).toBe(100);
      expect(kpis.totalReferrals).toBe(1);
    });

    it('getDailyIntake with days=0 returns all-time data (no date filter)', () => {
      const all = getDailyIntake({ days: 0 });
      const limited = getDailyIntake({ days: 1 }); // last 1 day only
      // both referrals were inserted "now" so should appear in either window,
      // but all-time count >= limited count
      expect(all.reduce((s, d) => s + d.count, 0)).toBeGreaterThanOrEqual(
        limited.reduce((s, d) => s + d.count, 0),
      );
    });

    it('getTopDenialReasons filters by denialReason', () => {
      const reasons = getTopDenialReasons({ denialReason: 'Capacity unavailable' });
      expect(reasons).toHaveLength(1);
      expect(reasons[0].reason).toBe('Capacity unavailable');
    });

    it('getSkillMatchRates filters by skillName', () => {
      insertEvent('skill.evaluated', 'referral', 10, 'skill:payer-check', undefined, undefined, { matched: true, confidence: 0.9 });
      insertEvent('skill.evaluated', 'referral', 11, 'skill:urgency-flag', undefined, undefined, { matched: false, confidence: 0.5 });

      const rates = getSkillMatchRates({ skillName: 'payer-check' });
      expect(rates).toHaveLength(1);
      expect(rates[0].skill).toBe('payer-check');
    });

    it('getPriorAuthOutcomes filters by payer', () => {
      insertEvent('prior_auth.approved', 'priorAuth', 50, 'payer:BlueCross');
      insertEvent('prior_auth.denied', 'priorAuth', 51, 'payer:Aetna');

      const aetna = getPriorAuthOutcomes({ payer: 'Aetna' });
      expect(aetna.find((o) => o.outcome === 'denied')?.count).toBe(1);
      expect(aetna.find((o) => o.outcome === 'approved')).toBeUndefined();
    });
  });
});
