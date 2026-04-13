/**
 * Analytics Demo Seed Script
 *
 * Inserts synthetic data directly into SQLite to demonstrate the /analytics
 * dashboard. Bypasses SMTP/IMAP entirely — all records are constructed
 * programmatically with realistic distributions.
 *
 * Usage:  npm run seed:analytics
 *
 * Dataset:
 *   - 80 patients + 80 referrals spread across the last 90 days
 *   - 6 departments, 4 clinicians, realistic state distribution
 *   - Full workflow_events sequence per referral
 *   - 15 prior auth request/response pairs (3 payers)
 *   - 40 skill evaluations across 3 skills
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { config } from '../src/config';

// ── Helpers ───────────────────────────────────────────────────────────────────

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function daysAgo(n: number, jitterHours = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(d.getHours() - jitterHours);
  return d;
}

function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3600000);
}

function fmtTs(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// ── Reference Data ────────────────────────────────────────────────────────────

const FIRST_NAMES = [
  'James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda',
  'William', 'Barbara', 'David', 'Elizabeth', 'Richard', 'Susan', 'Joseph', 'Jessica',
  'Thomas', 'Sarah', 'Charles', 'Karen', 'Christopher', 'Lisa', 'Daniel', 'Nancy',
  'Matthew', 'Betty', 'Anthony', 'Margaret', 'Mark', 'Sandra', 'Donald', 'Ashley',
  'Steven', 'Dorothy', 'Paul', 'Kimberly', 'Andrew', 'Emily', 'Joshua', 'Donna',
  'Kenneth', 'Michelle', 'Kevin', 'Carol', 'Brian', 'Amanda', 'George', 'Melissa',
  'Timothy', 'Deborah', 'Ronald', 'Stephanie', 'Edward', 'Rebecca', 'Jason', 'Sharon',
  'Jeffrey', 'Laura', 'Ryan', 'Cynthia', 'Jacob', 'Kathleen', 'Gary', 'Amy',
  'Nicholas', 'Angela', 'Eric', 'Shirley', 'Jonathan', 'Anna', 'Stephen', 'Brenda',
  'Larry', 'Pamela', 'Justin', 'Emma', 'Scott', 'Nicole', 'Brandon', 'Helen',
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
  'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson',
  'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker',
  'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
];

const DEPARTMENTS = [
  'Cardiology', 'Neurology', 'Orthopedics',
  'Oncology', 'Gastroenterology', 'General Surgery',
];

const CLINICIANS = ['dr-chen', 'dr-rodriguez', 'dr-patel', 'dr-kim'];

// Acceptance rates per clinician (probability of accepting a referral)
const CLINICIAN_ACCEPT_RATE: Record<string, number> = {
  'dr-chen': 0.85,
  'dr-rodriguez': 0.70,
  'dr-patel': 0.90,
  'dr-kim': 0.60,
};

const DECLINE_REASONS = [
  'Out-of-network patient',
  'Insufficient clinical information',
  'Patient does not meet criteria',
  'Capacity unavailable',
  'Requires tertiary care',
];

const PAYERS = [
  { name: 'Blue Cross Blue Shield', id: 'bcbs', approveRate: 0.80 },
  { name: 'Aetna', id: 'aetna', approveRate: 0.50 },
  { name: 'United Health', id: 'united', approveRate: 0.30 },
];

const PA_DENIAL_REASONS = [
  'Not medically necessary',
  'Experimental procedure',
  'Requires peer-to-peer review',
  'Out-of-network provider',
  'Service requires pre-certification',
];

const SKILLS = [
  { name: 'out-of-network-decline', matchRate: 0.30, confidenceRange: [0.75, 0.98] as [number, number] },
  { name: 'urgency-flag', matchRate: 0.25, confidenceRange: [0.60, 0.92] as [number, number] },
  { name: 'completeness-check', matchRate: 0.45, confidenceRange: [0.65, 0.95] as [number, number] },
];

// Target state distribution for 80 referrals
const STATE_DISTRIBUTION = [
  { state: 'Closed-Confirmed', count: 30 },
  { state: 'Declined',         count: 12 },
  { state: 'Scheduled',        count: 10 },
  { state: 'Encounter',        count: 8  },
  { state: 'Closed',           count: 7  },
  { state: 'Pending-Information', count: 5 },
  { state: 'Received',         count: 4  },
  { state: 'Acknowledged',     count: 4  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Seeding analytics demo data...\n');

  const dbPath = config.database.url === ':memory:' ? './referral.db' : config.database.url;
  const sqlite = new Database(dbPath);

  // ── Clear existing analytics-seed data ────────────────────────────────────
  // We clear workflow_events, skill_executions, prior_auth tables, and
  // referrals/patients that were inserted by this script (identified by
  // source_message_id prefix 'analytics-seed-').
  sqlite.exec(`
    DELETE FROM workflow_events WHERE entity_id IN (
      SELECT id FROM referrals WHERE source_message_id LIKE 'analytics-seed-%'
    ) AND entity_type = 'referral';
    DELETE FROM prior_auth_responses WHERE request_id IN (
      SELECT par.id FROM prior_auth_requests par
      JOIN referrals r ON par.referral_id = r.id
      WHERE r.source_message_id LIKE 'analytics-seed-%'
    );
    DELETE FROM prior_auth_requests WHERE referral_id IN (
      SELECT id FROM referrals WHERE source_message_id LIKE 'analytics-seed-%'
    );
    DELETE FROM skill_executions WHERE referral_id IN (
      SELECT id FROM referrals WHERE source_message_id LIKE 'analytics-seed-%'
    );
    DELETE FROM outbound_messages WHERE referral_id IN (
      SELECT id FROM referrals WHERE source_message_id LIKE 'analytics-seed-%'
    );
    DELETE FROM referrals WHERE source_message_id LIKE 'analytics-seed-%';
    DELETE FROM workflow_events WHERE entity_id IN (
      SELECT id FROM prior_auth_requests WHERE insurer_id LIKE 'analytics-seed-%'
    ) AND entity_type = 'priorAuth';
    DELETE FROM prior_auth_responses WHERE request_id IN (
      SELECT id FROM prior_auth_requests WHERE insurer_id LIKE 'analytics-seed-%'
    );
    DELETE FROM prior_auth_requests WHERE insurer_id LIKE 'analytics-seed-%';
  `);

  console.log('Cleared existing seed data.');

  // ── Insert patients ────────────────────────────────────────────────────────
  const insertPatient = sqlite.prepare(`
    INSERT INTO patients (first_name, last_name, date_of_birth)
    VALUES (?, ?, ?)
  `);

  const patientIds: number[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < 80; i++) {
    let firstName: string, lastName: string;
    do {
      firstName = FIRST_NAMES[i % FIRST_NAMES.length];
      lastName = LAST_NAMES[randInt(0, LAST_NAMES.length - 1)];
    } while (usedNames.has(`${firstName}${lastName}`));
    usedNames.add(`${firstName}${lastName}`);

    const year = randInt(1945, 1995);
    const month = String(randInt(1, 12)).padStart(2, '0');
    const day = String(randInt(1, 28)).padStart(2, '0');

    const result = insertPatient.run(firstName, lastName, `${year}-${month}-${day}`);
    patientIds.push(result.lastInsertRowid as number);
  }

  console.log(`Inserted ${patientIds.length} patients.`);

  // ── Build referral plan (state distribution) ──────────────────────────────
  const referralPlan: { state: string }[] = [];
  for (const { state, count } of STATE_DISTRIBUTION) {
    for (let i = 0; i < count; i++) {
      referralPlan.push({ state });
    }
  }
  // Shuffle
  for (let i = referralPlan.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [referralPlan[i], referralPlan[j]] = [referralPlan[j], referralPlan[i]];
  }

  // ── Insert referrals + events ─────────────────────────────────────────────
  const insertReferral = sqlite.prepare(`
    INSERT INTO referrals (
      patient_id, source_message_id, referrer_address, reason_for_referral,
      state, clinician_id, appointment_date, routing_department,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEvent = sqlite.prepare(`
    INSERT INTO workflow_events (
      event_type, entity_type, entity_id, from_state, to_state, actor, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const referralIds: number[] = [];
  const paEligibleReferralIds: number[] = [];

  for (let idx = 0; idx < referralPlan.length; idx++) {
    const targetState = referralPlan[idx].state;
    const patientId = patientIds[idx];
    const clinician = pickOne(CLINICIANS);
    const department = pickOne(DEPARTMENTS);
    const daysBack = randInt(1, 88);
    const createdAt = daysAgo(daysBack, randInt(0, 8));
    const referrerAddress = `dr-referring-${randInt(1, 20)}@hospital.direct`;
    const sourceMessageId = `analytics-seed-${idx}-${Date.now()}`;

    const reasons = [
      'Chest pain and dyspnea on exertion',
      'Follow-up for abnormal ECG findings',
      'Recurrent headaches with visual disturbance',
      'Lower back pain unresponsive to conservative treatment',
      'Colon polyp surveillance post-polypectomy',
      'Abdominal pain with elevated liver enzymes',
      'Suspicious breast mass on mammogram',
      'Knee pain limiting ambulation',
      'Peripheral neuropathy evaluation',
      'Shortness of breath with reduced exercise tolerance',
    ];
    const reason = pickOne(reasons);

    let appointmentDate: string | null = null;
    if (['Scheduled', 'Encounter', 'Closed', 'Closed-Confirmed'].includes(targetState)) {
      const apptDays = daysBack - randInt(3, 15);
      if (apptDays > 0) {
        appointmentDate = daysAgo(apptDays).toISOString().split('T')[0];
      }
    }

    const result = insertReferral.run(
      patientId,
      sourceMessageId,
      referrerAddress,
      reason,
      targetState,
      ['Accepted', 'Scheduled', 'Encounter', 'Closed', 'Closed-Confirmed'].includes(targetState)
        ? clinician
        : null,
      appointmentDate,
      department,
      createdAt.getTime(),
      createdAt.getTime(),
    );

    const referralId = result.lastInsertRowid as number;
    referralIds.push(referralId);

    // ── Emit events for this referral's lifecycle ──────────────────────────
    let t = createdAt;

    // All referrals start with received + acknowledged
    insertEvent.run('referral.received', 'referral', referralId, null, 'Received', 'system',
      JSON.stringify({ sourceMessageId, referrerAddress }), fmtTs(t));

    t = addHours(t, randInt(0, 2));
    insertEvent.run('referral.acknowledged', 'referral', referralId, 'Received', 'Acknowledged', 'system',
      null, fmtTs(t));

    if (targetState === 'Received' || targetState === 'Acknowledged') {
      continue; // stop here for early-stage referrals
    }

    t = addHours(t, randInt(1, 4));
    insertEvent.run('referral.routing_assessed', 'referral', referralId, null, null, 'system',
      JSON.stringify({ department }), fmtTs(t));

    // Declined path
    if (targetState === 'Declined') {
      const declineReason = pickOne(DECLINE_REASONS);
      t = addHours(t, randInt(2, 12));
      insertEvent.run('referral.declined', 'referral', referralId, 'Acknowledged', 'Declined',
        `clinician:${clinician}`,
        JSON.stringify({ clinicianId: clinician, denialReason: declineReason }),
        fmtTs(t));
      continue;
    }

    // Pending-Information path
    if (targetState === 'Pending-Information') {
      t = addHours(t, randInt(1, 6));
      insertEvent.run('referral.pending_info', 'referral', referralId, 'Acknowledged', 'Pending-Information',
        `skill:completeness-check`, null, fmtTs(t));
      continue;
    }

    // Accepted → further processing
    t = addHours(t, randInt(2, 8));
    insertEvent.run('referral.accepted', 'referral', referralId, 'Acknowledged', 'Accepted',
      `clinician:${clinician}`,
      JSON.stringify({ clinicianId: clinician }),
      fmtTs(t));

    // Mark for prior auth (30 out of accepted referrals)
    if (paEligibleReferralIds.length < 15 && Math.random() < 0.5) {
      paEligibleReferralIds.push(referralId);
    }

    if (targetState === 'Accepted') continue;

    // Scheduled
    t = addHours(t, randInt(12, 48));
    insertEvent.run('referral.scheduled', 'referral', referralId, 'Accepted', 'Scheduled', 'system',
      JSON.stringify({ appointmentDate, location: `${department} Clinic` }),
      fmtTs(t));

    if (targetState === 'Scheduled') continue;

    // Encounter
    t = addHours(t, randInt(24, 168));
    insertEvent.run('referral.encounter_complete', 'referral', referralId, 'Scheduled', 'Encounter', 'system',
      null, fmtTs(t));

    if (targetState === 'Encounter') continue;

    // Closed (consult note sent)
    t = addHours(t, randInt(1, 24));
    insertEvent.run('referral.closed', 'referral', referralId, 'Encounter', 'Closed', 'system',
      JSON.stringify({ messageType: 'ConsultNote' }),
      fmtTs(t));

    if (targetState === 'Closed') continue;

    // Closed-Confirmed
    t = addHours(t, randInt(1, 12));
    insertEvent.run('referral.closed_confirmed', 'referral', referralId, 'Closed', 'Closed-Confirmed', 'system',
      null, fmtTs(t));
  }

  console.log(`Inserted ${referralIds.length} referrals with workflow events.`);

  // ── Prior Auth requests/responses ─────────────────────────────────────────
  const insertPaRequest = sqlite.prepare(`
    INSERT INTO prior_auth_requests (
      referral_id, patient_id, state, claim_json, insurer_name, insurer_id,
      service_code, service_display, provider_npi, provider_name,
      created_at, updated_at, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPaResponse = sqlite.prepare(`
    INSERT INTO prior_auth_responses (
      request_id, response_json, outcome, auth_number, denial_reason, received_via, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const SERVICE_CODES = ['99213', '93000', '70553', '27447', '45378', '47562'];
  const SERVICE_NAMES: Record<string, string> = {
    '99213': 'Office Visit', '93000': 'Electrocardiogram', '70553': 'MRI Brain',
    '27447': 'Total Knee Arthroplasty', '45378': 'Colonoscopy', '47562': 'Laparoscopic Cholecystectomy',
  };

  const paReferralIds = paEligibleReferralIds.slice(0, 15);
  let paCount = 0;

  for (const referralId of paReferralIds) {
    const payer = pickOne(PAYERS);
    const serviceCode = pickOne(SERVICE_CODES);
    const daysBack = randInt(5, 80);
    const createdAt = daysAgo(daysBack);
    const submittedAt = addHours(createdAt, randInt(1, 4));
    const respondedAt = addHours(submittedAt, randInt(1, 24));

    const approved = Math.random() < payer.approveRate;
    const pended = !approved && Math.random() < 0.2;
    const outcome = approved ? 'approved' : pended ? 'pended' : 'denied';
    const denialReason = outcome === 'denied' ? pickOne(PA_DENIAL_REASONS) : null;

    const paState = outcome === 'approved' ? 'Approved'
      : outcome === 'denied' ? 'Denied'
      : 'Pended';

    const paResult = insertPaRequest.run(
      referralId,
      patientIds[referralIds.indexOf(referralId)] ?? patientIds[0],
      paState,
      JSON.stringify({ resourceType: 'Claim', id: `claim-${paCount}` }),
      payer.name,
      `analytics-seed-${payer.id}`,
      serviceCode,
      SERVICE_NAMES[serviceCode] ?? serviceCode,
      `1234567890`,
      `Dr. Specialist`,
      createdAt.getTime(),
      respondedAt.getTime(),
      submittedAt.getTime(),
    );

    const paId = paResult.lastInsertRowid as number;

    insertPaResponse.run(
      paId,
      JSON.stringify({ resourceType: 'ClaimResponse', outcome }),
      outcome,
      outcome === 'approved' ? `AUTH-${randInt(10000, 99999)}` : null,
      denialReason,
      'sync',
      respondedAt.getTime(),
    );

    // Emit PA events
    insertEvent.run(`prior_auth.submitted`, 'priorAuth', paId, null, 'Submitted',
      'system',
      JSON.stringify({ insurerName: payer.name, serviceCode }),
      fmtTs(submittedAt));

    insertEvent.run(`prior_auth.${outcome}`, 'priorAuth', paId, 'Submitted', paState,
      `payer:${payer.name}`,
      JSON.stringify({
        ...(denialReason ? { denialReason } : {}),
        ...(outcome === 'approved' ? { authNumber: `AUTH-${randInt(10000, 99999)}` } : {}),
        receivedVia: 'sync',
      }),
      fmtTs(respondedAt));

    paCount++;
  }

  console.log(`Inserted ${paCount} prior auth request/response pairs.`);

  // ── Skill evaluations ──────────────────────────────────────────────────────
  const insertSkillExecution = sqlite.prepare(`
    INSERT INTO skill_executions (
      skill_name, referral_id, trigger_point, matched, confidence,
      action_taken, explanation, executed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let skillCount = 0;
  const skillReferralIds = referralIds.slice(0, 40);

  for (const referralId of skillReferralIds) {
    const skill = SKILLS[skillCount % SKILLS.length];
    const matched = Math.random() < skill.matchRate;
    const [minConf, maxConf] = skill.confidenceRange;
    const confidence = (minConf + Math.random() * (maxConf - minConf)).toFixed(3);
    const triggerPoint = pickOne(['post-intake', 'post-acceptance', 'encounter-complete']);
    const daysBack = randInt(1, 85);
    const executedAt = daysAgo(daysBack, randInt(0, 4));

    const explanation = matched
      ? `Skill conditions met: patient data satisfies ${skill.name} criteria.`
      : `Skill conditions not met: insufficient data for ${skill.name}.`;

    const seResult = insertSkillExecution.run(
      skill.name, referralId, triggerPoint,
      matched ? 1 : 0, confidence,
      matched ? 'auto-action' : null,
      explanation,
      executedAt.getTime(),
    );

    const seId = seResult.lastInsertRowid as number;

    // Emit skill.evaluated event
    insertEvent.run('skill.evaluated', 'referral', referralId, null, null,
      `skill:${skill.name}`,
      JSON.stringify({
        triggerPoint,
        matched,
        confidence: parseFloat(confidence),
        explanation,
        skillExecutionId: seId,
      }),
      fmtTs(executedAt));

    if (matched) {
      insertEvent.run('skill.action_executed', 'referral', referralId, null, null,
        `skill:${skill.name}`,
        JSON.stringify({ actionType: 'auto-action', skillName: skill.name }),
        fmtTs(addHours(executedAt, 0.1)));
    }

    skillCount++;
  }

  console.log(`Inserted ${skillCount} skill evaluations.`);

  sqlite.close();

  console.log('\n✓ Analytics demo seed complete!\n');
  console.log('Run `npm run dev` then visit http://localhost:3000/analytics');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
