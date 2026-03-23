/**
 * Unit tests for dispositionService.ts
 *
 * Uses an in-memory SQLite database so we exercise real Drizzle queries
 * without touching the filesystem. nodemailer is mocked to avoid real SMTP.
 */

jest.mock('nodemailer');
jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'specialist@specialist.direct' },
  },
}));

// Point db module at an in-memory SQLite instance for tests
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
import { accept, decline, ReferralNotFoundError } from '../../../src/modules/prd02/dispositionService';
import { InvalidStateTransitionError } from '../../../src/state/referralStateMachine';
import { eq } from 'drizzle-orm';

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test' });
(nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail: mockSendMail });

async function seedReferral(state = 'Acknowledged'): Promise<number> {
  const now = new Date();
  const [patient] = await db
    .insert(patients)
    .values({ firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1980-03-15' })
    .returning({ id: patients.id });

  const [referral] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      sourceMessageId: `<msg-${Date.now()}@hospital.direct>`,
      referrerAddress: 'referrer@hospital.direct',
      reasonForReferral: 'Cardiology evaluation',
      state,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: referrals.id });

  return referral.id;
}

describe('dispositionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: 'test' });
  });

  describe('accept()', () => {
    it('transitions referral state to Accepted', async () => {
      const id = await seedReferral('Acknowledged');
      await accept(id, 'dr-smith');

      const [updated] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(updated.state).toBe('Accepted');
    });

    it('records the clinician ID', async () => {
      const id = await seedReferral('Acknowledged');
      await accept(id, 'dr-jones');

      const [updated] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(updated.clinicianId).toBe('dr-jones');
    });

    it('sends an RRI via SMTP', async () => {
      const id = await seedReferral('Acknowledged');
      await accept(id, 'dr-smith');
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });

    it('sends RRI to the referrer address', async () => {
      const id = await seedReferral('Acknowledged');
      await accept(id, 'dr-smith');
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'referrer@hospital.direct' }),
      );
    });

    it('RRI message text contains AA (accepted code)', async () => {
      const id = await seedReferral('Acknowledged');
      await accept(id, 'dr-smith');
      const callArg = mockSendMail.mock.calls[0][0] as { text: string };
      expect(callArg.text).toContain('MSA|AA');
    });

    it('logs the outbound message to outbound_messages', async () => {
      const id = await seedReferral('Acknowledged');
      await accept(id, 'dr-smith');

      const messages = await db
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.referralId, id));
      expect(messages).toHaveLength(1);
      expect(messages[0].messageType).toBe('RRI');
      expect(messages[0].status).toBe('Pending');
    });
  });

  describe('decline()', () => {
    it('transitions referral state to Declined', async () => {
      const id = await seedReferral('Acknowledged');
      await decline(id, 'dr-smith', 'Out of Scope');

      const [updated] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(updated.state).toBe('Declined');
    });

    it('records the decline reason', async () => {
      const id = await seedReferral('Acknowledged');
      await decline(id, 'dr-smith', 'Capacity Unavailable');

      const [updated] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(updated.declineReason).toBe('Capacity Unavailable');
    });

    it('RRI message text contains AR (rejected code)', async () => {
      const id = await seedReferral('Acknowledged');
      await decline(id, 'dr-smith', 'Out of Scope');

      const callArg = mockSendMail.mock.calls[0][0] as { text: string };
      expect(callArg.text).toContain('MSA|AR');
    });

    it('RRI message text contains the decline reason', async () => {
      const id = await seedReferral('Acknowledged');
      await decline(id, 'dr-smith', 'Out of Scope');

      const callArg = mockSendMail.mock.calls[0][0] as { text: string };
      expect(callArg.text).toContain('Out of Scope');
    });

    it('logs the outbound message to outbound_messages', async () => {
      const id = await seedReferral('Acknowledged');
      await decline(id, 'dr-smith', 'Out of Scope');

      const messages = await db
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.referralId, id));
      expect(messages).toHaveLength(1);
      expect(messages[0].messageType).toBe('RRI');
    });
  });

  describe('error handling', () => {
    it('throws ReferralNotFoundError for a non-existent referral ID', async () => {
      await expect(accept(99999, 'dr-smith')).rejects.toThrow(ReferralNotFoundError);
    });

    it('throws InvalidStateTransitionError when accepting an already-Declined referral', async () => {
      const id = await seedReferral('Declined');
      await expect(accept(id, 'dr-smith')).rejects.toThrow(InvalidStateTransitionError);
    });

    it('throws InvalidStateTransitionError when declining an already-Accepted referral', async () => {
      const id = await seedReferral('Accepted');
      await expect(decline(id, 'dr-smith', 'reason')).rejects.toThrow(InvalidStateTransitionError);
    });
  });
});
