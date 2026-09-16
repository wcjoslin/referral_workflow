/**
 * Unit tests for nextActionService.ts (PRD-26)
 *
 * Four properties carry the weight:
 *
 *   - **a due date is measured from the state entry moment, not from now.**
 *     Getting this wrong means a backfill silently resets every deadline in the
 *     database and un-overdues everything, which looks like the feature working.
 *   - **an override is never recomputed away.** A due date or action a person
 *     chose that the next transition discards teaches people the field is a lie.
 *   - **`workspace.overdue` fires once per due date, not once per sweep.** The
 *     difference between a signal and noise nobody reads.
 *   - **`awaitedBy` downgrades honestly.** A `local-only` party cannot owe a
 *     response because nothing was sent to them, and pointing a coordinator at
 *     them sends them to chase a message that does not exist.
 */

/**
 * The config mock supplies only the env-dependent parts.
 *
 * The RULE TABLES are NOT mocked and never were meant to be: `resolveRule()`
 * reads `nextActionRules.ts` directly, so every assertion below runs against
 * the table that actually ships. An earlier version restated the table inside
 * this mock and would have stayed green with a wrong table in production.
 */
jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct', orgName: 'Specialist Care Group' },
    database: { url: ':memory:' },
    workspace: { overdueSweepIntervalMs: 900000 },
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
import { WorkStatus } from '../../../src/state/workStatusMachine';
import { ActingUser } from '../../../src/modules/workspace/identityService';
import {
  NextActionTooLongError,
  NextActionWorkspaceNotFoundError,
  OverrideReasonRequiredError,
  actorFromSetBy,
  backfillNextActions,
  clearOverrides,
  encodeSetBy,
  getNextActionState,
  isOverdue,
  listOverdue,
  overrideDueDate,
  overrideNextAction,
  recomputeNextAction,
  resolveRule,
} from '../../../src/modules/workspace/nextActionService';
import {
  checkAndFlagOverdueWorkspaces,
  getOverdueMessages,
  getOverdueWorkspaces,
} from '../../../src/modules/prd07/overdueChecker';

function sqlite(): import('better-sqlite3').Database {
  return (global as Record<string, unknown>).__TEST_SQLITE__ as import('better-sqlite3').Database;
}

function clearTables(): void {
  sqlite().exec(
    `DELETE FROM workflow_events;
     DELETE FROM outbound_messages;
     DELETE FROM workspace_parties;
     DELETE FROM referral_workspaces;
     DELETE FROM referrals;
     DELETE FROM patients;
     DELETE FROM users;`,
  );
}

let seq = 0;

function insertUser(name = 'Dana Ruiz'): ActingUser {
  seq += 1;
  const email = `na${seq}@example.test`;
  const r = sqlite()
    .prepare(
      `INSERT INTO users (display_name, email, job_role, all_queues_access, active, created_at)
       VALUES (?, ?, 'coordinator', 0, 1, 0)`,
    )
    .run(name, email);
  return {
    id: Number(r.lastInsertRowid),
    displayName: name,
    email,
    directAddress: null,
    jobRole: 'coordinator',
    legacyClinicianId: null,
    allQueuesAccess: false,
    active: true,
  };
}

const SEC = (d: Date): number => Math.floor(d.getTime() / 1000);

/**
 * A workspace built by direct insert rather than through createWorkspace(),
 * so a test controls the state pair and the timestamps exactly. createWorkspace()
 * would recompute on the way in and hide what is being asserted.
 */
function makeWorkspace(opts: {
  state?: ReferralState;
  workStatus?: WorkStatus;
  appointmentDate?: string | null;
  workStatusSetAt?: Date;
} = {}): { workspaceId: number; referralId: number } {
  seq += 1;
  const patient = sqlite()
    .prepare(`INSERT INTO patients (first_name, last_name, date_of_birth) VALUES (?, ?, ?)`)
    .run('Test', `Patient${seq}`, '1980-01-01');
  const ref = sqlite()
    .prepare(
      `INSERT INTO referrals (patient_id, source_message_id, referrer_address, state,
                              routing_department, appointment_date, created_at, updated_at)
       VALUES (?, ?, 'ref@hospital.direct', ?, 'Cardiology', ?, 0, 0)`,
    )
    .run(
      patient.lastInsertRowid,
      `na-${seq}`,
      opts.state ?? ReferralState.RECEIVED,
      opts.appointmentDate ?? null,
    );
  const ws = sqlite()
    .prepare(
      `INSERT INTO referral_workspaces (referral_id, work_status, work_status_is_manual,
                                        work_status_set_at, due_date_overridden, created_at, updated_at)
       VALUES (?, ?, 0, ?, 0, 0, 0)`,
    )
    .run(
      ref.lastInsertRowid,
      opts.workStatus ?? WorkStatus.TRIAGE,
      opts.workStatusSetAt ? SEC(opts.workStatusSetAt) : null,
    );
  return { workspaceId: Number(ws.lastInsertRowid), referralId: Number(ref.lastInsertRowid) };
}

