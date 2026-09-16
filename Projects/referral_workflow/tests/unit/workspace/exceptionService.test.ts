/**
 * Unit tests for exceptionService.ts and correlationService.ts (PRD-28)
 *
 * The properties that carry the weight, in order of how bad getting them wrong
 * would be:
 *
 *   - **reassociation never replays a protocol transition.** Attaching an
 *     orphaned message is a records operation; advancing `referrals.state` is a
 *     protocol operation. Coupling them would let a mis-association corrupt the
 *     externally authoritative state, which is the one thing the epic's
 *     dual-status rule exists to protect. Asserted directly.
 *   - **duplicate patients are FLAGGED, never merged.** Merging two people's
 *     clinical records wrongly is materially worse than carrying two records for
 *     one person.
 *   - **the raw artifact is retained.** On these paths the exception row is the
 *     only copy — the content is otherwise discarded.
 *   - **every candidate carries a reason.** A coordinator about to attach a
 *     clinical document to a patient's record needs to see why, not a score they
 *     have to trust.
 */

jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct', orgName: 'Specialist Care Group' },
    database: { url: ':memory:' },
    workspace: {
        // PRD-27. Without these the notification path silently no-ops and
        // every assignment or mention in this suite logs a failure.
        notificationRetentionDays: 90,
        notificationCollapseWindowMinutes: 15, overdueSweepIntervalMs: 900000 },
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

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ReferralState } from '../../../src/state/referralStateMachine';
import { WorkStatus } from '../../../src/state/workStatusMachine';
import { ActingUser } from '../../../src/modules/workspace/identityService';
import {
  AlreadyAssociatedError,
  ExceptionAlreadyResolvedError,
  ExceptionNotFoundError,
  ExceptionWorkspaceNotFoundError,
  MAX_RAW_CONTENT,
  WrongExceptionTypeError,
  candidatesFor,
  convertAutoDeclined,
  flagDuplicatePatient,
  getException,
  hasOpenException,
  lastNameOf,
  listExceptions,
  openExceptionCount,
  raiseException,
  reassociate,
  recordAutoDeclined,
  resolveException,
} from '../../../src/modules/workspace/exceptionService';
import {
  MessageNotProcessedError,
  correlate,
  findPotentialDuplicatePatients,
  getProcessed,
  importLegacyProcessedFile,
  isAlreadyProcessed,
  listProcessed,
  rankCandidates,
  recordProcessed,
  replayMessage,
} from '../../../src/modules/workspace/correlationService';
import {
  createWorkspace,
  getWorkspace,
  setWorkStatus,
} from '../../../src/modules/workspace/workspaceService';

function sqlite(): import('better-sqlite3').Database {
  return (global as Record<string, unknown>).__TEST_SQLITE__ as import('better-sqlite3').Database;
}

function clearTables(): void {
  sqlite().exec(
    `DELETE FROM workflow_events;
     DELETE FROM processed_messages;
     DELETE FROM workspace_exceptions;
     DELETE FROM auto_declined_referrals;
     DELETE FROM referral_messages;
     DELETE FROM outbound_messages;
     DELETE FROM workspace_parties;
     DELETE FROM referral_workspaces;
     DELETE FROM referrals;
     DELETE FROM patients;
     DELETE FROM users;
     DELETE FROM queues;`,
  );
}

let seq = 0;

