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
  `);

  return { db: drizzle(sqlite, { schema }) };
});

import { db } from '../../../src/db';
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
    });
  });
});
