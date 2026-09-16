/**
 * Unit tests for ackService.ts
 *
 * Uses in-memory SQLite.
 */

jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'specialist@specialist.direct' },
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
      priority_flag INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE skill_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      referral_id INTEGER NOT NULL,
      trigger_point TEXT NOT NULL,
      matched INTEGER NOT NULL,
      confidence TEXT NOT NULL,
      action_taken TEXT,
      explanation TEXT NOT NULL,
      was_overridden INTEGER DEFAULT 0 NOT NULL,
      overridden_by TEXT,
      override_reason TEXT,
      executed_at INTEGER NOT NULL
    );
    CREATE TABLE outbound_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referral_id INTEGER NOT NULL,
      message_control_id TEXT NOT NULL UNIQUE,
      message_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      sent_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    );
    CREATE TABLE referral_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referral_id INTEGER NOT NULL,
      direction TEXT NOT NULL,
      message_type TEXT NOT NULL,
      subject TEXT,
      summary TEXT NOT NULL,
      sender_address TEXT,
      recipient_address TEXT,
      content_body TEXT,
      content_hl7 TEXT,
      content_xml TEXT,
      message_control_id TEXT,
      ack_status TEXT,
      ack_at INTEGER,
      related_state_transition TEXT,
      created_at INTEGER NOT NULL
    );

    -- PRD-28. Added so this suite exercises the exception path for real rather
    -- than relying on processAck()'s tolerance: without these tables the raise
    -- fails silently and the tests below would assert nothing about it.
    --
    -- referral_workspaces is here because the non-AA path looks up the
    -- workspace to attach the exception to.
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
      next_action_set_by TEXT,
      due_date_overridden INTEGER NOT NULL DEFAULT 0,
      due_date_override_reason TEXT,
      overdue_notified_at INTEGER,
      awaited_by TEXT,
      awaited_by_party_id INTEGER,
      exception_reason TEXT,
      archived_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE workspace_exceptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER,
      exception_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      remediation TEXT,
      raw_content TEXT,
      raw_content_type TEXT,
      sender_address TEXT,
      message_control_id TEXT,
      related_patient_name TEXT,
      metadata TEXT,
      prior_work_status TEXT,
      resolved_at INTEGER,
      resolved_by_actor TEXT,
      resolution TEXT,
      resolution_note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_workspace_exceptions_dedupe
      ON workspace_exceptions (exception_type, message_control_id)
      WHERE resolved_at IS NULL AND message_control_id IS NOT NULL;

    -- So the audit path is exercised rather than merely tolerated.
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

  (global as Record<string, unknown>).__ACK_SQLITE__ = sqlite;

  return { db: drizzle(sqlite, { schema }) };
});

import { db } from '../../../src/db';

/** Raw handle, for asserting on the PRD-28 tables this suite added. */
function sqliteHandle(): import('better-sqlite3').Database {
  return (global as Record<string, unknown>).__ACK_SQLITE__ as import('better-sqlite3').Database;
}
import { patients, referrals, outboundMessages } from '../../../src/db/schema';
import { processAck } from '../../../src/modules/prd06/ackService';
import { eq } from 'drizzle-orm';

async function seedReferralWithMessage(
  state: string,
  messageType: string,
  messageControlId: string,
): Promise<{ referralId: number; messageId: number }> {
  const now = new Date();
  const [patient] = await db
    .insert(patients)
    .values({ firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1980-03-15' })
    .returning({ id: patients.id });

  const [referral] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      sourceMessageId: `<msg-${Date.now()}-${Math.random()}@hospital.direct>`,
      referrerAddress: 'referrer@hospital.direct',
      reasonForReferral: 'Cardiology evaluation',
      state,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: referrals.id });

  const [message] = await db
    .insert(outboundMessages)
    .values({
      referralId: referral.id,
      messageControlId,
      messageType,
      status: 'Pending',
      sentAt: now,
    })
    .returning({ id: outboundMessages.id });

  return { referralId: referral.id, messageId: message.id };
}