function insertUser(name = 'Dana Ruiz'): ActingUser {
  seq += 1;
  const email = `ex${seq}@example.test`;
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

function insertReferral(opts: {
  state?: ReferralState;
  referrer?: string;
  lastName?: string;
  dob?: string;
} = {}): number {
  seq += 1;
  const patient = sqlite()
    .prepare(`INSERT INTO patients (first_name, last_name, date_of_birth) VALUES (?, ?, ?)`)
    .run('Test', opts.lastName ?? `Patient${seq}`, opts.dob ?? '1980-01-01');
  const r = sqlite()
    .prepare(
      `INSERT INTO referrals (patient_id, source_message_id, referrer_address, state,
                              routing_department, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Cardiology', 0, 0)`,
    )
    .run(
      patient.lastInsertRowid,
      `exc-${seq}`,
      opts.referrer ?? 'ref@hospital.direct',
      opts.state ?? ReferralState.RECEIVED,
    );
  return Number(r.lastInsertRowid);
}

async function makeWorkspace(
  opts: Parameters<typeof insertReferral>[0] & { workStatus?: WorkStatus } = {},
): Promise<{ workspaceId: number; referralId: number }> {
  const referralId = insertReferral(opts);
  const ws = await createWorkspace(referralId);
  if (opts.workStatus && opts.workStatus !== WorkStatus.TRIAGE) {
    await setWorkStatus(ws.id, opts.workStatus, 'system');
  }
  return { workspaceId: ws.id, referralId };
}

function events(type?: string): Array<Record<string, unknown>> {
  const rows = sqlite()
    .prepare(`SELECT event_type, entity_id, from_state, to_state, actor, metadata FROM workflow_events`)
    .all() as Array<Record<string, unknown>>;
  return type ? rows.filter((r) => r.event_type === type) : rows;
}

function stateOf(referralId: number): string {
  return (
    sqlite().prepare(`SELECT state FROM referrals WHERE id = ?`).get(referralId) as {
      state: string;
    }
  ).state;
}

async function settle(): Promise<void> {
  // The exception_raised audit is fire-and-forget by design, so give it a tick.
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

beforeEach(() => clearTables());

// ── Raising ──────────────────────────────────────────────────────────────────

describe('raiseException', () => {
  it('retains the raw artifact, which is the whole point', async () => {
    const raw = 'MSH|^~\\&|A|B|C|D|20260916||ACK|x|P|2.5.1\rMSA|AA|nope\r';
    const id = await raiseException({
      exceptionType: 'unmatched-ack',
      summary: 'ACK for an unknown control id',
      remediation: 'Attach to the right referral or dismiss',
      rawContent: raw,
      rawContentType: 'application/hl7-v2',
      senderAddress: 'referrals@northside.direct.example.org',
      messageControlId: 'nope',
    });

    const exc = await getException(id);
    expect(exc?.rawContent).toBe(raw);
    expect(exc?.rawContentType).toBe('application/hl7-v2');
    expect(exc?.senderAddress).toBe('referrals@northside.direct.example.org');
    // AC24: an orphan has no workspace and must still be a real, listable row.
    expect(exc?.workspaceId).toBeNull();
    // AC10: it names what arrived AND what to do.
    expect(exc?.summary).toBeTruthy();
    expect(exc?.remediation).toBeTruthy();
  });

  it('truncates oversized content and RECORDS the truncation', async () => {
    const id = await raiseException({
      exceptionType: 'unmatched-message',
      summary: 'huge',
      rawContent: 'x'.repeat(MAX_RAW_CONTENT + 5000),
    });
    const exc = await getException(id);
    expect(exc!.rawContent!.length).toBeLessThan(MAX_RAW_CONTENT + 200);
    // Silently losing half an artifact is worse than saying so.
    expect(exc?.metadata?.rawContentTruncated).toBe(true);
  });

  it('moves the workspace to Exception and captures the status it came from', async () => {
    const { workspaceId } = await makeWorkspace({ workStatus: WorkStatus.IN_PROGRESS });
    const id = await raiseException({
      workspaceId,
      exceptionType: 'out-of-order',
      summary: 'a duplicate SIU arrived',
    });

    expect((await getWorkspace(workspaceId))?.workStatus).toBe(WorkStatus.EXCEPTION);
    expect((await getException(id))?.priorWorkStatus).toBe(WorkStatus.IN_PROGRESS);
  });

  it('does not record Exception as the prior status when already in Exception', async () => {
    const { workspaceId } = await makeWorkspace({ workStatus: WorkStatus.EXCEPTION });
    const id = await raiseException({
      workspaceId,
      exceptionType: 'out-of-order',
      summary: 'second one',
    });
    // Recording Exception as "prior" would make resolution a no-op.
    expect((await getException(id))?.priorWorkStatus).toBeNull();
  });

  it('emits exception_raised', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await raiseException({ workspaceId, exceptionType: 'delivery-failed', summary: 'send failed' });
    await settle();
    const emitted = events('workspace.exception_raised');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].entity_id).toBe(referralId);
    expect(emitted[0].to_state).toBe(WorkStatus.EXCEPTION);
  });

  it('counts open exceptions and reports them to PRD-18', async () => {
    const { workspaceId } = await makeWorkspace();
    expect(await hasOpenException(workspaceId)).toBe(false);
    await raiseException({ workspaceId, exceptionType: 'delivery-failed', summary: 'a' });
    await raiseException({ workspaceId, exceptionType: 'unresolvable-address', summary: 'b' });
    expect(await openExceptionCount(workspaceId)).toBe(2);
    expect(await hasOpenException(workspaceId)).toBe(true);
  });
});

// ── Listing ──────────────────────────────────────────────────────────────────