function addParty(
  workspaceId: number,
  role: string,
  protocolMode = 'direct',
  orgName: string | null = 'Northside Primary Care',
): number {
  const r = sqlite()
    .prepare(
      `INSERT INTO workspace_parties (workspace_id, party_role, org_name, protocol_mode,
                                      org_name_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, 0)`,
    )
    .run(workspaceId, role, orgName, protocolMode);
  return Number(r.lastInsertRowid);
}

function addOutbound(referralId: number, status: 'Pending' | 'Acknowledged'): void {
  seq += 1;
  sqlite()
    .prepare(
      `INSERT INTO outbound_messages (referral_id, message_control_id, message_type, status,
                                      sent_at, acknowledged_at)
       VALUES (?, ?, 'ConsultNote', ?, 0, ?)`,
    )
    .run(referralId, `ctrl-${seq}`, status, status === 'Acknowledged' ? 1 : null);
}

function events(type?: string): Array<Record<string, unknown>> {
  const rows = sqlite()
    .prepare(`SELECT event_type, entity_id, actor, metadata FROM workflow_events`)
    .all() as Array<Record<string, unknown>>;
  return type ? rows.filter((r) => r.event_type === type) : rows;
}

function dueOf(workspaceId: number): number | null {
  const r = sqlite()
    .prepare(`SELECT next_action_due_at d FROM referral_workspaces WHERE id = ?`)
    .get(workspaceId) as { d: number | null };
  return r.d;
}

beforeEach(() => clearTables());

// ── The rule table ───────────────────────────────────────────────────────────

describe('resolveRule', () => {
  it('prefers the state-and-work-status rule over the state-only fallback', () => {
    const rule = resolveRule(ReferralState.CLOSED_CONFIRMED, WorkStatus.RESOLVED);
    expect(rule.action).toBe('No action required');
    expect(rule.dueInHours).toBeNull();
    // The state-only fallback says something different, proving the pair won.
    expect(resolveRule(ReferralState.CLOSED_CONFIRMED, WorkStatus.IN_PROGRESS).action).toBe(
      'Confirm nothing is outstanding, then resolve',
    );
  });

  /** An Exception is the thing to deal with, whatever the protocol says. */
  it('lets the work-status layer override the protocol state entirely', () => {
    for (const state of Object.values(ReferralState)) {
      expect(resolveRule(state, WorkStatus.EXCEPTION).action).toBe(
        'Review and resolve the exception',
      );
    }
  });

  it('has a rule for every protocol state', () => {
    for (const state of Object.values(ReferralState)) {
      const rule = resolveRule(state, WorkStatus.IN_PROGRESS);
      expect(rule.action).toBeTruthy();
      expect(['us', 'party', 'nobody']).toContain(rule.awaitedBy);
    }
  });

  /** AC8 — no fabricated deadline for an unmapped combination. */
  it('returns an action with no due date for an unmapped state', () => {
    const rule = resolveRule('Not-A-State' as ReferralState, WorkStatus.IN_PROGRESS);
    expect(rule.action).toBe('Review this referral and decide the next step');
    expect(rule.dueInHours).toBeNull();
  });
});

// ── Computing ────────────────────────────────────────────────────────────────

