/**
 * Unit tests for consultNoteService.ts
 *
 * Uses in-memory SQLite. nodemailer and geminiConsultNote mocked.
 */

jest.mock('nodemailer');
jest.mock('../../../src/modules/prd06/mockReferrer', () => ({
  autoAck: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../src/modules/prd04/geminiConsultNote', () => ({
  structureNote: jest.fn().mockResolvedValue({
    chiefComplaint: 'Chest pain',
    historyOfPresentIllness: 'Progressive symptoms over 3 months',
    assessment: 'Likely stable angina',
    plan: 'Cardiac catheterization',
    physicalExam: 'Regular rate and rhythm',
  }),
}));
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

import nodemailer from 'nodemailer';
import { db } from '../../../src/db';
import { patients, referrals, outboundMessages } from '../../../src/db/schema';
import {
  generateAndSend,
  ReferralNotFoundError,
} from '../../../src/modules/prd04/consultNoteService';
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
      state,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: referrals.id });

  return referral.id;
}

describe('consultNoteService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: 'test' });
  });

  describe('generateAndSend()', () => {
    it('transitions referral state to Closed', async () => {
      const id = await seedReferral('Encounter');
      await generateAndSend({ referralId: id, noteText: 'Sample clinical note' });

      const [updated] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(updated.state).toBe('Closed');
    });

    it('sends consult note via SMTP', async () => {
      const id = await seedReferral('Encounter');
      await generateAndSend({ referralId: id, noteText: 'Sample clinical note' });
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });

    it('sends to the referrer address', async () => {
      const id = await seedReferral('Encounter');
      await generateAndSend({ referralId: id, noteText: 'Sample clinical note' });
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'referrer@hospital.direct' }),
      );
    });

    it('includes C-CDA XML as attachment', async () => {
      const id = await seedReferral('Encounter');
      await generateAndSend({ referralId: id, noteText: 'Sample clinical note' });
      const callArg = mockSendMail.mock.calls[0][0] as { attachments: Array<{ filename: string; content: string; contentType: string }> };
      expect(callArg.attachments).toHaveLength(1);
      expect(callArg.attachments[0].filename).toMatch(/consult-note-\d+\.xml/);
      expect(callArg.attachments[0].content).toContain('ClinicalDocument');
      expect(callArg.attachments[0].contentType).toBe('application/xml');
    });

    it('logs the outbound ConsultNote message', async () => {
      const id = await seedReferral('Encounter');
      await generateAndSend({ referralId: id, noteText: 'Sample clinical note' });

      const messages = await db
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.referralId, id));
      expect(messages).toHaveLength(1);
      expect(messages[0].messageType).toBe('ConsultNote');
      expect(messages[0].status).toBe('Pending');
    });

    it('subject line includes patient name and referral ID', async () => {
      const id = await seedReferral('Encounter');
      await generateAndSend({ referralId: id, noteText: 'Sample clinical note' });
      const callArg = mockSendMail.mock.calls[0][0] as { subject: string };
      expect(callArg.subject).toContain('Doe');
      expect(callArg.subject).toContain('Jane');
      expect(callArg.subject).toContain(String(id));
    });
  });

  describe('error handling', () => {
    it('throws ReferralNotFoundError for non-existent referral', async () => {
      await expect(
        generateAndSend({ referralId: 99999, noteText: 'text' }),
      ).rejects.toThrow(ReferralNotFoundError);
    });

    it('throws InvalidStateTransitionError for wrong state', async () => {
      const id = await seedReferral('Accepted');
      await expect(
        generateAndSend({ referralId: id, noteText: 'text' }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });
  });
});