describe('listExceptions', () => {
  it('lists open ones by default, newest first, with the patient joined', async () => {
    const { workspaceId } = await makeWorkspace({ lastName: 'Alvarez' });
    await raiseException({ workspaceId, exceptionType: 'delivery-failed', summary: 'first' });
    await raiseException({ exceptionType: 'unmatched-message', summary: 'orphan' });

    const open = await listExceptions();
    expect(open).toHaveLength(2);
    const attached = open.find((e) => e.workspaceId === workspaceId);
    expect(attached?.patientName).toContain('Alvarez');
    expect(attached?.ageHours).toBeGreaterThanOrEqual(0);
  });

  it('excludes resolved ones unless asked', async () => {
    const actor = insertUser();
    const id = await raiseException({ exceptionType: 'unmatched-message', summary: 'x' });
    await resolveException(id, 'dismissed', actor);
    expect(await listExceptions()).toHaveLength(0);
    expect(await listExceptions({ openOnly: false })).toHaveLength(1);
  });

  it('filters by type and by workspace', async () => {
    const { workspaceId } = await makeWorkspace();
    await raiseException({ workspaceId, exceptionType: 'delivery-failed', summary: 'a' });
    await raiseException({ exceptionType: 'unmatched-message', summary: 'b' });

    expect(await listExceptions({ exceptionType: 'delivery-failed' })).toHaveLength(1);
    expect(await listExceptions({ workspaceId })).toHaveLength(1);
  });

  /**
   * AC24, and the reason it matters: an orphaned inbound message is exactly the
   * kind that used to vanish. Scoping it out of every queue would recreate that
   * — nobody would ever see it.
   */
  it('ALWAYS includes orphans, whatever the queue scope', async () => {
    const { workspaceId } = await makeWorkspace();
    sqlite().prepare(`UPDATE referral_workspaces SET queue_id = 7 WHERE id = ?`).run(workspaceId);
    await raiseException({ workspaceId, exceptionType: 'delivery-failed', summary: 'in queue 7' });
    await raiseException({ exceptionType: 'unmatched-message', summary: 'orphan' });

    // A scope that excludes the workspace still shows the orphan.
    const scoped = await listExceptions({ queueIds: [99] });
    expect(scoped.map((e) => e.summary)).toEqual(['orphan']);

    // And a scope that includes it shows both.
    expect(await listExceptions({ queueIds: [7, 99] })).toHaveLength(2);
    expect(await listExceptions({ queueIds: 'all' })).toHaveLength(2);
  });
});

// ── Resolution ───────────────────────────────────────────────────────────────

describe('resolveException', () => {
  it('restores the prior work status (AC23)', async () => {
    const actor = insertUser();
    const { workspaceId } = await makeWorkspace({ workStatus: WorkStatus.WAITING_EXTERNAL });
    const id = await raiseException({ workspaceId, exceptionType: 'delivery-failed', summary: 'x' });
    expect((await getWorkspace(workspaceId))?.workStatus).toBe(WorkStatus.EXCEPTION);

    await resolveException(id, 'dismissed', actor, 'sent in error');
    expect((await getWorkspace(workspaceId))?.workStatus).toBe(WorkStatus.WAITING_EXTERNAL);
  });

  /** "Or to Triage when that is ambiguous" — Triage means "somebody look at this". */
  it('restores to Triage when there was no prior status', async () => {
    const actor = insertUser();
    const { workspaceId } = await makeWorkspace({ workStatus: WorkStatus.EXCEPTION });
    const id = await raiseException({ workspaceId, exceptionType: 'delivery-failed', summary: 'x' });
    expect((await getException(id))?.priorWorkStatus).toBeNull();

    await resolveException(id, 'dismissed', actor);
    expect((await getWorkspace(workspaceId))?.workStatus).toBe(WorkStatus.TRIAGE);
  });

  /** Resolving one of several must not clear the status while work remains. */
  it('does not leave Exception until every exception is resolved', async () => {
    const actor = insertUser();
    const { workspaceId } = await makeWorkspace({ workStatus: WorkStatus.IN_PROGRESS });
    const a = await raiseException({ workspaceId, exceptionType: 'delivery-failed', summary: 'a' });
    const b = await raiseException({
      workspaceId,
      exceptionType: 'unresolvable-address',
      summary: 'b',
    });

    await resolveException(a, 'dismissed', actor);
    expect((await getWorkspace(workspaceId))?.workStatus).toBe(WorkStatus.EXCEPTION);

    await resolveException(b, 'dismissed', actor);
    expect((await getWorkspace(workspaceId))?.workStatus).toBe(WorkStatus.IN_PROGRESS);
  });

  /**
   * The bug the test above caught, pinned from the other direction.
   *
   * The restore used the prior status of the exception BEING RESOLVED. With two
   * open at once only the FIRST captured a real one — the second was raised
   * against a workspace already in Exception — so resolving them in order
   * restored Triage and discarded the In-Progress the workspace was in.
   */
  it('restores the status from before the episode began, whatever the resolution order', async () => {
    const actor = insertUser();
    for (const order of [
      ['a', 'b'],
      ['b', 'a'],
    ] as const) {
      clearTables();
      const { workspaceId } = await makeWorkspace({ workStatus: WorkStatus.WAITING_EXTERNAL });
      const ids: Record<string, number> = {
        a: await raiseException({ workspaceId, exceptionType: 'delivery-failed', summary: 'a' }),
        b: await raiseException({
          workspaceId,
          exceptionType: 'unresolvable-address',
          summary: 'b',
        }),
      };
      const who = insertUser();
      for (const key of order) await resolveException(ids[key], 'dismissed', who);
      expect((await getWorkspace(workspaceId))?.workStatus).toBe(WorkStatus.WAITING_EXTERNAL);
    }
    void actor;
  });

  /** A person's later decision outranks this one. */
  it('leaves the status alone when somebody moved it on themselves', async () => {
    const actor = insertUser();
    const { workspaceId } = await makeWorkspace({ workStatus: WorkStatus.IN_PROGRESS });
    const id = await raiseException({ workspaceId, exceptionType: 'delivery-failed', summary: 'x' });
    await setWorkStatus(workspaceId, WorkStatus.WAITING_INTERNAL, 'user:1');

    await resolveException(id, 'dismissed', actor);
    expect((await getWorkspace(workspaceId))?.workStatus).toBe(WorkStatus.WAITING_INTERNAL);
  });

  it('records who, what and why, and emits exception_resolved', async () => {
    const actor = insertUser('Priya Raman');
    const id = await raiseException({ exceptionType: 'unmatched-message', summary: 'x' });
    const resolved = await resolveException(id, 'dismissed', actor, 'staging system test message');

    expect(resolved.resolution).toBe('dismissed');
    expect(resolved.resolvedByActor).toBe(`user:${actor.id}`);
    expect(resolved.resolutionNote).toBe('staging system test message');
    await settle();
    expect(events('workspace.exception_resolved')).toHaveLength(1);
  });

  it('refuses an unknown or already-resolved exception', async () => {
    const actor = insertUser();
    await expect(resolveException(9999, 'dismissed', actor)).rejects.toThrow(ExceptionNotFoundError);
    const id = await raiseException({ exceptionType: 'unmatched-message', summary: 'x' });
    await resolveException(id, 'dismissed', actor);
    await expect(resolveException(id, 'dismissed', actor)).rejects.toThrow(
      ExceptionAlreadyResolvedError,
    );
  });
});