describe('recomputeNextAction', () => {
  it('writes the rule action and a due date from the offset', async () => {
    const { workspaceId } = makeWorkspace({ state: ReferralState.RECEIVED });
    const entered = new Date('2026-09-16T09:00:00Z');
    const state = await recomputeNextAction(workspaceId, entered);

    expect(state?.nextAction).toBe('Acknowledge receipt of the referral');
    // 4 hours after ENTERED, not after now.
    expect(state?.nextActionDueAt?.toISOString()).toBe('2026-09-16T13:00:00.000Z');
    expect(state?.awaitedBy).toBe('us');
  });

  /**
   * The bug that would look like the feature working: computing from `now`
   * silently resets every deadline and un-overdues the whole database.
   */
  it('computes from the state entry time, not from now', async () => {
    const longAgo = new Date(Date.now() - 100 * 60 * 60 * 1000);
    const { workspaceId } = makeWorkspace({ state: ReferralState.RECEIVED });
    const state = await recomputeNextAction(workspaceId, longAgo);

    // Compared at second granularity: drizzle `mode: 'timestamp'` stores whole
    // seconds, so the value read back is truncated.
    expect(Math.floor(state!.nextActionDueAt!.getTime() / 1000)).toBe(
      Math.floor((longAgo.getTime() + 4 * 3600 * 1000) / 1000),
    );
    // 4h after a moment 100h ago is long past — immediately overdue.
    expect(state?.overdue).toBe(true);
    expect(state?.overdueByHours).toBeGreaterThan(90);
  });

  it('falls back to the recorded work status timestamp when no entry time is given', async () => {
    const setAt = new Date('2026-09-10T08:00:00Z');
    const { workspaceId } = makeWorkspace({ state: ReferralState.RECEIVED, workStatusSetAt: setAt });
    const state = await recomputeNextAction(workspaceId);
    expect(state?.nextActionDueAt?.toISOString()).toBe('2026-09-10T12:00:00.000Z');
  });

  it('writes no due date for a rule with a null offset', async () => {
    const { workspaceId } = makeWorkspace({
      state: ReferralState.DECLINED,
      workStatus: WorkStatus.RESOLVED,
    });
    const state = await recomputeNextAction(workspaceId, new Date());
    expect(state?.nextAction).toBe('No action required');
    expect(state?.nextActionDueAt).toBeNull();
    expect(state?.awaitedBy).toBe('nobody');
    expect(state?.overdue).toBe(false);
  });

  it('emits next_action_changed with the previous value', async () => {
    const { workspaceId, referralId } = makeWorkspace({ state: ReferralState.RECEIVED });
    await recomputeNextAction(workspaceId, new Date());
    sqlite()
      .prepare(`UPDATE referrals SET state = ? WHERE id = ?`)
      .run(ReferralState.ACKNOWLEDGED, referralId);
    await recomputeNextAction(workspaceId, new Date());

    const emitted = events('workspace.next_action_changed');
    expect(emitted).toHaveLength(2);
    const meta = JSON.parse(emitted[1].metadata as string) as Record<string, unknown>;
    expect(meta.previousAction).toBe('Acknowledge receipt of the referral');
    expect(meta.nextAction).toBe(
      'Review the clinical information and accept or decline the referral',
    );
  });

  it('emits nothing when a recompute changes nothing', async () => {
    const { workspaceId } = makeWorkspace({ state: ReferralState.RECEIVED });
    const entered = new Date('2026-09-16T09:00:00Z');
    await recomputeNextAction(workspaceId, entered);
    await recomputeNextAction(workspaceId, entered);
    expect(events('workspace.next_action_changed')).toHaveLength(1);
  });

  it('returns null for a workspace that does not exist rather than throwing', async () => {
    // Called from protocol transition paths, so it must never fail one.
    expect(await recomputeNextAction(9999, new Date())).toBeNull();
  });
});

// ── The appointment-relative rule ────────────────────────────────────────────

describe('appointment-relative due dates', () => {
  it('uses the appointment date as the due date', async () => {
    const { workspaceId } = makeWorkspace({
      state: ReferralState.SCHEDULED,
      workStatus: WorkStatus.WAITING_EXTERNAL,
      appointmentDate: '2026-10-01T14:30:00Z',
    });
    addParty(workspaceId, 'initiating');
    const state = await recomputeNextAction(workspaceId, new Date());
    expect(state?.nextActionDueAt?.toISOString()).toBe('2026-10-01T14:30:00.000Z');
  });

  /** Better absent than invented — the same principle as AC8. */
  it('writes no due date when the appointment date is missing', async () => {
    const { workspaceId } = makeWorkspace({
      state: ReferralState.SCHEDULED,
      workStatus: WorkStatus.WAITING_EXTERNAL,
      appointmentDate: null,
    });
    addParty(workspaceId, 'initiating');
    const state = await recomputeNextAction(workspaceId, new Date());
    expect(state?.nextAction).toContain('Awaiting the appointment');
    expect(state?.nextActionDueAt).toBeNull();
  });

  it('writes no due date when the appointment date is unparseable', async () => {
    const { workspaceId } = makeWorkspace({
      state: ReferralState.SCHEDULED,
      workStatus: WorkStatus.WAITING_EXTERNAL,
      appointmentDate: 'next Tuesday sometime',
    });
    addParty(workspaceId, 'initiating');
    expect((await recomputeNextAction(workspaceId, new Date()))?.nextActionDueAt).toBeNull();
  });
});

