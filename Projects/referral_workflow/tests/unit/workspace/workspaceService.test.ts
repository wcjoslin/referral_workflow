/**
 * Unit tests for workspaceService.ts (PRD-18)
 *
 * The centre of gravity here is the advisory proposal rule and the dual-status
 * guarantee: a work status write must never touch `referrals.state`, and a
 * protocol event must never overwrite a status a person set.
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
import { InvalidWorkStatusTransitionError, WorkStatus } from '../../../src/state/workStatusMachine';
import {
  WorkspaceAlreadyExistsError,
  WorkspaceNotArchivableError,
  WorkspaceNotFoundError,
  archiveWorkspace,
  backfillWorkspaces,
  createWorkspace,
  getWorkspace,
  getWorkspaceByReferralId,
  hasOpenInternalItems,
  proposeForReferral,
  proposeWorkStatus,
  resyncWorkStatus,
  setWorkStatus,
} from '../../../src/modules/workspace/workspaceService';

/** A real `users` row, because a mention target must exist and be active. */
function insertUser(displayName: string): number {
  referralSeq += 1;
  const result = sqlite()
    .prepare(
      `INSERT INTO users (display_name, email, job_role, all_queues_access, active, created_at)
       VALUES (?, ?, 'coordinator', 0, 1, 0)`,
    )
    .run(displayName, `u${referralSeq}@example.test`);
  return Number(result.lastInsertRowid);
}

/** The ActingUser shape postComment takes; only the id is load-bearing. */
function actingUser(id: number, displayName: string): import(
  '../../../src/modules/workspace/identityService'
).ActingUser {
  return {
    id,
    displayName,
    email: `${id}@example.test`,
    directAddress: null,
    jobRole: 'coordinator',
    legacyClinicianId: null,
    allQueuesAccess: false,
    active: true,
  };
}

function sqlite(): import('better-sqlite3').Database {
  return (global as Record<string, unknown>).__TEST_SQLITE__ as import('better-sqlite3').Database;
}

function clearTables(): void {
  sqlite().exec(
    'DELETE FROM workflow_events; DELETE FROM referral_workspaces; DELETE FROM referrals; DELETE FROM patients; DELETE FROM users;',
  );
}

let referralSeq = 0;

/** Inserts a referral directly and returns its id. */
function insertReferral(state: ReferralState = ReferralState.RECEIVED): number {
  referralSeq += 1;
  const patient = sqlite()
    .prepare(`INSERT INTO patients (first_name, last_name, date_of_birth) VALUES (?, ?, ?)`)
    .run('Test', `Patient${referralSeq}`, '1980-01-01');
  const result = sqlite()
    .prepare(
      `INSERT INTO referrals (patient_id, source_message_id, referrer_address, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0)`,
    )
    .run(patient.lastInsertRowid, `ws-test-${referralSeq}`, 'ref@hospital.direct', state);
  return Number(result.lastInsertRowid);
}

function referralState(referralId: number): string {
  const row = sqlite().prepare(`SELECT state FROM referrals WHERE id = ?`).get(referralId) as {
    state: string;
  };
  return row.state;
}

function events(
  eventType?: string,
): { event_type: string; actor: string; metadata: string | null }[] {
  const rows = sqlite()
    .prepare(
      `SELECT event_type, from_state, to_state, actor, metadata FROM workflow_events ORDER BY id`,
    )
    .all() as { event_type: string; actor: string; metadata: string | null }[];
  return eventType ? rows.filter((r) => r.event_type === eventType) : rows;
}