// ── Reassociation ────────────────────────────────────────────────────────────

describe('reassociate', () => {
  /** THE rule of this module. */
  it('does NOT replay the protocol transition (AC14)', async () => {
    const actor = insertUser();
    const { workspaceId, referralId } = await makeWorkspace({ state: ReferralState.SCHEDULED });
    const before = stateOf(referralId);

    const id = await raiseException({
      exceptionType: 'unmatched-ack',
      summary: 'ACK for control id MSG00291',
      rawContent: 'MSA|AA|MSG00291',
      messageControlId: 'MSG00291',
      senderAddress: 'referrals@northside.direct.example.org',
    });
    await reassociate(id, workspaceId, actor, 'control id mangled; patient and dates match');

    expect(stateOf(referralId)).toBe(before);
    expect(stateOf(referralId)).toBe(ReferralState.SCHEDULED);
  });

  it('attaches the artifact to the thread and resolves the exception', async () => {
    const actor = insertUser();
    const { workspaceId, referralId } = await makeWorkspace();
    const id = await raiseException({
      exceptionType: 'unmatched-ack',
      summary: 'orphan ack',
      rawContent: 'MSA|AA|MSG777',
      messageControlId: 'MSG777',
    });

    const result = await reassociate(id, workspaceId, actor, 'matched by patient');

    const thread = sqlite()
      .prepare(`SELECT * FROM referral_messages WHERE referral_id = ?`)
      .all(referralId) as Array<Record<string, unknown>>;
    expect(thread.some((m) => m.message_control_id === 'MSG777')).toBe(true);
    expect(thread.some((m) => String(m.content_body).includes('MSG777'))).toBe(true);

    expect(result.resolution).toBe('reassociated');
    expect(result.workspaceId).toBe(workspaceId);
  });

  it('records the full audit AC13 asks for', async () => {
    const actor = insertUser('Sam Okafor');
    const { workspaceId, referralId } = await makeWorkspace();
    const id = await raiseException({
      exceptionType: 'unmatched-ack',
      summary: 'ACK for control id MSG555',
      messageControlId: 'MSG555',
      senderAddress: 'referrals@northside.direct.example.org',
    });
    await reassociate(id, workspaceId, actor, 'control id mangled by the sending system');

    await settle();
    const emitted = events('workspace.reassociated');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].entity_id).toBe(referralId);
    expect(emitted[0].actor).toBe(`user:${actor.id}`);
    const meta = JSON.parse(emitted[0].metadata as string) as Record<string, unknown>;
    expect(meta).toMatchObject({
      exceptionId: id,
      workspaceId,
      note: 'control id mangled by the sending system',
      originalMessageControlId: 'MSG555',
      originalSenderAddress: 'referrals@northside.direct.example.org',
      // Stated in the audit record itself, not merely in a comment.
      protocolStateReplayed: false,
    });
  });

  it('refuses a workspace that already carries that message', async () => {
    const actor = insertUser();
    const { workspaceId } = await makeWorkspace();
    const first = await raiseException({
      exceptionType: 'unmatched-ack',
      summary: 'a',
      messageControlId: 'MSG999',
    });
    await reassociate(first, workspaceId, actor, 'first');

    const second = await raiseException({
      exceptionType: 'unmatched-ack',
      summary: 'b',
      messageControlId: 'MSG999',
    });
    await expect(reassociate(second, workspaceId, actor, 'again')).rejects.toThrow(
      AlreadyAssociatedError,
    );
  });

  it('refuses an unknown workspace', async () => {
    const actor = insertUser();
    const id = await raiseException({ exceptionType: 'unmatched-ack', summary: 'x' });
    await expect(reassociate(id, 9999, actor, 'note')).rejects.toThrow(
      ExceptionWorkspaceNotFoundError,
    );
  });
});

// ── Candidate ranking ────────────────────────────────────────────────────────