// ── Who owes the move ────────────────────────────────────────────────────────

describe('awaitedBy', () => {
  it('names the party organization rather than "external" (AC10)', async () => {
    const { workspaceId } = makeWorkspace({ state: ReferralState.PENDING_INFORMATION });
    addParty(workspaceId, 'initiating', 'direct', 'Northside Primary Care');
    const state = await recomputeNextAction(workspaceId, new Date());
    expect(state?.awaitedBy).toBe('party');
    expect(state?.awaitedByPartyOrgName).toBe('Northside Primary Care');
  });

  /** AC12 — nothing was transmitted, so they cannot owe a response. */
  it('downgrades a local-only party to us', async () => {
    const { workspaceId } = makeWorkspace({ state: ReferralState.PENDING_INFORMATION });
    addParty(workspaceId, 'initiating', 'local-only');
    const state = await recomputeNextAction(workspaceId, new Date());
    expect(state?.awaitedBy).toBe('us');
    expect(state?.awaitedByPartyId).toBeNull();
  });

  it('downgrades to us when the owed party does not exist', async () => {
    const { workspaceId } = makeWorkspace({ state: ReferralState.PENDING_INFORMATION });
    const state = await recomputeNextAction(workspaceId, new Date());
    expect(state?.awaitedBy).toBe('us');
  });

  it('falls back to us when the awaited party is removed after the fact', async () => {
    const { workspaceId } = makeWorkspace({ state: ReferralState.PENDING_INFORMATION });
    const partyId = addParty(workspaceId, 'initiating');
    expect((await recomputeNextAction(workspaceId, new Date()))?.awaitedBy).toBe('party');

    sqlite().prepare(`DELETE FROM workspace_parties WHERE id = ?`).run(partyId);
    const after = await recomputeNextAction(workspaceId, new Date());
    expect(after?.awaitedBy).toBe('us');
    expect(after?.awaitedByPartyId).toBeNull();
  });

  /** AC11 — in Closed, "they owe us" IS a delivery claim. */
  it('says party in Closed while an outbound message is unacknowledged', async () => {
    const { workspaceId, referralId } = makeWorkspace({ state: ReferralState.CLOSED });
    addParty(workspaceId, 'initiating');
    addOutbound(referralId, 'Pending');
    expect((await recomputeNextAction(workspaceId, new Date()))?.awaitedBy).toBe('party');
  });

  it('says nobody in Closed once everything is acknowledged', async () => {
    const { workspaceId, referralId } = makeWorkspace({ state: ReferralState.CLOSED });
    addParty(workspaceId, 'initiating');
    addOutbound(referralId, 'Acknowledged');
    expect((await recomputeNextAction(workspaceId, new Date()))?.awaitedBy).toBe('nobody');
  });

  /**
   * Scheduled is deliberately NOT ack-gated: what is awaited is the appointment
   * happening, not a message. Gating it would flip to "nobody" the moment the
   * SIU was acknowledged while the appointment is still days away.
   */
  it('keeps Scheduled awaited by the party even with everything acknowledged', async () => {
    const { workspaceId, referralId } = makeWorkspace({
      state: ReferralState.SCHEDULED,
      workStatus: WorkStatus.WAITING_EXTERNAL,
      appointmentDate: '2026-10-01T14:30:00Z',
    });
    addParty(workspaceId, 'initiating');
    addOutbound(referralId, 'Acknowledged');
    expect((await recomputeNextAction(workspaceId, new Date()))?.awaitedBy).toBe('party');
  });
});

// ── Overrides ────────────────────────────────────────────────────────────────

