/**
 * Unit tests for overdueChecker.ts
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
  `);

  return { db: drizzle(sqlite, { schema }) };
});

import { db } from '../../../src/db';
import { patients, referrals, outboundMessages } from '../../../src/db/schema';
import { getOverdueMessages, checkAndLogOverdue } from '../../../src/modules/prd07/overdueChecker';

async function seedMessage(opts: {
  messageType: string;
  status: string;
  sentAt: Date;
  acknowledgedAt?: Date;
}): Promise<number> {
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
      state: 'Closed',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: referrals.id });

  const [msg] = await db
    .insert(outboundMessages)
    .values({
      referralId: referral.id,
      messageControlId: `ctrl-${Date.now()}-${Math.random()}`,
      messageType: opts.messageType,
      status: opts.status,
      sentAt: opts.sentAt,
      acknowledgedAt: opts.acknowledgedAt ?? null,
    })
    .returning({ id: outboundMessages.id });

  return msg.id;
}

describe('overdueChecker', () => {
  describe('getOverdueMessages()', () => {
    it('returns messages pending beyond the threshold', async () => {
      const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
      await seedMessage({ messageType: 'RRI', status: 'Pending', sentAt: threeDaysAgo });

      const overdue = await getOverdueMessages();
      expect(overdue.length).toBeGreaterThanOrEqual(1);
      expect(overdue.some(m => m.messageType === 'RRI')).toBe(true);
    });

    it('does not return acknowledged messages', async () => {
      const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
      await seedMessage({
        messageType: 'SIU',
        status: 'Acknowledged',
        sentAt: threeDaysAgo,
        acknowledgedAt: new Date(),
      });

      const overdue = await getOverdueMessages();
      // Acknowledged messages should never appear in overdue results
      expect(overdue.every(m => m.messageType !== 'SIU')).toBe(true);
    });

    it('does not return recently sent pending messages', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const id = await seedMessage({ messageType: 'ConsultNote', status: 'Pending', sentAt: oneHourAgo });

      const overdue = await getOverdueMessages();
      expect(overdue.every(m => m.id !== id)).toBe(true);
    });

    it('respects custom threshold', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await seedMessage({ messageType: 'InterimUpdate', status: 'Pending', sentAt: twoHoursAgo });

      // With 1-hour threshold, the 2-hour-old message should be overdue
      const overdue = await getOverdueMessages(1 * 60 * 60 * 1000);
      expect(overdue.some(m => m.messageType === 'InterimUpdate')).toBe(true);
    });
  });

  describe('checkAndLogOverdue()', () => {
    it('returns the count of overdue messages', async () => {
      const threeDaysAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
      await seedMessage({ messageType: 'RRI', status: 'Pending', sentAt: threeDaysAgo });

      const count = await checkAndLogOverdue();
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });
});