describe('rankCandidates', () => {
  it('scores a sender and surname match above either alone', async () => {
    const both = await makeWorkspace({ referrer: 'dr.ofori@northside.direct', lastName: 'Alvarez' });
    const senderOnly = await makeWorkspace({
      referrer: 'dr.ofori@northside.direct',
      lastName: 'Different',
    });
    const neither = await makeWorkspace({ referrer: 'someone@elsewhere.direct', lastName: 'Nope' });

    const ranked = await rankCandidates({
      senderAddress: 'dr.ofori@northside.direct',
      patientLastName: 'Alvarez',
    });

    expect(ranked[0].workspaceId).toBe(both.workspaceId);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked.map((c) => c.workspaceId)).toContain(senderOnly.workspaceId);
    // No hint at all => not a candidate, rather than a zero-scored one.
    expect(ranked.map((c) => c.workspaceId)).not.toContain(neither.workspaceId);
  });

  /**
   * The other bug the suite caught. Recency was added BEFORE the
   * "no reasons, not a candidate" gate, so every recently created workspace
   * qualified on recency alone — in a fresh database the candidate list was
   * simply every workspace, which is worse than no suggestions at all.
   */
  it('does not make recency alone qualify a workspace as a candidate', async () => {
    // Three brand-new workspaces, none matching the keys.
    await makeWorkspace({ referrer: 'a@elsewhere.direct', lastName: 'Xx' });
    await makeWorkspace({ referrer: 'b@elsewhere.direct', lastName: 'Yy' });
    await makeWorkspace({ referrer: 'c@elsewhere.direct', lastName: 'Zz' });

    expect(await rankCandidates({ senderAddress: 'nobody@nowhere.direct' })).toEqual([]);
    expect(await rankCandidates({ patientLastName: 'Nomatch' })).toEqual([]);
  });

  it('still uses recency to break a tie between substantive matches', async () => {
    const recent = await makeWorkspace({ referrer: 'dr.ofori@northside.direct', lastName: 'A' });
    const old = await makeWorkspace({ referrer: 'dr.ofori@northside.direct', lastName: 'B' });
    sqlite()
      .prepare(`UPDATE referral_workspaces SET created_at = 0 WHERE id = ?`)
      .run(old.workspaceId);

    const ranked = await rankCandidates({ senderAddress: 'dr.ofori@northside.direct' });
    expect(ranked[0].workspaceId).toBe(recent.workspaceId);
    expect(ranked[0].reasons).toContain('created within 7 days');
    expect(ranked.find((c) => c.workspaceId === old.workspaceId)?.reasons).not.toContain(
      'created within 7 days',
    );
  });

  /** Explainability is a requirement, not a nicety. */
  it('gives EVERY candidate at least one reason', async () => {
    await makeWorkspace({ referrer: 'dr.ofori@northside.direct', lastName: 'Alvarez' });
    await makeWorkspace({ referrer: 'other@northside.direct', lastName: 'Alvarez' });

    const ranked = await rankCandidates({
      senderAddress: 'dr.ofori@northside.direct',
      patientLastName: 'Alvarez',
    });
    expect(ranked.length).toBeGreaterThan(0);
    for (const c of ranked) {
      expect(c.reasons.length).toBeGreaterThan(0);
      expect(c.reasons.every((r) => r.length > 0)).toBe(true);
    }
  });

  it('names the specific reasons it used', async () => {
    await makeWorkspace({
      referrer: 'dr.ofori@northside.direct',
      lastName: 'Alvarez',
      dob: '1962-03-04',
    });
    const [top] = await rankCandidates({
      senderAddress: 'dr.ofori@northside.direct',
      patientLastName: 'Alvarez',
      patientDob: '1962-03-04',
    });
    expect(top.reasons).toEqual(
      expect.arrayContaining([
        'sender address matches the referring address',
        'patient surname matches',
        'patient date of birth matches',
      ]),
    );
  });

  it('scores a same-domain sender lower than an exact address', async () => {
    const exact = await makeWorkspace({ referrer: 'dr.ofori@northside.direct', lastName: 'A' });
    const domain = await makeWorkspace({ referrer: 'someone.else@northside.direct', lastName: 'B' });
    const ranked = await rankCandidates({ senderAddress: 'dr.ofori@northside.direct' });
    const e = ranked.find((c) => c.workspaceId === exact.workspaceId);
    const d = ranked.find((c) => c.workspaceId === domain.workspaceId);
    expect(e!.score).toBeGreaterThan(d!.score);
    expect(d!.reasons).toContain('sender is at the same organization domain');
  });

  it('is case-insensitive on the sender and the surname', async () => {
    const { workspaceId } = await makeWorkspace({
      referrer: 'Dr.Ofori@Northside.Direct',
      lastName: 'Alvarez',
    });
    const ranked = await rankCandidates({
      senderAddress: 'dr.ofori@northside.direct',
      patientLastName: 'ALVAREZ',
    });
    expect(ranked[0].workspaceId).toBe(workspaceId);
  });

  it('caps the list rather than returning every workspace', async () => {
    for (let i = 0; i < 14; i += 1) {
      await makeWorkspace({ referrer: 'bulk@northside.direct', lastName: 'Same' });
    }
    expect((await rankCandidates({ senderAddress: 'bulk@northside.direct' })).length).toBe(10);
  });

  it('derives candidates for an exception from its own fields', async () => {
    const { workspaceId } = await makeWorkspace({
      referrer: 'dr.ofori@northside.direct',
      lastName: 'Alvarez',
    });
    const id = await raiseException({
      exceptionType: 'unmatched-ack',
      summary: 'orphan',
      senderAddress: 'dr.ofori@northside.direct',
      relatedPatientName: 'R. Alvarez',
    });
    const candidates = await candidatesFor(id);
    expect(candidates[0].workspaceId).toBe(workspaceId);
  });
});