describe('overrideDueDate', () => {
  it('sets the date, records the reason, and audits the previous value', async () => {
    const actor = insertUser();
    const { workspaceId } = makeWorkspace({ state: ReferralState.RECEIVED });
    await recomputeNextAction(workspaceId, new Date('2026-09-16T09:00:00Z'));

    const state = await overrideDueDate(
      workspaceId,
      new Date('2026-09-20T17:00:00Z'),
      'referring office closed until Friday',
      actor,
    );
    expect(state.nextActionDueAt?.toISOString()).toBe('2026-09-20T17:00:00.000Z');
    expect(state.dueDateOverridden).toBe(true);
    expect(state.dueDateOverrideReason).toBe('referring office closed until Friday');

    const emitted = events('workspace.due_date_overridden');
    expect(emitted).toHaveLength(1);
    const meta = JSON.parse(emitted[0].metadata as string) as Record<string, unknown>;
    expect(meta.previousDueAt).toBe('2026-09-16T13:00:00.000Z');
    expect(meta.reason).toBe('referring office closed until Friday');
    expect(emitted[0].actor).toBe(`user:${actor.id}`);
  });

  it('refuses an override with no reason', async () => {
    const actor = insertUser();
    const { workspaceId } = makeWorkspace();
    await expect(overrideDueDate(workspaceId, new Date(), '   ', actor)).rejects.toThrow(
      OverrideReasonRequiredError,
    );
  });

  it('refuses an unknown workspace with its own error class', async () => {
    const actor = insertUser();
    await expect(overrideDueDate(9999, new Date(), 'because', actor)).rejects.toThrow(
      NextActionWorkspaceNotFoundError,
    );
  });

  /** AC7 — the whole point. A transition must not discard a person's judgement. */
  it('survives a later recompute', async () => {
    const actor = insertUser();
    const { workspaceId, referralId } = makeWorkspace({ state: ReferralState.RECEIVED });
    await recomputeNextAction(workspaceId, new Date('2026-09-16T09:00:00Z'));
    await overrideDueDate(workspaceId, new Date('2026-09-20T17:00:00Z'), 'office closed', actor);

    sqlite()
      .prepare(`UPDATE referrals SET state = ? WHERE id = ?`)
      .run(ReferralState.ACKNOWLEDGED, referralId);
    const after = await recomputeNextAction(workspaceId, new Date('2026-09-17T09:00:00Z'));

    // The ACTION follows the new state; the DUE DATE does not move.
    expect(after?.nextAction).toBe(
      'Review the clinical information and accept or decline the referral',
    );
    expect(after?.nextActionDueAt?.toISOString()).toBe('2026-09-20T17:00:00.000Z');
    expect(after?.dueDateOverridden).toBe(true);
  });
});

