/**
 * Unit tests for workspaceView.ts (PRD-19)
 *
 * The payload is what the page is; if it lies about owner, status or the allowed
 * transitions, the page lies. So these tests care most about the three things
 * that are easy to get quietly wrong:
 *
 *   - nulls rather than throws when owner, queue and next action are unset,
 *     which is the NORMAL state for all of Phase 2
 *   - allowedWorkStatuses coming from the machine rather than a hand-kept list
 *   - the dual-status guarantee surviving into the view layer
 */

jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct', orgName: 'Specialist Care Group' },
    database: { url: ':memory:' },
  },
}));

jest.mock('../../../src/db', () => {
  const Database = require('better-sqlite3');
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const schema = require('../../../src/db/schema');

  const sqlite = new Database(':memory:');
  sqlite.exec(require('../../helpers/testSchema').TEST_SCHEMA_DDL);

  (global as Record<string, unknown>).__TEST_SQLITE__ = sqlite;

  return { db: drizzle(sqlite, { schema }) };
});

import { ReferralState } from '../../../src/state/referralStateMachine';
import { WorkStatus, allowedTransitions } from '../../../src/state/workStatusMachine';
import {
  createWorkspace,
  setWorkStatus,
  archiveWorkspace,
} from '../../../src/modules/workspace/workspaceService';
import {
  buildWorkspacePayload,
  listWorkspaceRows,
  workspaceIdForReferral,
} from '../../../src/modules/workspace/workspaceView';
import { ActingUser } from '../../../src/modules/workspace/identityService';

function sqlite(): import('better-sqlite3').Database {
  return (global as Record<string, unknown>).__TEST_SQLITE__ as import('better-sqlite3').Database;
}

function clearTables(): void {
  sqlite().exec(
    `DELETE FROM workflow_events;
     DELETE FROM prior_auth_requests;
     DELETE FROM outbound_messages;
     DELETE FROM referral_workspaces;
     DELETE FROM referrals;
     DELETE FROM patients;
     DELETE FROM users;`,
  );
}

let seq = 0;

interface ReferralOpts {
  state?: ReferralState;
  firstName?: string;
  lastName?: string;
  reason?: string | null;
  declineReason?: string | null;
  department?: string;
  equipment?: string | null;
  clinicalData?: string | null;
  assessment?: string | null;
  ccda?: string | null;
  priority?: 0 | 1;
}