describe('lastNameOf', () => {
  it('handles both display orders', () => {
    expect(lastNameOf('R. Alvarez')).toBe('Alvarez');
    expect(lastNameOf('Alvarez, R.')).toBe('Alvarez');
    expect(lastNameOf(null)).toBeUndefined();
    expect(lastNameOf('   ')).toBeUndefined();
  });
});

// ── Correlation ──────────────────────────────────────────────────────────────

describe('correlate', () => {
  it('matches on message control id before anything else', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    seq += 1;
    sqlite()
      .prepare(
        `INSERT INTO outbound_messages (referral_id, message_control_id, message_type, status, sent_at)
         VALUES (?, 'CTRL-1', 'SIU', 'Pending', 0)`,
      )
      .run(referralId);

    const result = await correlate({ messageControlId: 'CTRL-1' });
    expect(result).toEqual({ matched: true, workspaceId, referralId, via: 'messageControlId' });
  });

  it('matches on the external 360X referral id', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    sqlite()
      .prepare(`UPDATE referral_workspaces SET external_referral_id = 'EXT-42' WHERE id = ?`)
      .run(workspaceId);

    expect(await correlate({ externalReferralId: 'EXT-42' })).toEqual({
      matched: true,
      workspaceId,
      referralId,
      via: 'externalReferralId',
    });
  });

  /** A patient name is a HINT, not an identifier. */
  it('falls back to ranked candidates rather than treating a name as a match', async () => {
    await makeWorkspace({ referrer: 'dr.ofori@northside.direct', lastName: 'Alvarez' });
    const result = await correlate({
      senderAddress: 'dr.ofori@northside.direct',
      patientLastName: 'Alvarez',
    });
    expect(result.matched).toBe(false);
    if (!result.matched) expect(result.candidates.length).toBeGreaterThan(0);
  });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe('processed messages', () => {
  it('is false for an unseen id and true after recording', async () => {
    expect(await isAlreadyProcessed('<a@b>')).toBe(false);
    await recordProcessed({ messageId: '<a@b>', outcome: 'referral-created' });
    expect(await isAlreadyProcessed('<a@b>')).toBe(true);
  });

  it('updates rather than throwing when the same id is recorded again', async () => {
    await recordProcessed({ messageId: '<a@b>', outcome: 'exception' });
    await recordProcessed({ messageId: '<a@b>', outcome: 'referral-created' });
    expect((await getProcessed('<a@b>'))?.outcome).toBe('referral-created');
    expect(await listProcessed()).toHaveLength(1);
  });

  it('records the outcome, not merely that it was seen', async () => {
    await recordProcessed({
      messageId: '<x@y>',
      senderAddress: 'a@b.test',
      subject: 'Referral',
      outcome: 'ignored',
    });
    const [row] = await listProcessed();
    expect(row).toMatchObject({ outcome: 'ignored', senderAddress: 'a@b.test', subject: 'Referral' });
  });

  it('filters by outcome', async () => {
    await recordProcessed({ messageId: '<1>', outcome: 'ignored' });
    await recordProcessed({ messageId: '<2>', outcome: 'referral-created' });
    expect(await listProcessed(200, 'ignored')).toHaveLength(1);
  });
});

describe('importLegacyProcessedFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'legacy-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('imports each id once and is idempotent on a second run (AC3)', async () => {
    const file = join(dir, '.processed_messages.json');
    writeFileSync(file, JSON.stringify(['<a@b>', '<c@d>']));

    expect(await importLegacyProcessedFile(file)).toEqual({
      imported: 2,
      skipped: 0,
      fileFound: true,
    });
    expect(await importLegacyProcessedFile(file)).toEqual({
      imported: 0,
      skipped: 2,
      fileFound: true,
    });
    expect(await isAlreadyProcessed('<a@b>')).toBe(true);
  });

  /**
   * The legacy file recorded only THAT a message was seen. Claiming
   * 'referral-created' for the imported ids would be inventing history.
   */
  it('marks imported ids as ignored rather than inventing an outcome', async () => {
    const file = join(dir, '.processed_messages.json');
    writeFileSync(file, JSON.stringify(['<a@b>']));
    await importLegacyProcessedFile(file);
    expect((await getProcessed('<a@b>'))?.outcome).toBe('ignored');
  });

  it('treats a missing file as the normal case, not an error', async () => {
    expect(await importLegacyProcessedFile(join(dir, 'nope.json'))).toEqual({
      imported: 0,
      skipped: 0,
      fileFound: false,
    });
  });

  it('tolerates a malformed file', async () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{not json');
    expect(await importLegacyProcessedFile(file)).toEqual({
      imported: 0,
      skipped: 0,
      fileFound: true,
    });
  });
});