describe('overrideNextAction', () => {
  it('stores the instruction and the actor', async () => {
    const actor = insertUser('Priya Raman');
    const { workspaceId } = makeWorkspace({ state: ReferralState.ACCEPTED, workStatus: WorkStatus.IN_PROGRESS });
    await recomputeNextAction(workspaceId, new Date());

    const state = await overrideNextAction(
      workspaceId,
      "Call Dr. Ofori's office about the echo report",
      actor,
    );
    expect(state.nextAction).toBe("Call Dr. Ofori's office about the echo report");
    // The actor half only — the encoded rule action is an implementation detail.
    expect(state.nextActionSetBy).toBe(`user:${actor.id}`);
  });

  it('refuses an empty action and an over-long one distinctly', async () => {
    const actor = insertUser();
    const { workspaceId } = makeWorkspace();
    await expect(overrideNextAction(workspaceId, '   ', actor)).rejects.toThrow(
      /cannot be empty/,
    );
    await expect(overrideNextAction(workspaceId, 'x'.repeat(501), actor)).rejects.toThrow(
      NextActionTooLongError,
    );
  });

  /** AC4, the surviving half. */
  it('survives a recompute while the rule action is unchanged', async () => {
    const actor = insertUser();
    const { workspaceId } = makeWorkspace({
      state: ReferralState.ACCEPTED,
      workStatus: WorkStatus.IN_PROGRESS,
    });
    await recomputeNextAction(workspaceId, new Date());
    await overrideNextAction(workspaceId, 'Chase the echo report', actor);

    const after = await recomputeNextAction(workspaceId, new Date());
    expect(after?.nextAction).toBe('Chase the echo report');
  });

  /** AC4, the replacing half — and the previous value must be recoverable. */
  it('is replaced when the state change makes it meaningless, recording it', async () => {
    const actor = insertUser();
    const { workspaceId, referralId } = makeWorkspace({
      state: ReferralState.ACCEPTED,
      workStatus: WorkStatus.IN_PROGRESS,
    });
    await recomputeNextAction(workspaceId, new Date());
    await overrideNextAction(workspaceId, 'Chase the echo report', actor);

    sqlite()
      .prepare(`UPDATE referrals SET state = ?, appointment_date = ? WHERE id = ?`)
      .run(ReferralState.SCHEDULED, '2026-10-01T14:30:00Z', referralId);
    sqlite()
      .prepare(`UPDATE referral_workspaces SET work_status = ? WHERE id = ?`)
      .run(WorkStatus.WAITING_EXTERNAL, workspaceId);

    const after = await recomputeNextAction(workspaceId, new Date());
    expect(after?.nextAction).toContain('Awaiting the appointment');
    expect(after?.nextActionSetBy).toBeNull();

    const meta = JSON.parse(
      events('workspace.next_action_changed').slice(-1)[0].metadata as string,
    ) as Record<string, unknown>;
    expect(meta.replacedManualAction).toBe('Chase the echo report');
    expect(meta.manualSetBy).toContain(`user:${actor.id}`);
  });

  it('round-trips the actor through the encoded set-by value', () => {
    const encoded = encodeSetBy('user:7', 'Some rule action');
    expect(actorFromSetBy(encoded)).toBe('user:7');
    expect(actorFromSetBy(null)).toBeNull();
    // A legacy value with no delimiter still yields an actor.
    expect(actorFromSetBy('user:9')).toBe('user:9');
  });
});

describe('clearOverrides', () => {
  it('restores the rule action and the computed due date', async () => {
    const actor = insertUser();
    const { workspaceId } = makeWorkspace({ state: ReferralState.RECEIVED });
    const entered = new Date('2026-09-16T09:00:00Z');
    await recomputeNextAction(workspaceId, entered);
    await overrideNextAction(workspaceId, 'Something bespoke', actor);
    await overrideDueDate(workspaceId, new Date('2026-09-30T00:00:00Z'), 'reason', actor);

    sqlite()
      .prepare(`UPDATE referral_workspaces SET work_status_set_at = ? WHERE id = ?`)
      .run(SEC(entered), workspaceId);

    const after = await clearOverrides(workspaceId, actor);
    expect(after?.nextAction).toBe('Acknowledge receipt of the referral');
    expect(after?.dueDateOverridden).toBe(false);
    expect(after?.nextActionDueAt?.toISOString()).toBe('2026-09-16T13:00:00.000Z');
  });
});

// ── Overdue ──────────────────────────────────────────────────────────────────

describe('isOverdue', () => {
  const due = new Date('2026-09-16T12:00:00Z');

  /** Strictly past. A deadline of 17:00 is MET at 17:00. */
  it('is false exactly at the due instant and true one millisecond later', () => {
    expect(isOverdue({ nextActionDueAt: due }, new Date(due.getTime()))).toBe(false);
    expect(isOverdue({ nextActionDueAt: due }, new Date(due.getTime() + 1))).toBe(true);
    expect(isOverdue({ nextActionDueAt: due }, new Date(due.getTime() - 1))).toBe(false);
  });

  it('is false with no due date', () => {
    expect(isOverdue({ nextActionDueAt: null }, new Date())).toBe(false);
  });

  it('is false for an archived workspace', () => {
    expect(
      isOverdue({ nextActionDueAt: due, archivedAt: new Date() }, new Date(due.getTime() + 10_000)),
    ).toBe(false);
  });
});