function insertReferral(opts: ReferralOpts = {}): number {
  seq += 1;
  const patient = sqlite()
    .prepare(`INSERT INTO patients (first_name, last_name, date_of_birth) VALUES (?, ?, ?)`)
    .run(opts.firstName ?? 'Test', opts.lastName ?? `Patient${seq}`, '1980-01-01');
  const result = sqlite()
    .prepare(
      `INSERT INTO referrals
         (patient_id, source_message_id, referrer_address, reason_for_referral, state,
          decline_reason, routing_department, routing_equipment, clinical_data, ai_assessment,
          raw_ccda_xml, priority_flag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .run(
      patient.lastInsertRowid,
      `view-test-${seq}`,
      'ref@hospital.direct',
      opts.reason ?? 'Knee pain',
      opts.state ?? ReferralState.RECEIVED,
      opts.declineReason ?? null,
      opts.department ?? 'Orthopedics',
      opts.equipment ?? null,
      opts.clinicalData ?? null,
      opts.assessment ?? null,
      opts.ccda ?? null,
      opts.priority ?? 0,
    );
  return Number(result.lastInsertRowid);
}

function insertUser(displayName: string, email: string): number {
  const r = sqlite()
    .prepare(
      `INSERT INTO users (display_name, email, job_role, all_queues_access, active, created_at)
       VALUES (?, ?, 'coordinator', 0, 1, 0)`,
    )
    .run(displayName, email);
  return Number(r.lastInsertRowid);
}

const NOBODY: ActingUser | null = null;

beforeEach(clearTables);

describe('buildWorkspacePayload()', () => {
  it('returns null for an unknown id, so the route can 404 rather than throw', async () => {
    await expect(buildWorkspacePayload(9999, NOBODY)).resolves.toBeNull();
  });

  it('assembles the workspace, referral and patient slices', async () => {
    const referralId = insertReferral({
      state: ReferralState.ACCEPTED,
      firstName: 'Ada',
      lastName: 'Lovelace',
      reason: 'Second opinion',
      department: 'Cardiology',
    });
    const workspace = await createWorkspace(referralId);

    const payload = await buildWorkspacePayload(workspace.id, NOBODY);

    expect(payload).not.toBeNull();
    expect(payload!.workspace).toMatchObject({ id: workspace.id, referralId });
    expect(payload!.referral).toMatchObject({
      id: referralId,
      state: ReferralState.ACCEPTED,
      reasonForReferral: 'Second opinion',
      routingDepartment: 'Cardiology',
    });
    expect(payload!.patient).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      dateOfBirth: '1980-01-01',
    });
  });

  // ── The Phase-2 normal case ─────────────────────────────────────────────────

  it('returns nulls, not throws, when owner / queue / next action are unset', async () => {
    const workspace = await createWorkspace(insertReferral());

    const payload = await buildWorkspacePayload(workspace.id, NOBODY);

    expect(payload!.workspace.ownerUserId).toBeNull();
    expect(payload!.workspace.ownerDisplayName).toBeNull();
    expect(payload!.workspace.queueId).toBeNull();
    expect(payload!.workspace.queueName).toBeNull();
    expect(payload!.workspace.nextAction).toBeNull();
    expect(payload!.workspace.nextActionDueAt).toBeNull();
    expect(payload!.workspace.exceptionReason).toBeNull();
    expect(payload!.workspace.archivedAt).toBeNull();
    // NOT empty any more: PRD-24 seeds both parties inside createWorkspace, so
    // a workspace without its counterparties is no longer a reachable state.
    expect(payload!.parties.map((p) => p.partyRole)).toEqual(['initiating', 'receiving']);
    expect(payload!.participants).toEqual([]);
    expect(payload!.priorAuth).toEqual([]);
    expect(payload!.clinicalData).toBeNull();
    expect(payload!.assessment).toBeNull();
  });

  it('resolves the owner display name once a workspace has one', async () => {
    const userId = insertUser('Dana Ruiz', 'dana@example.test');
    const workspace = await createWorkspace(insertReferral());
    sqlite()
      .prepare(`UPDATE referral_workspaces SET owner_user_id = ? WHERE id = ?`)
      .run(userId, workspace.id);

    const payload = await buildWorkspacePayload(workspace.id, NOBODY);

    expect(payload!.workspace.ownerUserId).toBe(userId);
    expect(payload!.workspace.ownerDisplayName).toBe('Dana Ruiz');
  });

  it('leaves queueName null even when queueId is set — PRD-20 adds the table', async () => {
    const workspace = await createWorkspace(insertReferral());
    sqlite().prepare(`UPDATE referral_workspaces SET queue_id = 7 WHERE id = ?`).run(workspace.id);

    const payload = await buildWorkspacePayload(workspace.id, NOBODY);

    expect(payload!.workspace.queueId).toBe(7);
    expect(payload!.workspace.queueName).toBeNull();
  });

  // ── allowedWorkStatuses comes from the machine ──────────────────────────────

  it('matches the machine exactly for every current status', async () => {
    for (const status of Object.values(WorkStatus)) {
      const workspace = await createWorkspace(insertReferral());
      if (status !== WorkStatus.TRIAGE) {
        await setWorkStatus(workspace.id, status, 'system');
      }

      const payload = await buildWorkspacePayload(workspace.id, NOBODY);

      expect(payload!.workspace.workStatus).toBe(status);
      expect(payload!.workspace.allowedWorkStatuses).toEqual(allowedTransitions(status));
      expect(payload!.workspace.allowedWorkStatuses).not.toContain(status);
    }
  });

  it('exposes workStatusIsManual so the page knows whether to offer a resync', async () => {
    const workspace = await createWorkspace(insertReferral());

    let payload = await buildWorkspacePayload(workspace.id, NOBODY);
    expect(payload!.workspace.workStatusIsManual).toBe(false);

    await setWorkStatus(workspace.id, WorkStatus.IN_PROGRESS, 'user:1');

    payload = await buildWorkspacePayload(workspace.id, NOBODY);
    expect(payload!.workspace.workStatusIsManual).toBe(true);
    expect(payload!.workspace.workStatusSetBy).toBe('user:1');
  });

  // ── The dual-status guarantee, at the view layer ────────────────────────────

  it('reports the two statuses independently', async () => {
    const referralId = insertReferral({ state: ReferralState.SCHEDULED });
    const workspace = await createWorkspace(referralId);
    await setWorkStatus(workspace.id, WorkStatus.WAITING_INTERNAL, 'user:1');

    const payload = await buildWorkspacePayload(workspace.id, NOBODY);

    // Different dimensions, different values, neither derived from the other.
    expect(payload!.referral.state).toBe(ReferralState.SCHEDULED);
    expect(payload!.workspace.workStatus).toBe(WorkStatus.WAITING_INTERNAL);
  });

  it('renders for every protocol state without throwing (AC3)', async () => {
    for (const state of Object.values(ReferralState)) {
      const workspace = await createWorkspace(insertReferral({ state }));
      const payload = await buildWorkspacePayload(workspace.id, NOBODY);
      expect(payload!.referral.state).toBe(state);
    }
  });

  // ── Field handling ─────────────────────────────────────────────────────────

  it('reports hasCcda from the raw XML column, which drives the viewer pane', async () => {
    const withCcda = await createWorkspace(insertReferral({ ccda: '<ClinicalDocument/>' }));
    const without = await createWorkspace(insertReferral({ ccda: null }));

    await expect(buildWorkspacePayload(withCcda.id, NOBODY)).resolves.toMatchObject({
      referral: { hasCcda: true },
    });
    await expect(buildWorkspacePayload(without.id, NOBODY)).resolves.toMatchObject({
      referral: { hasCcda: false },
    });
  });

  it('parses routing equipment, clinical data and the assessment', async () => {
    const workspace = await createWorkspace(
      insertReferral({
        equipment: JSON.stringify(['mri-1', 'room-3']),
        clinicalData: JSON.stringify({ problems: [{ name: 'Hypertension' }] }),
        assessment: JSON.stringify({ suggestedDepartment: 'Cardiology' }),
      }),
    );

    const payload = await buildWorkspacePayload(workspace.id, NOBODY);

    expect(payload!.referral.routingEquipment).toEqual(['mri-1', 'room-3']);
    expect(payload!.clinicalData).toEqual({ problems: [{ name: 'Hypertension' }] });
    expect(payload!.assessment).toEqual({ suggestedDepartment: 'Cardiology' });
  });

  it('survives malformed JSON in those columns rather than failing the page', async () => {
    const workspace = await createWorkspace(
      insertReferral({
        equipment: 'not json',
        clinicalData: '{oops',
        assessment: '[',
      }),
    );

    const payload = await buildWorkspacePayload(workspace.id, NOBODY);

    expect(payload!.referral.routingEquipment).toEqual([]);
    expect(payload!.clinicalData).toBeNull();
    expect(payload!.assessment).toBeNull();
  });

  it('includes linked prior authorization requests, newest first', async () => {
    const referralId = insertReferral();
    const workspace = await createWorkspace(referralId);
    const patientId = (
      sqlite().prepare(`SELECT patient_id AS p FROM referrals WHERE id = ?`).get(referralId) as {
        p: number;
      }
    ).p;

    for (const [code, insurer, created] of [
      ['70551', 'Aetna', 100],
      ['72148', 'Cigna', 200],
    ] as const) {
      sqlite()
        .prepare(
          `INSERT INTO prior_auth_requests
             (referral_id, patient_id, state, claim_json, insurer_name, insurer_id,
              service_code, provider_npi, provider_name, created_at, updated_at)
           VALUES (?, ?, 'Submitted', '{}', ?, 'INS1', ?, '1234567890', 'Dr Test', ?, ?)`,
        )
        .run(referralId, patientId, insurer, code, created, created);
    }

    const payload = await buildWorkspacePayload(workspace.id, NOBODY);

    expect(payload!.priorAuth).toHaveLength(2);
    expect(payload!.priorAuth[0].serviceCode).toBe('72148');
    expect(payload!.priorAuth[1].serviceCode).toBe('70551');
  });

  it('reports archivedAt so the page can render read-only', async () => {
    const workspace = await createWorkspace(insertReferral());
    await setWorkStatus(workspace.id, WorkStatus.RESOLVED, 'user:1');
    await archiveWorkspace(workspace.id, 'user:1');

    const payload = await buildWorkspacePayload(workspace.id, NOBODY);

    expect(payload!.workspace.archivedAt).not.toBeNull();
    expect(new Date(payload!.workspace.archivedAt as string).getTime()).not.toBeNaN();
  });

  it('switches on the panels that are built and leaves the rest for their PRDs', async () => {
    const workspace = await createWorkspace(insertReferral());

    const payload = await buildWorkspacePayload(workspace.id, NOBODY);

    // A slot flips to true exactly when its PRD lands: `owner` in PRD-21,
    // `participants` in PRD-24, `conversation` in PRD-22, `documents` in
    // PRD-23. Only PRD-25's activity feed is left. Asserting the whole object
    // rather than one key means the next PRD has to come past this test, so a
    // panel cannot be half-wired — live code behind a flag saying otherwise.
    expect(payload!.slots).toEqual({
      owner: true,
      participants: true,
      conversation: true,
      documents: true,
      activity: false,
    });
  });

  it('passes the acting user straight through', async () => {
    const workspace = await createWorkspace(insertReferral());
    const acting: ActingUser = {
      id: 3,
      displayName: 'Priya Raman',
      email: 'priya@example.test',
      directAddress: null,
      jobRole: 'coordinator',
      legacyClinicianId: null,
      allQueuesAccess: false,
      active: true,
    };

    const payload = await buildWorkspacePayload(workspace.id, acting);

    expect(payload!.actingUser).toEqual(acting);
  });
});

describe('workspaceIdForReferral()', () => {
  it('resolves a referral to its workspace id', async () => {
    const referralId = insertReferral();
    const workspace = await createWorkspace(referralId);

    await expect(workspaceIdForReferral(referralId)).resolves.toBe(workspace.id);
  });

  it('returns null for a referral with no workspace, so the route can 404', async () => {
    const referralId = insertReferral();

    await expect(workspaceIdForReferral(referralId)).resolves.toBeNull();
  });
});

describe('listWorkspaceRows()', () => {
  it('returns an empty list on an empty database', async () => {
    await expect(listWorkspaceRows()).resolves.toEqual([]);
  });

  it('summarises each workspace with both statuses and the patient name', async () => {
    const referralId = insertReferral({
      state: ReferralState.SCHEDULED,
      firstName: 'Grace',
      lastName: 'Hopper',
      department: 'Neurology',
      priority: 1,
    });
    const workspace = await createWorkspace(referralId);
    await setWorkStatus(workspace.id, WorkStatus.WAITING_EXTERNAL, 'system');

    const rows = await listWorkspaceRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: workspace.id,
      referralId,
      patientName: 'Grace Hopper',
      protocolState: ReferralState.SCHEDULED,
      workStatus: WorkStatus.WAITING_EXTERNAL,
      routingDepartment: 'Neurology',
      priorityFlag: true,
      archived: false,
      ownerDisplayName: null,
    });
  });

  it('marks archived workspaces and resolves owner names', async () => {
    const userId = insertUser('Sam Okafor', 'sam@example.test');
    const workspace = await createWorkspace(insertReferral());
    sqlite()
      .prepare(`UPDATE referral_workspaces SET owner_user_id = ? WHERE id = ?`)
      .run(userId, workspace.id);
    await setWorkStatus(workspace.id, WorkStatus.RESOLVED, 'user:1');
    await archiveWorkspace(workspace.id, 'user:1');

    const rows = await listWorkspaceRows();

    expect(rows[0].ownerDisplayName).toBe('Sam Okafor');
    expect(rows[0].archived).toBe(true);
  });

  it('orders by most recently updated first', async () => {
    const a = await createWorkspace(insertReferral());
    const b = await createWorkspace(insertReferral());
    sqlite().prepare(`UPDATE referral_workspaces SET updated_at = ? WHERE id = ?`).run(100, a.id);
    sqlite().prepare(`UPDATE referral_workspaces SET updated_at = ? WHERE id = ?`).run(900, b.id);

    const rows = await listWorkspaceRows();

    expect(rows.map((r) => r.workspaceId)).toEqual([b.id, a.id]);
  });

  it('reports the manual flag, so the index can mark a held status', async () => {
    const held = await createWorkspace(insertReferral());
    const tracking = await createWorkspace(insertReferral());
    await setWorkStatus(held.id, WorkStatus.WAITING_INTERNAL, 'user:1');

    const rows = await listWorkspaceRows();
    const byId = new Map(rows.map((r) => [r.workspaceId, r]));

    expect(byId.get(held.id)!.workStatusIsManual).toBe(true);
    expect(byId.get(tracking.id)!.workStatusIsManual).toBe(false);
  });
});