describe('replayMessage', () => {
  it('marks the id replayed and audits who asked (AC4)', async () => {
    const actor = insertUser();
    await recordProcessed({ messageId: '<a@b>', outcome: 'referral-created', referralId: null });
    await replayMessage('<a@b>', actor);

    expect((await getProcessed('<a@b>'))?.outcome).toBe('replayed');
    await settle();
    const emitted = events('workspace.message_replayed');
    expect(emitted).toHaveLength(1);
    const meta = JSON.parse(emitted[0].metadata as string) as Record<string, unknown>;
    expect(meta.previousOutcome).toBe('referral-created');
  });

  it('refuses a message with no processing record', async () => {
    const actor = insertUser();
    await expect(replayMessage('<never-seen>', actor)).rejects.toThrow(MessageNotProcessedError);
  });
});

// ── Auto-declined referrals ──────────────────────────────────────────────────

describe('recordAutoDeclined', () => {
  it('retains the inbound document and raises a reviewable exception (AC15)', async () => {
    const { autoDeclinedId, exceptionId } = await recordAutoDeclined({
      sourceMessageId: '<declined@a>',
      referrerAddress: 'dr.ofori@northside.direct',
      patientName: 'R. Alvarez',
      patientDob: '1962-03-04',
      declineReasons: ['Missing problems section', 'No payer identified'],
      rawCcdaXml: '<ClinicalDocument/>',
    });

    expect(autoDeclinedId).toBeGreaterThan(0);
    const exc = await getException(exceptionId!);
    expect(exc?.exceptionType).toBe('auto-declined');
    // The retained C-CDA is the whole point — it is otherwise discarded.
    expect(exc?.rawContent).toBe('<ClinicalDocument/>');
    expect(exc?.summary).toContain('Missing problems section');
    expect(exc?.remediation).toContain('convert');
  });

  /** AC16: associated with the durable record instead of entityId 0. */
  it('emits against the record rather than entityId 0', async () => {
    const { autoDeclinedId } = await recordAutoDeclined({
      sourceMessageId: '<declined@b>',
      referrerAddress: 'a@b.test',
      declineReasons: ['x'],
    });
    await settle();
    const emitted = events('workspace.auto_declined_recorded');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].entity_id).toBe(-autoDeclinedId);
    expect(emitted[0].entity_id).not.toBe(0);
  });

  it('is idempotent on the source message id', async () => {
    const first = await recordAutoDeclined({
      sourceMessageId: '<declined@c>',
      referrerAddress: 'a@b.test',
      declineReasons: ['x'],
    });
    const second = await recordAutoDeclined({
      sourceMessageId: '<declined@c>',
      referrerAddress: 'a@b.test',
      declineReasons: ['x'],
    });
    expect(second.autoDeclinedId).toBe(first.autoDeclinedId);
    expect(second.exceptionId).toBeNull();
    expect(await listExceptions({ exceptionType: 'auto-declined' })).toHaveLength(1);
  });
});

describe('convertAutoDeclined', () => {
  it('creates a real referral and workspace, and links the original (AC17)', async () => {
    const actor = insertUser();
    const { autoDeclinedId, exceptionId } = await recordAutoDeclined({
      sourceMessageId: '<declined@d>',
      referrerAddress: 'dr.ofori@northside.direct',
      patientName: 'Rosa Alvarez',
      patientDob: '1962-03-04',
      declineReasons: ['Missing problems section'],
      rawCcdaXml: '<ClinicalDocument/>',
    });

    const { referralId, workspaceId } = await convertAutoDeclined(
      exceptionId!,
      actor,
      'the problems section was in an unexpected template',
    );

    // Starts at Received: nothing was ever acknowledged to the counterparty, so
    // the protocol has to run forward from intake.
    expect(stateOf(referralId)).toBe(ReferralState.RECEIVED);
    expect((await getWorkspace(workspaceId))?.referralId).toBe(referralId);

    const patient = sqlite()
      .prepare(
        `SELECT p.first_name f, p.last_name l, p.date_of_birth d FROM referrals r
         JOIN patients p ON p.id = r.patient_id WHERE r.id = ?`,
      )
      .get(referralId) as { f: string; l: string; d: string };
    expect(patient).toEqual({ f: 'Rosa', l: 'Alvarez', d: '1962-03-04' });

    const linked = sqlite()
      .prepare(`SELECT converted_referral_id c FROM auto_declined_referrals WHERE id = ?`)
      .get(autoDeclinedId) as { c: number };
    expect(linked.c).toBe(referralId);

    expect((await getException(exceptionId!))?.resolution).toBe('converted');
  });

  it('carries the original decline reasons into the conversion audit', async () => {
    const actor = insertUser();
    const { exceptionId } = await recordAutoDeclined({
      sourceMessageId: '<declined@e>',
      referrerAddress: 'a@b.test',
      patientName: 'Rosa Alvarez',
      declineReasons: ['Missing problems section', 'No payer identified'],
    });
    await convertAutoDeclined(exceptionId!, actor, 'wrong call');

    await settle();
    const meta = JSON.parse(
      events('workspace.auto_declined_converted')[0].metadata as string,
    ) as Record<string, unknown>;
    // The first implementation used a ternary that discarded these whenever they
    // parsed successfully, which would have lost them from the audit entirely.
    expect(meta.originalDeclineReasons).toEqual([
      'Missing problems section',
      'No payer identified',
    ]);
  });

  it('refuses an exception of the wrong type', async () => {
    const actor = insertUser();
    const id = await raiseException({ exceptionType: 'unmatched-ack', summary: 'x' });
    await expect(convertAutoDeclined(id, actor, 'note')).rejects.toThrow(WrongExceptionTypeError);
  });

  it('does not create a source_message_id that collides with the original', async () => {
    const actor = insertUser();
    const { exceptionId } = await recordAutoDeclined({
      sourceMessageId: '<declined@f>',
      referrerAddress: 'a@b.test',
      declineReasons: ['x'],
    });
    const { referralId } = await convertAutoDeclined(exceptionId!, actor, 'note');
    const row = sqlite()
      .prepare(`SELECT source_message_id s FROM referrals WHERE id = ?`)
      .get(referralId) as { s: string };
    expect(row.s).not.toBe('<declined@f>');
    expect(row.s).toContain('<declined@f>');
  });
});