describe('checkAndFlagOverdueWorkspaces', () => {
  const past = new Date('2026-09-10T00:00:00Z');
  const now = new Date('2026-09-16T00:00:00Z');

  async function overdueWorkspace(): Promise<number> {
    const { workspaceId } = makeWorkspace({ state: ReferralState.RECEIVED });
    await recomputeNextAction(workspaceId, past);
    return workspaceId;
  }

  /** AC14 — once per due date, not once per sweep. */
  it('emits once and then nothing on a second sweep', async () => {
    await overdueWorkspace();
    expect(await checkAndFlagOverdueWorkspaces(now)).toBe(1);
    expect(events('workspace.overdue')).toHaveLength(1);

    expect(await checkAndFlagOverdueWorkspaces(now)).toBe(0);
    expect(events('workspace.overdue')).toHaveLength(1);
  });

  it('carries the due date and hours overdue in the event', async () => {
    await overdueWorkspace();
    await checkAndFlagOverdueWorkspaces(now);
    const meta = JSON.parse(events('workspace.overdue')[0].metadata as string) as Record<
      string,
      unknown
    >;
    expect(meta.dueAt).toBe('2026-09-10T04:00:00.000Z');
    expect(meta.hoursOverdue).toBe(140);
    expect(meta.awaitedBy).toBe('us');
  });

  /** A new deadline is a new breach; the old notification must not suppress it. */
  it('notifies again after the due date is moved', async () => {
    const actor = insertUser();
    const workspaceId = await overdueWorkspace();
    await checkAndFlagOverdueWorkspaces(now);
    expect(events('workspace.overdue')).toHaveLength(1);

    await overrideDueDate(workspaceId, new Date('2026-09-12T00:00:00Z'), 'still late', actor);
    expect(await checkAndFlagOverdueWorkspaces(now)).toBe(1);
    expect(events('workspace.overdue')).toHaveLength(2);
  });

  it('excludes an archived workspace', async () => {
    const workspaceId = await overdueWorkspace();
    sqlite().prepare(`UPDATE referral_workspaces SET archived_at = 1 WHERE id = ?`).run(workspaceId);
    expect(await checkAndFlagOverdueWorkspaces(now)).toBe(0);
  });

  it('excludes a workspace with no due date', async () => {
    const { workspaceId } = makeWorkspace({
      state: ReferralState.DECLINED,
      workStatus: WorkStatus.RESOLVED,
    });
    await recomputeNextAction(workspaceId, past);
    expect(dueOf(workspaceId)).toBeNull();
    expect(await checkAndFlagOverdueWorkspaces(now)).toBe(0);
  });

  it('does not flag a workspace exactly at its due instant', async () => {
    const { workspaceId } = makeWorkspace({ state: ReferralState.RECEIVED });
    const entered = new Date('2026-09-16T08:00:00Z');
    await recomputeNextAction(workspaceId, entered);
    // Due is entered + 4h = 12:00 exactly.
    expect(await checkAndFlagOverdueWorkspaces(new Date('2026-09-16T12:00:00Z'))).toBe(0);
    expect(await checkAndFlagOverdueWorkspaces(new Date('2026-09-16T12:00:01Z'))).toBe(1);
    void workspaceId;
  });
});

describe('getOverdueWorkspaces', () => {
  it('lists the overdue ones worst first', async () => {
    const a = makeWorkspace({ state: ReferralState.RECEIVED });
    const b = makeWorkspace({ state: ReferralState.RECEIVED });
    const c = makeWorkspace({ state: ReferralState.RECEIVED });
    await recomputeNextAction(a.workspaceId, new Date('2026-09-01T00:00:00Z'));
    await recomputeNextAction(b.workspaceId, new Date('2026-09-14T00:00:00Z'));
    await recomputeNextAction(c.workspaceId, new Date('2026-09-20T00:00:00Z'));

    const rows = await getOverdueWorkspaces(new Date('2026-09-16T00:00:00Z'));
    expect(rows.map((r) => r.workspaceId)).toEqual([a.workspaceId, b.workspaceId]);
    expect(rows[0].hoursOverdue).toBeGreaterThan(rows[1].hoursOverdue);
  });
});

