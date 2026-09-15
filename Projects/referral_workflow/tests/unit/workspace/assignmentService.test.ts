/**
 * Unit tests for assignmentService.ts (PRD-21)
 *
 * Two properties carry most of the weight here:
 *
 *   - an action that changes nothing emits nothing. A no-op reassignment and a
 *     losing claim must both leave the audit log untouched, because an activity
 *     feed full of "reassigned to the person who already had it" is worse than
 *     no feed. (The PRD's first draft said a losing claim should still be
 *     audited; that was wrong.)
 *   - ownership is never lost silently. A deactivated owner still resolves, and
 *     release preserves the queue.
 */

jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct' },
    database: { url: ':memory:' },
  },
}));

jest.mock('../../../src/db', () => {
  const Database = require('better-sqlite3');
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const schema = require('../../../src/db/schema');

  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      direct_address TEXT,
      job_role TEXT NOT NULL,
      legacy_clinician_id TEXT,
      all_queues_access INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
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
    CREATE TABLE referral_workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referral_id INTEGER NOT NULL UNIQUE,
      external_referral_id TEXT,
      correlation_key TEXT,
      work_status TEXT NOT NULL DEFAULT 'Triage',
      work_status_is_manual INTEGER NOT NULL DEFAULT 0,
      work_status_set_by TEXT,
      work_status_set_at INTEGER,
      owner_user_id INTEGER,
      queue_id INTEGER,
      next_action TEXT,
      next_action_due_at INTEGER,
      exception_reason TEXT,
      archived_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
      created_at INTEGER NOT NULL
    );
  `);

  (global as Record<string, unknown>).__TEST_SQLITE__ = sqlite;

  return { db: drizzle(sqlite, { schema }) };
});

import { ReferralState } from '../../../src/state/referralStateMachine';
import { WorkStatus } from '../../../src/state/workStatusMachine';
import {
  archiveWorkspace,
  createWorkspace,
  getWorkspaceByReferralId,
  setWorkStatus,
} from '../../../src/modules/workspace/workspaceService';
import {
  OwnerNotFoundError,
  OwnershipConflictError,
  ReleaseReasonRequiredError,
  WorkspaceArchivedError,
  WorkspaceNotFoundError,
  assignOwner,
  claimOwnership,
  getMyWork,
  releaseOwnership,
} from '../../../src/modules/workspace/assignmentService';
import { ActingUser } from '../../../src/modules/workspace/identityService';

function sqlite(): import('better-sqlite3').Database {
  return (global as Record<string, unknown>).__TEST_SQLITE__ as import('better-sqlite3').Database;
}

function clearTables(): void {
  sqlite().exec(
    `DELETE FROM workflow_events;
     DELETE FROM referral_workspaces;
     DELETE FROM referrals;
     DELETE FROM patients;
     DELETE FROM users;`,
  );
}

let seq = 0;

function insertUser(name: string, active = true): ActingUser {
  seq += 1;
  const r = sqlite()
    .prepare(
      `INSERT INTO users (display_name, email, job_role, all_queues_access, active, created_at)
       VALUES (?, ?, 'coordinator', 0, ?, 0)`,
    )
    .run(name, `u${seq}@example.test`, active ? 1 : 0);
  return {
    id: Number(r.lastInsertRowid),
    displayName: name,
    email: `u${seq}@example.test`,
    directAddress: null,
    jobRole: 'coordinator',
    legacyClinicianId: null,
    allQueuesAccess: false,
    active,
  };
}

function deactivate(userId: number): void {
  sqlite().prepare(`UPDATE users SET active = 0 WHERE id = ?`).run(userId);
}

function insertReferral(state: ReferralState = ReferralState.RECEIVED): number {
  seq += 1;
  const patient = sqlite()
    .prepare(`INSERT INTO patients (first_name, last_name, date_of_birth) VALUES (?, ?, ?)`)
    .run('Test', `Patient${seq}`, '1980-01-01');
  const r = sqlite()
    .prepare(
      `INSERT INTO referrals (patient_id, source_message_id, referrer_address, state, created_at, updated_at)
       VALUES (?, ?, 'ref@hospital.direct', ?, 0, 0)`,
    )
    .run(patient.lastInsertRowid, `assign-${seq}`, state);
  return Number(r.lastInsertRowid);
}

/** A workspace ready to own, with the given work status. */
async function makeWorkspace(status: WorkStatus = WorkStatus.TRIAGE): Promise<number> {
  const referralId = insertReferral();
  const ws = await createWorkspace(referralId);
  if (status !== WorkStatus.TRIAGE) {
    await setWorkStatus(ws.id, status, 'system');
  }
  return ws.id;
}

function events(eventType?: string): { event_type: string; actor: string; metadata: string }[] {
  const rows = sqlite()
    .prepare(`SELECT event_type, actor, metadata FROM workflow_events ORDER BY id`)
    .all() as { event_type: string; actor: string; metadata: string }[];
  return eventType ? rows.filter((r) => r.event_type === eventType) : rows;
}

function ownershipEvents(): { event_type: string; actor: string; metadata: string }[] {
  return events().filter((e) =>
    ['workspace.assigned', 'workspace.reassigned', 'workspace.released'].includes(e.event_type),
  );
}

function meta(row: { metadata: string }): Record<string, unknown> {
  return JSON.parse(row.metadata) as Record<string, unknown>;
}

/** emitEvent() is fire-and-forget; let its insert land before asserting. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function ownerOf(workspaceId: number): number | null {
  const row = sqlite()
    .prepare(`SELECT owner_user_id AS o FROM referral_workspaces WHERE id = ?`)
    .get(workspaceId) as { o: number | null };
  return row.o;
}

beforeEach(clearTables);

describe('claimOwnership()', () => {
  it('assigns the acting user and emits workspace.assigned', async () => {
    const actor = insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace();

    const result = await claimOwnership(workspaceId, actor);
    await flush();

    expect(result).toMatchObject({ ownerUserId: actor.id, changed: true });
    expect(ownerOf(workspaceId)).toBe(actor.id);

    const emitted = events('workspace.assigned');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].actor).toBe(`user:${actor.id}`);
    expect(meta(emitted[0])).toMatchObject({
      workspaceId,
      fromOwnerUserId: null,
      toOwnerUserId: actor.id,
      self: true,
    });
  });

  // ── The race the conditional UPDATE exists for ────────────────────────────

  it('lets exactly one of two interleaved claims win', async () => {
    const first = insertUser('First Claimer');
    const second = insertUser('Second Claimer');
    const workspaceId = await makeWorkspace();

    // Started together, so the second reads a null owner before the first
    // writes. A read-then-write implementation would let both "succeed".
    const results = await Promise.allSettled([
      claimOwnership(workspaceId, first),
      claimOwnership(workspaceId, second),
    ]);
    await flush();

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(OwnershipConflictError);

    // And only the winner is in the log.
    expect(ownershipEvents()).toHaveLength(1);
  });

  it('names the current owner when a claim loses, and writes nothing', async () => {
    const holder = insertUser('Priya Raman');
    const latecomer = insertUser('Sam Okafor');
    const workspaceId = await makeWorkspace();
    await claimOwnership(workspaceId, holder);
    await flush();
    const before = ownershipEvents().length;

    await expect(claimOwnership(workspaceId, latecomer)).rejects.toThrow(OwnershipConflictError);
    await expect(claimOwnership(workspaceId, latecomer)).rejects.toThrow(/Priya Raman/);
    await flush();

    expect(ownerOf(workspaceId)).toBe(holder.id);
    expect(ownershipEvents()).toHaveLength(before);
  });
});

describe('assignOwner()', () => {
  it('emits workspace.reassigned with both parties when replacing an owner', async () => {
    const actor = insertUser('Manager');
    const from = insertUser('Original');
    const to = insertUser('Replacement');
    const workspaceId = await makeWorkspace();
    await assignOwner(workspaceId, from.id, actor);
    await flush();

    const result = await assignOwner(workspaceId, to.id, actor, 'on leave');
    await flush();

    expect(result).toMatchObject({ ownerUserId: to.id, changed: true });
    const emitted = events('workspace.reassigned');
    expect(emitted).toHaveLength(1);
    expect(meta(emitted[0])).toMatchObject({
      fromOwnerUserId: from.id,
      toOwnerUserId: to.id,
      reason: 'on leave',
      self: false,
    });
  });

  it('emits assigned rather than reassigned for the first owner', async () => {
    const actor = insertUser('Manager');
    const target = insertUser('Target');
    const workspaceId = await makeWorkspace();

    await assignOwner(workspaceId, target.id, actor);
    await flush();

    expect(events('workspace.assigned')).toHaveLength(1);
    expect(events('workspace.reassigned')).toHaveLength(0);
  });

  it('is a silent no-op when the target already owns it', async () => {
    const actor = insertUser('Manager');
    const target = insertUser('Target');
    const workspaceId = await makeWorkspace();
    await assignOwner(workspaceId, target.id, actor);
    await flush();
    const before = ownershipEvents().length;

    const result = await assignOwner(workspaceId, target.id, actor);
    await flush();

    expect(result.changed).toBe(false);
    expect(result.ownerUserId).toBe(target.id);
    expect(ownershipEvents()).toHaveLength(before);
  });

  it('refuses an unknown user', async () => {
    const actor = insertUser('Manager');
    const workspaceId = await makeWorkspace();

    await expect(assignOwner(workspaceId, 9999, actor)).rejects.toThrow(OwnerNotFoundError);
    expect(ownerOf(workspaceId)).toBeNull();
  });

  it('refuses an inactive user', async () => {
    const actor = insertUser('Manager');
    const departed = insertUser('Departed', false);
    const workspaceId = await makeWorkspace();

    await expect(assignOwner(workspaceId, departed.id, actor)).rejects.toThrow(OwnerNotFoundError);
    expect(ownerOf(workspaceId)).toBeNull();
  });

  // AC7a. The mirror of the rule above: you cannot assign TO an inactive user,
  // but an owner who leaves afterwards stays the owner rather than vanishing.
  it('keeps an owner who is deactivated after being assigned', async () => {
    const actor = insertUser('Manager');
    const target = insertUser('Leaver');
    const workspaceId = await makeWorkspace();
    await assignOwner(workspaceId, target.id, actor);

    deactivate(target.id);

    expect(ownerOf(workspaceId)).toBe(target.id);
    // And they can still be replaced, which is the point of noticing.
    const successor = insertUser('Successor');
    await expect(assignOwner(workspaceId, successor.id, actor)).resolves.toMatchObject({
      changed: true,
    });
  });

  it('is permitted on a Closed-Confirmed referral — someone owns follow-up', async () => {
    const actor = insertUser('Manager');
    const target = insertUser('Target');
    const referralId = insertReferral(ReferralState.CLOSED_CONFIRMED);
    const ws = await createWorkspace(referralId);

    await expect(assignOwner(ws.id, target.id, actor)).resolves.toMatchObject({ changed: true });
  });
});

describe('releaseOwnership()', () => {
  it('clears the owner, preserves the queue, and emits workspace.released', async () => {
    const actor = insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace();
    sqlite().prepare(`UPDATE referral_workspaces SET queue_id = 7 WHERE id = ?`).run(workspaceId);
    await claimOwnership(workspaceId, actor);
    await flush();

    const result = await releaseOwnership(workspaceId, actor);
    await flush();

    expect(result).toMatchObject({ ownerUserId: null, changed: true });
    expect(ownerOf(workspaceId)).toBeNull();

    const queue = sqlite()
      .prepare(`SELECT queue_id AS q FROM referral_workspaces WHERE id = ?`)
      .get(workspaceId) as { q: number | null };
    expect(queue.q).toBe(7);

    const emitted = events('workspace.released');
    expect(emitted).toHaveLength(1);
    expect(meta(emitted[0])).toMatchObject({ fromOwnerUserId: actor.id });
  });

  it('needs no reason in Triage', async () => {
    const actor = insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace(WorkStatus.TRIAGE);
    await claimOwnership(workspaceId, actor);

    await expect(releaseOwnership(workspaceId, actor)).resolves.toMatchObject({ changed: true });
  });

  it('requires a reason once work has started, and records it', async () => {
    const actor = insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace(WorkStatus.IN_PROGRESS);
    await claimOwnership(workspaceId, actor);
    await flush();

    await expect(releaseOwnership(workspaceId, actor)).rejects.toThrow(ReleaseReasonRequiredError);
    expect(ownerOf(workspaceId)).toBe(actor.id);

    await releaseOwnership(workspaceId, actor, 'needs a cardiology coordinator');
    await flush();

    expect(meta(events('workspace.released')[0])).toMatchObject({
      reason: 'needs a cardiology coordinator',
    });
  });

  it('treats whitespace as no reason at all', async () => {
    const actor = insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace(WorkStatus.IN_PROGRESS);
    await claimOwnership(workspaceId, actor);

    await expect(releaseOwnership(workspaceId, actor, '   ')).rejects.toThrow(
      ReleaseReasonRequiredError,
    );
  });

  it('is a no-op on an already-unassigned workspace', async () => {
    const actor = insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace();
    const before = ownershipEvents().length;

    const result = await releaseOwnership(workspaceId, actor);
    await flush();

    expect(result.changed).toBe(false);
    expect(ownershipEvents()).toHaveLength(before);
  });
});

describe('archived and missing workspaces', () => {
  it('refuses every ownership action on an archived workspace', async () => {
    const actor = insertUser('Dana Ruiz');
    const other = insertUser('Other');
    const workspaceId = await makeWorkspace();
    await setWorkStatus(workspaceId, WorkStatus.RESOLVED, 'user:1');
    await archiveWorkspace(workspaceId, 'user:1');

    await expect(claimOwnership(workspaceId, actor)).rejects.toThrow(WorkspaceArchivedError);
    await expect(assignOwner(workspaceId, other.id, actor)).rejects.toThrow(WorkspaceArchivedError);
    await expect(releaseOwnership(workspaceId, actor, 'x')).rejects.toThrow(WorkspaceArchivedError);
  });

  it('throws for a workspace that does not exist', async () => {
    const actor = insertUser('Dana Ruiz');

    await expect(claimOwnership(9999, actor)).rejects.toThrow(WorkspaceNotFoundError);
    await expect(releaseOwnership(9999, actor)).rejects.toThrow(WorkspaceNotFoundError);
  });
});

describe('getMyWork()', () => {
  it('returns nothing for a user who owns nothing', async () => {
    const actor = insertUser('Dana Ruiz');
    await makeWorkspace();

    await expect(getMyWork(actor.id)).resolves.toEqual([]);
  });

  it("returns only the given user's workspaces", async () => {
    const mine = insertUser('Mine');
    const theirs = insertUser('Theirs');
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    await claimOwnership(a, mine);
    await claimOwnership(b, theirs);

    const items = await getMyWork(mine.id);

    expect(items).toHaveLength(1);
    expect(items[0].workspaceId).toBe(a);
  });

  it('excludes archived workspaces', async () => {
    const actor = insertUser('Dana Ruiz');
    const kept = await makeWorkspace();
    const archived = await makeWorkspace();
    await claimOwnership(kept, actor);
    await claimOwnership(archived, actor);
    await setWorkStatus(archived, WorkStatus.RESOLVED, 'user:1');
    await archiveWorkspace(archived, 'user:1');

    const items = await getMyWork(actor.id);

    expect(items.map((i) => i.workspaceId)).toEqual([kept]);
  });

  it('carries the patient name and both statuses', async () => {
    const actor = insertUser('Dana Ruiz');
    const referralId = insertReferral(ReferralState.SCHEDULED);
    const ws = await createWorkspace(referralId);
    await claimOwnership(ws.id, actor);

    const items = await getMyWork(actor.id);

    expect(items[0]).toMatchObject({
      referralId,
      referralState: ReferralState.SCHEDULED,
      workStatus: WorkStatus.TRIAGE,
    });
    expect(items[0].patientName).toMatch(/Test Patient/);
  });

  // The due-date clause cannot be exercised until PRD-26 populates the column,
  // so this asserts what actually orders the list today rather than pretending.
  it('orders by created date while every due date is null', async () => {
    const actor = insertUser('Dana Ruiz');
    const first = await makeWorkspace();
    const second = await makeWorkspace();
    await claimOwnership(second, actor);
    await claimOwnership(first, actor);
    sqlite().prepare(`UPDATE referral_workspaces SET created_at = 100 WHERE id = ?`).run(first);
    sqlite().prepare(`UPDATE referral_workspaces SET created_at = 900 WHERE id = ?`).run(second);

    const items = await getMyWork(actor.id);

    expect(items.map((i) => i.workspaceId)).toEqual([first, second]);
    expect(items.every((i) => i.nextActionDueAt === null)).toBe(true);
    expect(items.every((i) => i.overdue === false)).toBe(true);
  });

  it('puts a workspace with a due date ahead of one without', async () => {
    // Written against a hand-set column so the ordering rule is covered now,
    // even though nothing in the application writes it until PRD-26.
    const actor = insertUser('Dana Ruiz');
    const noDue = await makeWorkspace();
    const withDue = await makeWorkspace();
    await claimOwnership(noDue, actor);
    await claimOwnership(withDue, actor);
    sqlite().prepare(`UPDATE referral_workspaces SET created_at = 100 WHERE id = ?`).run(noDue);
    sqlite().prepare(`UPDATE referral_workspaces SET created_at = 900 WHERE id = ?`).run(withDue);
    sqlite()
      .prepare(`UPDATE referral_workspaces SET next_action_due_at = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000) + 3600, withDue);

    const items = await getMyWork(actor.id);

    expect(items.map((i) => i.workspaceId)).toEqual([withDue, noDue]);
  });

  it('marks a past due date overdue', async () => {
    const actor = insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace();
    await claimOwnership(workspaceId, actor);
    sqlite()
      .prepare(`UPDATE referral_workspaces SET next_action_due_at = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000) - 3600, workspaceId);

    const items = await getMyWork(actor.id);

    expect(items[0].overdue).toBe(true);
  });

  it('returns nothing for a non-integer id rather than querying', async () => {
    await expect(getMyWork(Number.NaN)).resolves.toEqual([]);
  });
});