describe('ackService', () => {
  describe('processAck()', () => {
    it('matches ACK to outbound message and updates status', async () => {
      const controlId = `ctrl-${Date.now()}`;
      const { messageId } = await seedReferralWithMessage('Closed', 'ConsultNote', controlId);

      const result = await processAck({
        ackCode: 'AA',
        acknowledgedControlId: controlId,
        messageControlId: 'ack-1',
      });

      expect(result.matched).toBe(true);
      expect(result.messageType).toBe('ConsultNote');

      const [updated] = await db
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.id, messageId));
      expect(updated.status).toBe('Acknowledged');
      expect(updated.acknowledgedAt).not.toBeNull();
    });

    it('transitions Closed → Closed-Confirmed on ConsultNote ACK', async () => {
      const controlId = `ctrl-cn-${Date.now()}`;
      const { referralId } = await seedReferralWithMessage('Closed', 'ConsultNote', controlId);

      const result = await processAck({
        ackCode: 'AA',
        acknowledgedControlId: controlId,
        messageControlId: 'ack-2',
      });

      expect(result.stateTransitioned).toBe(true);

      const [ref] = await db.select().from(referrals).where(eq(referrals.id, referralId));
      expect(ref.state).toBe('Closed-Confirmed');
    });

    it('does not transition state for RRI ACK', async () => {
      const controlId = `ctrl-rri-${Date.now()}`;
      const { referralId } = await seedReferralWithMessage('Accepted', 'RRI', controlId);

      const result = await processAck({
        ackCode: 'AA',
        acknowledgedControlId: controlId,
        messageControlId: 'ack-3',
      });

      expect(result.matched).toBe(true);
      expect(result.stateTransitioned).toBeFalsy();

      const [ref] = await db.select().from(referrals).where(eq(referrals.id, referralId));
      expect(ref.state).toBe('Accepted');
    });

    it('does not transition state for SIU ACK', async () => {
      const controlId = `ctrl-siu-${Date.now()}`;
      const { referralId } = await seedReferralWithMessage('Scheduled', 'SIU', controlId);

      await processAck({
        ackCode: 'AA',
        acknowledgedControlId: controlId,
        messageControlId: 'ack-4',
      });

      const [ref] = await db.select().from(referrals).where(eq(referrals.id, referralId));
      expect(ref.state).toBe('Scheduled');
    });

    it('returns matched:false for unmatched control ID', async () => {
      const result = await processAck({
        ackCode: 'AA',
        acknowledgedControlId: 'nonexistent-control-id',
        messageControlId: 'ack-5',
      });

      expect(result.matched).toBe(false);
    });

    it('does not update status for non-positive ACK (AR)', async () => {
      const controlId = `ctrl-ar-${Date.now()}`;
      const { messageId } = await seedReferralWithMessage('Closed', 'ConsultNote', controlId);

      const result = await processAck({
        ackCode: 'AR',
        acknowledgedControlId: controlId,
        messageControlId: 'ack-6',
      });

      expect(result.matched).toBe(true);

      const [msg] = await db
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.id, messageId));
      expect(msg.status).toBe('Pending');

      /**
       * PRD-28 AC7. The status is STILL not updated — an AR genuinely is not an
       * acknowledgement — but it is no longer silent. A rejection from the
       * counterparty is one of the most important things that can happen to a
       * referral, and before this it was a console.warn.
       */
      expect(result.exceptionId).toEqual(expect.any(Number));
      const [exc] = sqliteHandle()
        .prepare(`SELECT * FROM workspace_exceptions WHERE id = ?`)
        .all(result.exceptionId) as Array<Record<string, unknown>>;
      expect(exc.exception_type).toBe('ack-error-code');
      expect(String(exc.summary)).toContain('AR');
      expect(String(exc.summary)).toContain('ConsultNote');
      expect(exc.message_control_id).toBe(controlId);
      // The remediation has to tell a human what to DO (AC10).
      expect(String(exc.remediation)).toMatch(/REJECTED/);
    });

    /**
     * PRD-28 AC6, the path that used to lose data outright: the ACK was logged
     * and DROPPED, so an acknowledgement arriving with a mangled control id
     * simply never happened.
     */
    it('raises an exception retaining the raw message for an unmatched ACK', async () => {
      const raw = 'MSH|^~\\&|SENDER|FAC|RECV|FAC|20260916||ACK^A01|ack-7|P|2.5.1\rMSA|AA|nope-9999\r';
      const result = await processAck(
        { ackCode: 'AA', acknowledgedControlId: 'nope-9999', messageControlId: 'ack-7' },
        { raw, senderAddress: 'referrals@northside.direct.example.org' },
      );

      // `matched` keeps its old meaning — the ACK is still unmatched.
      expect(result.matched).toBe(false);
      expect(result.exceptionId).toEqual(expect.any(Number));

      const [exc] = sqliteHandle()
        .prepare(`SELECT * FROM workspace_exceptions WHERE id = ?`)
        .all(result.exceptionId) as Array<Record<string, unknown>>;
      expect(exc.exception_type).toBe('unmatched-ack');
      expect(exc.workspace_id).toBeNull(); // an orphan — there is no workspace
      expect(exc.message_control_id).toBe('nope-9999');
      expect(exc.sender_address).toBe('referrals@northside.direct.example.org');
      // The retained artifact is the whole point: this row is the only copy.
      expect(exc.raw_content).toBe(raw);
      expect(exc.raw_content_type).toBe('application/hl7-v2');
    });

    /** The partial dedupe index: one OPEN exception per (type, control id). */
    it('does not raise a second open exception for the same unmatched control id', async () => {
      const first = await processAck({
        ackCode: 'AA',
        acknowledgedControlId: 'dupe-1',
        messageControlId: 'ack-8',
      });
      expect(first.exceptionId).toEqual(expect.any(Number));

      // The retry inside raiseExceptionSafely() also hits the unique index, so
      // this returns null rather than a second row.
      const second = await processAck({
        ackCode: 'AA',
        acknowledgedControlId: 'dupe-1',
        messageControlId: 'ack-9',
      });
      expect(second.matched).toBe(false);

      const rows = sqliteHandle()
        .prepare(
          `SELECT COUNT(*) n FROM workspace_exceptions
           WHERE exception_type = 'unmatched-ack' AND message_control_id = 'dupe-1'`,
        )
        .get() as { n: number };
      expect(rows.n).toBe(1);
    });
  });
});