// ── Duplicate patients ──────────────────────────────────────────────────────

describe('findPotentialDuplicatePatients', () => {
  it('matches on surname and date of birth, ignoring case', async () => {
    await makeWorkspace({ lastName: 'Alvarez', dob: '1962-03-04' });
    const ids = await findPotentialDuplicatePatients('ALVAREZ', '1962-03-04');
    expect(ids).toHaveLength(1);
  });

  it('does not match on surname alone or date of birth alone', async () => {
    await makeWorkspace({ lastName: 'Alvarez', dob: '1962-03-04' });
    expect(await findPotentialDuplicatePatients('Alvarez', '1970-01-01')).toEqual([]);
    expect(await findPotentialDuplicatePatients('Different', '1962-03-04')).toEqual([]);
  });

  it('excludes the patient being checked', async () => {
    await makeWorkspace({ lastName: 'Alvarez', dob: '1962-03-04' });
    const [id] = await findPotentialDuplicatePatients('Alvarez', '1962-03-04');
    expect(await findPotentialDuplicatePatients('Alvarez', '1962-03-04', id)).toEqual([]);
  });

  it('returns nothing for blank input rather than matching everything', async () => {
    await makeWorkspace({ lastName: 'Alvarez', dob: '1962-03-04' });
    expect(await findPotentialDuplicatePatients('', '1962-03-04')).toEqual([]);
    expect(await findPotentialDuplicatePatients('Alvarez', '  ')).toEqual([]);
  });
});

describe('flagDuplicatePatient', () => {
  /** FLAGS, never merges. Merging two people's records wrongly is worse. */
  it('records that no merge was performed', async () => {
    const { workspaceId } = await makeWorkspace();
    const id = await flagDuplicatePatient({
      newPatientId: 2,
      existingPatientIds: [1],
      patientName: 'Rosa Alvarez',
      patientDob: '1962-03-04',
      workspaceId,
    });

    const exc = await getException(id!);
    expect(exc?.exceptionType).toBe('duplicate-patient');
    expect(exc?.metadata?.mergePerformed).toBe(false);
    // The UI has to say so too, so the remediation carries it.
    expect(exc?.remediation).toContain('No records are merged');
    expect(exc?.summary).toContain('Rosa Alvarez');
  });

  it('resolves both ways without merging anything', async () => {
    const actor = insertUser();
    const { workspaceId } = await makeWorkspace({ workStatus: WorkStatus.IN_PROGRESS });
    const same = await flagDuplicatePatient({
      newPatientId: 2,
      existingPatientIds: [1],
      patientName: 'A B',
      patientDob: '1980-01-01',
      workspaceId,
    });
    const before = sqlite().prepare(`SELECT COUNT(*) n FROM patients`).get() as { n: number };

    await resolveException(same!, 'confirmed-same', actor, 'same person, two referrals');
    expect((await getException(same!))?.resolution).toBe('confirmed-same');
    // No patient row was touched — the decision is recorded, not applied.
    expect(sqlite().prepare(`SELECT COUNT(*) n FROM patients`).get()).toEqual(before);
    expect((await getWorkspace(workspaceId))?.workStatus).toBe(WorkStatus.IN_PROGRESS);
  });

  it('emits duplicate_patient_flagged', async () => {
    const { workspaceId } = await makeWorkspace();
    await flagDuplicatePatient({
      newPatientId: 2,
      existingPatientIds: [1, 3],
      patientName: 'A B',
      patientDob: '1980-01-01',
      workspaceId,
    });
    await settle();
    const emitted = events('workspace.duplicate_patient_flagged');
    expect(emitted).toHaveLength(1);
    const meta = JSON.parse(emitted[0].metadata as string) as Record<string, unknown>;
    expect(meta.existingPatientIds).toEqual([1, 3]);
  });
});
