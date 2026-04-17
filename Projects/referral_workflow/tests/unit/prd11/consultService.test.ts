/**
 * Unit tests for consultService.ts
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
      routing_department TEXT NOT NULL DEFAULT 'Unassigned',
      routing_equipment TEXT,
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

import nodemailer from 'nodemailer';
import { db } from '../../../src/db';
import { patients, referrals, outboundMessages } from '../../../src/db/schema';
import {
  markConsult,
  resolveConsult,
  ReferralNotFoundError,
} from '../../../src/modules/prd11/consultService';
import { InvalidStateTransitionError } from '../../../src/state/referralStateMachine';
import { eq } from 'drizzle-orm';

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test' });
(nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail: mockSendMail });

async function seedReferral(state = 'Encounter'): Promise<number> {
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
      scheduledProvider: 'Dr. Sarah Chen',
      state,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: referrals.id });

  return referral.id;
}

describe('consultService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: 'test' });
  });

  describe('markConsult()', () => {
    it('transitions referral state to Consult', async () => {
      const id = await seedReferral('Encounter');
      await markConsult(id);

      const [updated] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(updated.state).toBe('Consult');
    });

    it('sends a consultation request notification via SMTP', async () => {
      const id = await seedReferral('Encounter');
      await markConsult(id);
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });

    it('sends notification to the referrer address', async () => {
      const id = await seedReferral('Encounter');
      await markConsult(id);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'referrer@hospital.direct' }),
      );
    });

    it('notification contains patient name', async () => {
      const id = await seedReferral('Encounter');
      await markConsult(id);
      const callArg = mockSendMail.mock.calls[0][0] as { text: string };
      expect(callArg.text).toContain('Jane Doe');
    });

    it('logs a ConsultRequest outbound message', async () => {
      const id = await seedReferral('Encounter');
      await markConsult(id);

      const messages = await db
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.referralId, id));
      expect(messages).toHaveLength(1);
      expect(messages[0].messageType).toBe('ConsultRequest');
      expect(messages[0].status).toBe('Pending');
    });

    it('throws InvalidStateTransitionError when state is not Encounter', async () => {
      const id = await seedReferral('Scheduled');
      await expect(markConsult(id)).rejects.toThrow(InvalidStateTransitionError);
    });

    it('throws InvalidStateTransitionError when state is Closed', async () => {
      const id = await seedReferral('Closed');
      await expect(markConsult(id)).rejects.toThrow(InvalidStateTransitionError);
    });

    it('throws ReferralNotFoundError for non-existent referral', async () => {
      await expect(markConsult(99999)).rejects.toThrow(ReferralNotFoundError);
    });
  });

  describe('resolveConsult()', () => {
    it('transitions referral state to Closed', async () => {
      const id = await seedReferral('Consult');
      await resolveConsult(id, 'dr-smith');

      const [updated] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(updated.state).toBe('Closed');
    });

    it('records the clinician ID on the referral', async () => {
      const id = await seedReferral('Consult');
      await resolveConsult(id, 'dr-smith');

      const [updated] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(updated.clinicianId).toBe('dr-smith');
    });

    it('throws InvalidStateTransitionError when state is not Consult', async () => {
      const id = await seedReferral('Encounter');
      await expect(resolveConsult(id, 'dr-smith')).rejects.toThrow(InvalidStateTransitionError);
    });

    it('throws InvalidStateTransitionError when state is Scheduled', async () => {
      const id = await seedReferral('Scheduled');
      await expect(resolveConsult(id, 'dr-smith')).rejects.toThrow(InvalidStateTransitionError);
    });

    it('throws ReferralNotFoundError for non-existent referral', async () => {
      await expect(resolveConsult(99999, 'dr-smith')).rejects.toThrow(ReferralNotFoundError);
    });
  });
});