/** emitEvent() is fire-and-forget, so let its insert land before asserting. */
async function flushEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('workspaceService', () => {
  beforeEach(() => clearTables());

  // ── Creation ──────────────────────────────────────────────────────────────

  describe('createWorkspace()', () => {
    it('creates a workspace at Triage with no owner and no manual flag', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);

      expect(workspace).toMatchObject({
        referralId,
        workStatus: WorkStatus.TRIAGE,
        workStatusIsManual: false,
        ownerUserId: null,
        queueId: null,
        archivedAt: null,
      });
    });

    it('emits workspace.created naming system as the actor', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);
      await flushEvents();

      const created = events('workspace.created');
      expect(created).toHaveLength(1);
      expect(created[0].actor).toBe('system');
      expect(JSON.parse(created[0].metadata as string)).toMatchObject({
        workspaceId: workspace.id,
      });
    });

    it('rejects a second workspace for the same referral', async () => {
      const referralId = insertReferral();
      await createWorkspace(referralId);
      await expect(createWorkspace(referralId)).rejects.toThrow(WorkspaceAlreadyExistsError);
    });

    it('is findable by id and by referral id', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);

      await expect(getWorkspace(workspace.id)).resolves.toMatchObject({ id: workspace.id });
      await expect(getWorkspaceByReferralId(referralId)).resolves.toMatchObject({
        id: workspace.id,
      });
    });

    it('returns null for unknown or non-integer lookups', async () => {
      await expect(getWorkspace(9999)).resolves.toBeNull();
      await expect(getWorkspace(1.5)).resolves.toBeNull();
      await expect(getWorkspaceByReferralId(9999)).resolves.toBeNull();
    });
  });

  // ── The dual-status guarantee ─────────────────────────────────────────────

  describe('dual status independence', () => {
    it('a work status change leaves referrals.state untouched', async () => {
      const referralId = insertReferral(ReferralState.ACCEPTED);
      const workspace = await createWorkspace(referralId);

      await setWorkStatus(workspace.id, WorkStatus.WAITING_INTERNAL, 'user:1');

      expect(referralState(referralId)).toBe(ReferralState.ACCEPTED);
    });

    it('a protocol proposal leaves referrals.state untouched', async () => {
      const referralId = insertReferral(ReferralState.ACCEPTED);
      const workspace = await createWorkspace(referralId);

      await proposeWorkStatus(workspace.id, ReferralState.SCHEDULED);

      // The proposal advises the workspace; it is not what moves the protocol.
      expect(referralState(referralId)).toBe(ReferralState.ACCEPTED);
    });
  });

  // ── setWorkStatus ─────────────────────────────────────────────────────────

  describe('setWorkStatus()', () => {
    it('guards through the machine and writes nothing on an invalid transition', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);
      await setWorkStatus(workspace.id, WorkStatus.RESOLVED, 'user:1');

      await expect(setWorkStatus(workspace.id, WorkStatus.TRIAGE, 'user:1')).rejects.toThrow(
        InvalidWorkStatusTransitionError,
      );

      const after = await getWorkspace(workspace.id);
      expect(after?.workStatus).toBe(WorkStatus.RESOLVED);
    });

    it('sets the manual flag, the actor and the timestamp', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);

      const updated = await setWorkStatus(
        workspace.id,
        WorkStatus.IN_PROGRESS,
        'user:7',
        'picked up',
      );

      expect(updated.workStatus).toBe(WorkStatus.IN_PROGRESS);
      expect(updated.workStatusIsManual).toBe(true);
      expect(updated.workStatusSetBy).toBe('user:7');
      expect(updated.workStatusSetAt).toBeInstanceOf(Date);
    });

    it('emits work_status_changed with from, to, actor and the reason', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);
      await setWorkStatus(workspace.id, WorkStatus.IN_PROGRESS, 'user:7', 'picked up');
      await flushEvents();

      const changed = events('workspace.work_status_changed');
      expect(changed).toHaveLength(1);
      expect(changed[0].actor).toBe('user:7');
      expect(JSON.parse(changed[0].metadata as string)).toMatchObject({
        workspaceId: workspace.id,
        manual: true,
        reason: 'picked up',
      });
    });

    it('throws for an unknown workspace', async () => {
      await expect(setWorkStatus(9999, WorkStatus.IN_PROGRESS, 'user:1')).rejects.toThrow(
        WorkspaceNotFoundError,
      );
    });
  });

  // ── The proposal rule ─────────────────────────────────────────────────────

  describe('proposeWorkStatus()', () => {
    it('applies when the status was last written by the mapping', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);

      const result = await proposeWorkStatus(workspace.id, ReferralState.ACCEPTED);

      expect(result).toMatchObject({
        applied: true,
        workStatus: WorkStatus.IN_PROGRESS,
        proposed: WorkStatus.IN_PROGRESS,
      });
      const after = await getWorkspace(workspace.id);
      expect(after?.workStatusIsManual).toBe(false);
    });

    it('declines with reason "manual" once a person has set the status, and writes nothing', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);
      await setWorkStatus(workspace.id, WorkStatus.WAITING_INTERNAL, 'user:1');

      const result = await proposeWorkStatus(workspace.id, ReferralState.SCHEDULED);

      expect(result).toMatchObject({
        applied: false,
        declinedReason: 'manual',
        workStatus: WorkStatus.WAITING_INTERNAL,
        proposed: WorkStatus.WAITING_EXTERNAL,
      });
      const after = await getWorkspace(workspace.id);
      expect(after?.workStatus).toBe(WorkStatus.WAITING_INTERNAL);
    });

    it('records the declined proposal so the path is auditable', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);
      await setWorkStatus(workspace.id, WorkStatus.WAITING_INTERNAL, 'user:1');
      await proposeWorkStatus(workspace.id, ReferralState.SCHEDULED);
      await flushEvents();

      const declined = events('workspace.work_status_proposal_declined');
      expect(declined).toHaveLength(1);
      expect(JSON.parse(declined[0].metadata as string)).toMatchObject({
        proposed: WorkStatus.WAITING_EXTERNAL,
        current: WorkStatus.WAITING_INTERNAL,
        declinedReason: 'manual',
      });
    });

    it.each([
      ['Exception', WorkStatus.EXCEPTION],
      ['Follow-up-Required', WorkStatus.FOLLOW_UP_REQUIRED],
    ])('declines with "protected" from %s even when the flag is clear', async (_label, status) => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);
      // Reach the status through the mapping-free path, then clear the flag so
      // only the protection can be what declines the proposal.
      await setWorkStatus(workspace.id, status, 'system');
      sqlite()
        .prepare(`UPDATE referral_workspaces SET work_status_is_manual = 0 WHERE id = ?`)
        .run(workspace.id);

      const result = await proposeWorkStatus(workspace.id, ReferralState.ACCEPTED);

      expect(result).toMatchObject({ applied: false, declinedReason: 'protected' });
      const after = await getWorkspace(workspace.id);
      expect(after?.workStatus).toBe(status);
    });

    it('declines an already-correct status quietly, without spending an audit row', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);

      const result = await proposeWorkStatus(workspace.id, ReferralState.ACKNOWLEDGED);
      await flushEvents();

      expect(result).toMatchObject({ applied: false, declinedReason: 'same-status' });
      expect(events('workspace.work_status_proposal_declined')).toHaveLength(0);
    });

    it('declines on an archived workspace', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);
      await setWorkStatus(workspace.id, WorkStatus.RESOLVED, 'user:1');
      await archiveWorkspace(workspace.id, 'user:1');

      const result = await proposeWorkStatus(workspace.id, ReferralState.ACCEPTED);
      expect(result).toMatchObject({ applied: false, declinedReason: 'archived' });
    });

    it('maps every protocol state to a valid status without throwing', async () => {
      for (const state of Object.values(ReferralState)) {
        const referralId = insertReferral(state);
        const workspace = await createWorkspace(referralId);

        const result = await proposeWorkStatus(workspace.id, state);

        expect(Object.values(WorkStatus)).toContain(result.proposed);
      }
    });

    it('throws for an unknown workspace', async () => {
      await expect(proposeWorkStatus(9999, ReferralState.ACCEPTED)).rejects.toThrow(
        WorkspaceNotFoundError,
      );
    });
  });

  // ── The closure branch ────────────────────────────────────────────────────

  describe('Closed-Confirmed branch (computed inside proposeWorkStatus)', () => {
    it('proposes Resolved — Phase 1 has no source of open internal items', async () => {
      const referralId = insertReferral(ReferralState.CLOSED);
      const workspace = await createWorkspace(referralId);
      await proposeWorkStatus(workspace.id, ReferralState.ACCEPTED); // → In-Progress, mapping-set

      const result = await proposeWorkStatus(workspace.id, ReferralState.CLOSED_CONFIRMED);

      expect(result).toMatchObject({ applied: true, workStatus: WorkStatus.RESOLVED });
    });

    it('proposes Follow-up-Required when a mention is still unacknowledged (PRD-22)', async () => {
      // THE BRANCH PRD-18 KEPT AND COULD NEVER REACH. Closing the loop
      // externally does not close internal work: a colleague was asked to look
      // at something and has not, so the workspace stays visible.
      const referralId = insertReferral(ReferralState.CLOSED);
      const workspace = await createWorkspace(referralId);
      await proposeWorkStatus(workspace.id, ReferralState.ACCEPTED);

      const reader = insertUser('Priya Raman');
      const author = insertUser('Dana Ruiz');
      const { postComment, acknowledgeMentions } = await import(
        '../../../src/modules/workspace/commentService'
      );
      await postComment({
        workspaceId: workspace.id,
        body: 'Priya, the discharge summary never arrived',
        author: { kind: 'user', user: actingUser(author, 'Dana Ruiz') },
        mentions: { users: [reader] },
      });

      await expect(
        proposeWorkStatus(workspace.id, ReferralState.CLOSED_CONFIRMED),
      ).resolves.toMatchObject({ applied: true, workStatus: WorkStatus.FOLLOW_UP_REQUIRED });

      // And the protocol state was not touched to represent internal work.
      expect(referralState(referralId)).toBe(ReferralState.CLOSED);

      // GETTING BACK OUT IS A DELIBERATE ACT, and that is PRD-18's rule rather
      // than an oversight here: a proposal is declined while the status is
      // Follow-up-Required, so acknowledging the mention does not silently
      // re-resolve a workspace somebody has been told to look at.
      await acknowledgeMentions(workspace.id, reader, `user:${reader}`);
      await expect(
        proposeWorkStatus(workspace.id, ReferralState.CLOSED_CONFIRMED),
      ).resolves.toMatchObject({
        applied: false,
        workStatus: WorkStatus.FOLLOW_UP_REQUIRED,
      });

      // Nor does resyncWorkStatus() lift it. Resync exists to escape a MANUAL
      // override; Follow-up-Required is in PROPOSAL_PROTECTED, so it is
      // protected from every proposal regardless of who set it. Clearing a
      // follow-up flag is a person's decision, and setWorkStatus is how they
      // make it.
      await expect(resyncWorkStatus(workspace.id, 'user:1')).resolves.toMatchObject({
        workStatus: WorkStatus.FOLLOW_UP_REQUIRED,
      });
      await expect(
        setWorkStatus(workspace.id, WorkStatus.RESOLVED, `user:${reader}`),
      ).resolves.toMatchObject({ workStatus: WorkStatus.RESOLVED });
    });

    it('never derives Follow-up-Required from a protocol event alone', async () => {
      // Closing the loop is not by itself evidence that internal work is
      // outstanding. Follow-up-Required is reachable by a person setting it, and
      // by PRD-28/PRD-22 once they have something to report — not from here.
      for (const from of [WorkStatus.IN_PROGRESS, WorkStatus.WAITING_EXTERNAL, WorkStatus.TRIAGE]) {
        const referralId = insertReferral(ReferralState.CLOSED);
        const workspace = await createWorkspace(referralId);
        if (from !== WorkStatus.TRIAGE) {
          await setWorkStatus(workspace.id, from, 'system');
          sqlite()
            .prepare(`UPDATE referral_workspaces SET work_status_is_manual = 0 WHERE id = ?`)
            .run(workspace.id);
        }

        const result = await proposeWorkStatus(workspace.id, ReferralState.CLOSED_CONFIRMED);

        expect(result.proposed).toBe(WorkStatus.RESOLVED);
        expect(result.proposed).not.toBe(WorkStatus.FOLLOW_UP_REQUIRED);
      }
    });

    it('is a quiet no-op when the workspace is already Resolved', async () => {
      const referralId = insertReferral(ReferralState.CLOSED);
      const workspace = await createWorkspace(referralId);
      await setWorkStatus(workspace.id, WorkStatus.RESOLVED, 'user:1');
      sqlite()
        .prepare(`UPDATE referral_workspaces SET work_status_is_manual = 0 WHERE id = ?`)
        .run(workspace.id);

      const result = await proposeWorkStatus(workspace.id, ReferralState.CLOSED_CONFIRMED);

      // Already Resolved, so the branch resolves to Resolved and it is a no-op.
      expect(result).toMatchObject({ applied: false, declinedReason: 'same-status' });
      expect(result.proposed).toBe(WorkStatus.RESOLVED);
      const after = await getWorkspace(workspace.id);
      expect(after?.workStatus).toBe(WorkStatus.RESOLVED);
    });

    it('never reopens the protocol state to represent internal work', async () => {
      const referralId = insertReferral(ReferralState.CLOSED_CONFIRMED);
      const workspace = await createWorkspace(referralId);
      await proposeWorkStatus(workspace.id, ReferralState.CLOSED_CONFIRMED);

      expect(referralState(referralId)).toBe(ReferralState.CLOSED_CONFIRMED);
    });
  });

  // ── hasOpenInternalItems ──────────────────────────────────────────────────

  describe('hasOpenInternalItems()', () => {
    it('is false for every status when nothing is actually outstanding', async () => {
      // Work status alone never makes this true, whatever the status is: that
      // was the first definition, and it made every closed referral look like
      // it needed follow-up. The real sources are an unacknowledged mention
      // (PRD-22, below) and an unresolved exception (PRD-28, still to come).
      for (const status of Object.values(WorkStatus)) {
        const referralId = insertReferral();
        const workspace = await createWorkspace(referralId);
        if (status !== WorkStatus.TRIAGE) {
          await setWorkStatus(workspace.id, status, 'user:1');
        }

        await expect(hasOpenInternalItems(workspace.id)).resolves.toBe(false);
      }
    });

    it('throws for an unknown workspace', async () => {
      await expect(hasOpenInternalItems(9999)).rejects.toThrow(WorkspaceNotFoundError);
    });

    it('is true while a mention is unacknowledged, and false once it is (PRD-22)', async () => {
      const workspace = await createWorkspace(insertReferral());
      const reader = insertUser('Priya Raman');
      const author = insertUser('Dana Ruiz');

      const { postComment, acknowledgeMentions } = await import(
        '../../../src/modules/workspace/commentService'
      );

      await expect(hasOpenInternalItems(workspace.id)).resolves.toBe(false);

      await postComment({
        workspaceId: workspace.id,
        body: 'Priya, can you chase the imaging?',
        author: { kind: 'user', user: actingUser(author, 'Dana Ruiz') },
        mentions: { users: [reader] },
      });

      await expect(hasOpenInternalItems(workspace.id)).resolves.toBe(true);

      await acknowledgeMentions(workspace.id, reader, `user:${reader}`);

      await expect(hasOpenInternalItems(workspace.id)).resolves.toBe(false);
    });
  });

  // ── resyncWorkStatus ──────────────────────────────────────────────────────

  describe('resyncWorkStatus()', () => {
    it('clears the manual flag and applies the mapping for the current protocol state', async () => {
      const referralId = insertReferral(ReferralState.ACCEPTED);
      const workspace = await createWorkspace(referralId);
      await setWorkStatus(workspace.id, WorkStatus.WAITING_INTERNAL, 'user:1');

      const resynced = await resyncWorkStatus(workspace.id, 'user:1');

      expect(resynced.workStatus).toBe(WorkStatus.IN_PROGRESS); // Accepted → In-Progress
      expect(resynced.workStatusIsManual).toBe(false);
    });

    it('makes a subsequent proposal apply again — an override is never permanent', async () => {
      const referralId = insertReferral(ReferralState.ACCEPTED);
      const workspace = await createWorkspace(referralId);
      await setWorkStatus(workspace.id, WorkStatus.WAITING_INTERNAL, 'user:1');
      await expect(proposeWorkStatus(workspace.id, ReferralState.SCHEDULED)).resolves.toMatchObject(
        { applied: false },
      );

      await resyncWorkStatus(workspace.id, 'user:1');

      await expect(proposeWorkStatus(workspace.id, ReferralState.SCHEDULED)).resolves.toMatchObject(
        { applied: true, workStatus: WorkStatus.WAITING_EXTERNAL },
      );
    });

    it('emits a resync event', async () => {
      const referralId = insertReferral(ReferralState.ACCEPTED);
      const workspace = await createWorkspace(referralId);
      await resyncWorkStatus(workspace.id, 'user:3');
      await flushEvents();

      expect(events('workspace.work_status_resynced')).toHaveLength(1);
    });

    it('throws for an unknown workspace', async () => {
      await expect(resyncWorkStatus(9999, 'user:1')).rejects.toThrow(WorkspaceNotFoundError);
    });
  });

  // ── Archival ──────────────────────────────────────────────────────────────

  describe('archiveWorkspace()', () => {
    it('succeeds from Resolved and does not alter any protocol field', async () => {
      const referralId = insertReferral(ReferralState.CLOSED_CONFIRMED);
      const workspace = await createWorkspace(referralId);
      await setWorkStatus(workspace.id, WorkStatus.RESOLVED, 'user:1');

      const archived = await archiveWorkspace(workspace.id, 'user:1');

      expect(archived.archivedAt).toBeInstanceOf(Date);
      expect(archived.workStatus).toBe(WorkStatus.RESOLVED);
      expect(referralState(referralId)).toBe(ReferralState.CLOSED_CONFIRMED);
    });

    it('refuses from Follow-up-Required, naming what is still open', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);
      await setWorkStatus(workspace.id, WorkStatus.FOLLOW_UP_REQUIRED, 'user:1');

      await expect(archiveWorkspace(workspace.id, 'user:1')).rejects.toThrow(
        /internal follow-up is still outstanding/,
      );
    });

    it('refuses from Triage', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);

      await expect(archiveWorkspace(workspace.id, 'user:1')).rejects.toThrow(
        WorkspaceNotArchivableError,
      );
    });

    it('is idempotent — archiving twice is a no-op', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);
      await setWorkStatus(workspace.id, WorkStatus.RESOLVED, 'user:1');
      const first = await archiveWorkspace(workspace.id, 'user:1');
      const second = await archiveWorkspace(workspace.id, 'user:1');

      expect(second.archivedAt?.getTime()).toBe(first.archivedAt?.getTime());
    });
  });

  // ── proposeForReferral (the call-site wrapper) ────────────────────────────

  describe('proposeForReferral()', () => {
    it('advises the workspace for a referral that has one', async () => {
      const referralId = insertReferral();
      const workspace = await createWorkspace(referralId);

      await proposeForReferral(referralId, ReferralState.ACCEPTED);

      const after = await getWorkspace(workspace.id);
      expect(after?.workStatus).toBe(WorkStatus.IN_PROGRESS);
    });

    it('is silent for a referral with no workspace — a protocol event must not fail', async () => {
      const referralId = insertReferral();
      await expect(proposeForReferral(referralId, ReferralState.ACCEPTED)).resolves.toBeUndefined();
    });

    it('is silent for a referral that does not exist at all', async () => {
      await expect(proposeForReferral(9999, ReferralState.ACCEPTED)).resolves.toBeUndefined();
    });
  });

  // ── Backfill ──────────────────────────────────────────────────────────────

  describe('backfillWorkspaces()', () => {
    it("derives each work status from the referral's current protocol state", async () => {
      const accepted = insertReferral(ReferralState.ACCEPTED);
      const scheduled = insertReferral(ReferralState.SCHEDULED);
      const declined = insertReferral(ReferralState.DECLINED);
      const received = insertReferral(ReferralState.RECEIVED);

      const result = await backfillWorkspaces();

      expect(result).toEqual({ created: 4, updated: 0, skipped: 0 });
      await expect(getWorkspaceByReferralId(accepted)).resolves.toMatchObject({
        workStatus: WorkStatus.IN_PROGRESS,
      });
      await expect(getWorkspaceByReferralId(scheduled)).resolves.toMatchObject({
        workStatus: WorkStatus.WAITING_EXTERNAL,
      });
      await expect(getWorkspaceByReferralId(declined)).resolves.toMatchObject({
        workStatus: WorkStatus.RESOLVED,
      });
      // Received maps to Triage, which is already the creation default.
      await expect(getWorkspaceByReferralId(received)).resolves.toMatchObject({
        workStatus: WorkStatus.TRIAGE,
      });
    });

    it('records derived statuses as mapping-set, not manual', async () => {
      const referralId = insertReferral(ReferralState.ACCEPTED);
      await backfillWorkspaces();

      await expect(getWorkspaceByReferralId(referralId)).resolves.toMatchObject({
        workStatusIsManual: false,
      });
    });

    it('is idempotent on referral_id', async () => {
      insertReferral(ReferralState.ACCEPTED);
      insertReferral(ReferralState.SCHEDULED);

      const first = await backfillWorkspaces();
      const second = await backfillWorkspaces();

      expect(first).toEqual({ created: 2, updated: 0, skipped: 0 });
      expect(second).toEqual({ created: 0, updated: 0, skipped: 2 });
    });

    it('does not overwrite a status a person set on a previously backfilled workspace', async () => {
      const referralId = insertReferral(ReferralState.ACCEPTED);
      await backfillWorkspaces();
      const workspace = await getWorkspaceByReferralId(referralId);
      await setWorkStatus(workspace!.id, WorkStatus.WAITING_INTERNAL, 'user:1');

      await backfillWorkspaces();

      await expect(getWorkspaceByReferralId(referralId)).resolves.toMatchObject({
        workStatus: WorkStatus.WAITING_INTERNAL,
      });
    });

    it('reports nothing to do on an empty database', async () => {
      await expect(backfillWorkspaces()).resolves.toEqual({ created: 0, updated: 0, skipped: 0 });
    });

    // ── Re-deriving stale workspaces ────────────────────────────────────────
    //
    // A workspace goes stale when referrals.state is written without a proposal
    // reaching it. seed-full-demo.ts does exactly that for all 100 demo
    // referrals, so this is the ordinary case, not an edge one.

    it('re-derives a workspace left stale by a direct protocol write', async () => {
      const referralId = insertReferral(ReferralState.RECEIVED);
      await backfillWorkspaces();
      await expect(getWorkspaceByReferralId(referralId)).resolves.toMatchObject({
        workStatus: WorkStatus.TRIAGE,
      });

      // Advance the protocol the way the seed does — straight to the column.
      sqlite()
        .prepare(`UPDATE referrals SET state = ? WHERE id = ?`)
        .run(ReferralState.SCHEDULED, referralId);

      const result = await backfillWorkspaces();

      expect(result).toEqual({ created: 0, updated: 1, skipped: 0 });
      await expect(getWorkspaceByReferralId(referralId)).resolves.toMatchObject({
        workStatus: WorkStatus.WAITING_EXTERNAL,
        workStatusIsManual: false,
      });
    });

    it('counts a manual workspace as skipped rather than re-deriving it', async () => {
      const referralId = insertReferral(ReferralState.ACCEPTED);
      await backfillWorkspaces();
      const workspace = await getWorkspaceByReferralId(referralId);
      await setWorkStatus(workspace!.id, WorkStatus.WAITING_INTERNAL, 'user:1');
      sqlite()
        .prepare(`UPDATE referrals SET state = ? WHERE id = ?`)
        .run(ReferralState.ENCOUNTER, referralId);

      const result = await backfillWorkspaces();

      expect(result).toEqual({ created: 0, updated: 0, skipped: 1 });
      await expect(getWorkspaceByReferralId(referralId)).resolves.toMatchObject({
        workStatus: WorkStatus.WAITING_INTERNAL,
      });
    });

    it('leaves a protected status alone, reporting it as skipped', async () => {
      const referralId = insertReferral(ReferralState.RECEIVED);
      await backfillWorkspaces();
      const workspace = await getWorkspaceByReferralId(referralId);
      // Exception is protected from proposals. Clear the manual flag so only the
      // protection can be what declines it.
      await setWorkStatus(workspace!.id, WorkStatus.EXCEPTION, 'system');
      sqlite()
        .prepare(`UPDATE referral_workspaces SET work_status_is_manual = 0 WHERE id = ?`)
        .run(workspace!.id);
      sqlite()
        .prepare(`UPDATE referrals SET state = ? WHERE id = ?`)
        .run(ReferralState.SCHEDULED, referralId);

      const result = await backfillWorkspaces();

      expect(result).toEqual({ created: 0, updated: 0, skipped: 1 });
      await expect(getWorkspaceByReferralId(referralId)).resolves.toMatchObject({
        workStatus: WorkStatus.EXCEPTION,
      });
    });

    it('writes no audit rows on a second run — idempotent, not merely harmless', async () => {
      insertReferral(ReferralState.ACCEPTED);
      insertReferral(ReferralState.SCHEDULED);
      insertReferral(ReferralState.DECLINED);
      insertReferral(ReferralState.CLOSED_CONFIRMED);
      await backfillWorkspaces();
      await flushEvents();

      const before =
        events('workspace.work_status_changed').length +
        events('workspace.work_status_proposal_declined').length;

      await backfillWorkspaces();
      await flushEvents();

      const after =
        events('workspace.work_status_changed').length +
        events('workspace.work_status_proposal_declined').length;
      expect(after).toBe(before);
    });
  });
});
