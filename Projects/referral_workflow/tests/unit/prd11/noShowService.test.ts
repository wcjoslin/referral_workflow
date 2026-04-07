/**
 * Unit tests for noShowService.ts
 *
 * Uses in-memory SQLite. nodemailer mocked.
 */

jest.mock('nodemailer');
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
      clinical_data TEXT,
      raw_ccda_xml TEXT,
      priority_flag INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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

import nodemailer from 'nodemailer';
import { db } from '../../../src/db';
import { patients, referrals, outboundMessages } from '../../../src/db/schema';
import { markNoShow, ReferralNotFoundError } from '../../../src/modules/prd11/noShowService';
import { InvalidStateTransitionError } from '../../../src/state/referralStateMachine';
import { eq } from 'drizzle-orm';

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test' });
(nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail: mockSendMail });

async function seedReferral(state = 'Scheduled'): Promise<number> {
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
      appointmentDate: '2026-04-10T10:00:00',
      appointmentLocation: 'Exam Room 2',
      scheduledProvider: 'Dr. Sarah Chen',
      state,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: referrals.id });

  return referral.id;
}

describe('noShowService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: 'test' });
  });

  describe('markNoShow()', () => {
    it('transitions referral state to No-Show', async () => {
      const id = await seedReferral('Scheduled');
      await markNoShow(id);

      const [updated] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(updated.state).toBe('No-Show');
    });

    it('sends a notification via SMTP', async () => {
      const id = await seedReferral('Scheduled');
      await markNoShow(id);
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });

    it('sends notification to the referrer address', async () => {
      const id = await seedReferral('Scheduled');
      await markNoShow(id);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'referrer@hospital.direct' }),
      );
    });

    it('notification contains patient name', async () => {
      const id = await seedReferral('Scheduled');
      await markNoShow(id);
      const callArg = mockSendMail.mock.calls[0][0] as { text: string };
      expect(callArg.text).toContain('Jane Doe');
    });

    it('notification contains specialist name', async () => {
      const id = await seedReferral('Scheduled');
      await markNoShow(id);
      const callArg = mockSendMail.mock.calls[0][0] as { text: string };
      expect(callArg.text).toContain('Dr. Sarah Chen');
    });

    it('logs a NoShowNotification outbound message', async () => {
      const id = await seedReferral('Scheduled');
      await markNoShow(id);

      const messages = await db
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.referralId, id));
      expect(messages).toHaveLength(1);
      expect(messages[0].messageType).toBe('NoShowNotification');
      expect(messages[0].status).toBe('Pending');
    });
  });

  describe('error handling', () => {
    it('throws ReferralNotFoundError for non-existent referral', async () => {
      await expect(markNoShow(99999)).rejects.toThrow(ReferralNotFoundError);
    });

    it('throws InvalidStateTransitionError when state is not Scheduled', async () => {
      const id = await seedReferral('Encounter');
      await expect(markNoShow(id)).rejects.toThrow(InvalidStateTransitionError);
    });

    it('throws InvalidStateTransitionError when state is Accepted', async () => {
      const id = await seedReferral('Accepted');
      await expect(markNoShow(id)).rejects.toThrow(InvalidStateTransitionError);
    });
  });
});