describe('listOverdue scoping', () => {
  it('narrows to the given queue ids and returns nothing for an empty scope', async () => {
    const now = new Date('2026-09-16T00:00:00Z');
    const inQueue = makeWorkspace({ state: ReferralState.RECEIVED });
    const elsewhere = makeWorkspace({ state: ReferralState.RECEIVED });
    await recomputeNextAction(inQueue.workspaceId, new Date('2026-09-01T00:00:00Z'));
    await recomputeNextAction(elsewhere.workspaceId, new Date('2026-09-01T00:00:00Z'));
    sqlite()
      .prepare(`UPDATE referral_workspaces SET queue_id = 7 WHERE id = ?`)
      .run(inQueue.workspaceId);
    sqlite()
      .prepare(`UPDATE referral_workspaces SET queue_id = 9 WHERE id = ?`)
      .run(elsewhere.workspaceId);

    expect((await listOverdue([7], now)).map((r) => r.workspaceId)).toEqual([inQueue.workspaceId]);
    expect(await listOverdue([], now)).toEqual([]);
    expect((await listOverdue('all', now)).length).toBe(2);
  });

  it('carries the patient name and the awaited-by indicator', async () => {
    const now = new Date('2026-09-16T00:00:00Z');
    const { workspaceId } = makeWorkspace({ state: ReferralState.PENDING_INFORMATION });
    addParty(workspaceId, 'initiating');
    await recomputeNextAction(workspaceId, new Date('2026-09-01T00:00:00Z'));
    const [item] = await listOverdue('all', now);
    expect(item.patientName).toMatch(/Test Patient/);
    expect(item.awaitedBy).toBe('party');
  });
});

// ── The message-level behaviour must be untouched ────────────────────────────

describe('PRD-07 message overdue behaviour is preserved (AC16)', () => {
  it('still finds pending messages past the threshold and ignores acknowledged ones', async () => {
    const { referralId } = makeWorkspace();
    addOutbound(referralId, 'Pending');
    addOutbound(referralId, 'Acknowledged');

    const overdue = await getOverdueMessages();
    expect(overdue).toHaveLength(1);
    expect(overdue[0].messageType).toBe('ConsultNote');
  });

  it('respects an explicit threshold argument', async () => {
    const { referralId } = makeWorkspace();
    addOutbound(referralId, 'Pending');
    // sent_at is 0 (epoch), so a huge threshold puts the cutoff before it.
    expect(await getOverdueMessages(Date.now() + 1_000_000)).toHaveLength(0);
  });
});

// ── Backfill ─────────────────────────────────────────────────────────────────

describe('backfillNextActions', () => {
  it('computes for every non-archived workspace and skips archived ones', async () => {
    makeWorkspace({ state: ReferralState.RECEIVED });
    const archived = makeWorkspace({ state: ReferralState.RECEIVED });
    sqlite()
      .prepare(`UPDATE referral_workspaces SET archived_at = 1 WHERE id = ?`)
      .run(archived.workspaceId);

    expect(await backfillNextActions()).toEqual({ computed: 1, skipped: 1 });
    expect(dueOf(archived.workspaceId)).toBeNull();
  });

  /**
   * Uses each workspace's OWN timestamp, so existing overdue work stays
   * overdue rather than every deadline resetting to the backfill moment.
   */
  it('does not reset existing deadlines to now', async () => {
    const longAgo = new Date(Date.now() - 200 * 3600 * 1000);
    const { workspaceId } = makeWorkspace({
      state: ReferralState.RECEIVED,
      workStatusSetAt: longAgo,
    });
    await backfillNextActions();
    const state = await getNextActionState(workspaceId);
    expect(state?.overdue).toBe(true);
  });

  it('is idempotent', async () => {
    makeWorkspace({ state: ReferralState.RECEIVED });
    await backfillNextActions();
    const before = events('workspace.next_action_changed').length;
    await backfillNextActions();
    expect(events('workspace.next_action_changed')).toHaveLength(before);
  });

  /**
   * The bug this test found. The entry-moment fallback was `updatedAt`, which
   * recomputeNextAction WRITES — so every backfill pushed the due date forward
   * by however long had passed, quietly un-overdueing the whole database while
   * looking like the feature working. The fallback is `createdAt`, which never
   * moves.
   */
  it('produces the SAME due date on a repeated run', async () => {
    const { workspaceId } = makeWorkspace({ state: ReferralState.RECEIVED });
    await backfillNextActions();
    const first = dueOf(workspaceId);
    expect(first).not.toBeNull();

    await backfillNextActions();
    expect(dueOf(workspaceId)).toBe(first);

    await backfillNextActions();
    expect(dueOf(workspaceId)).toBe(first);
  });

  /** Same property for a plain recompute with no explicit entry moment. */
  it('recomputes to the same due date when called repeatedly without an entry time', async () => {
    const { workspaceId } = makeWorkspace({ state: ReferralState.RECEIVED });
    const a = await recomputeNextAction(workspaceId);
    const b = await recomputeNextAction(workspaceId);
    expect(b?.nextActionDueAt?.getTime()).toBe(a?.nextActionDueAt?.getTime());
  });
});
