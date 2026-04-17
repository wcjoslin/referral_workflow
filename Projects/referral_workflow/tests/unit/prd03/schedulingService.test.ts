/**
 * Unit tests for schedulingService.ts
 *
 * Uses an in-memory SQLite database. nodemailer is mocked to avoid real SMTP.
 */

jest.mock('nodemailer');
jest.mock('../../../src/modules/prd05/mockEncounter', () => ({
  onReferralScheduled: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../src/modules/prd06/mockReferrer', () => ({
  autoAck: jest.fn().mockResolvedValue(undefined),
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

import nodemailer from 'nodemailer';
import { db } from '../../../src/db';
import { patients, referrals, outboundMessages } from '../../../src/db/schema';
import {
  scheduleReferral,
  ReferralNotFoundError,
  SchedulingConflictError,
} from '../../../src/modules/prd03/schedulingService';
import { InvalidStateTransitionError } from '../../../src/state/referralStateMachine';
import { eq } from 'drizzle-orm';

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test' });
(nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail: mockSendMail });

const DETAILS = {
  appointmentDatetime: '2026-04-07T10:00:00',
  durationMinutes: 60,
  locationName: 'Exam Room 2',
  scheduledProvider: 'Dr. Sarah Chen',
};

async function seedReferral(state = 'Accepted'): Promise<number> {
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

describe('schedulingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: 'test' });
  });

  describe('scheduleReferral()', () => {
    it('transitions referral state to Scheduled', async () => {
      const id = await seedReferral('Accepted');
      await scheduleReferral(id, DETAILS);

      const [updated] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(updated.state).toBe('Scheduled');
    });

    it('records appointment details in the DB', async () => {
      const id = await seedReferral('Accepted');
      await scheduleReferral(id, DETAILS);

      const [updated] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(updated.appointmentDate).toBe('2026-04-07T10:00:00');
      expect(updated.appointmentLocation).toBe('Exam Room 2');
      expect(updated.scheduledProvider).toBe('Dr. Sarah Chen');
    });

    it('sends an SIU^S12 via SMTP', async () => {
      const id = await seedReferral('Accepted');
      await scheduleReferral(id, DETAILS);
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });

    it('SIU message contains SIU^S12 message type', async () => {
      const id = await seedReferral('Accepted');
      await scheduleReferral(id, DETAILS);
      const callArg = mockSendMail.mock.calls[0][0] as { text: string };
      expect(callArg.text).toContain('SIU^S12^SIU_S12');
    });

    it('SIU message contains patient name', async () => {
      const id = await seedReferral('Accepted');
      await scheduleReferral(id, DETAILS);
      const callArg = mockSendMail.mock.calls[0][0] as { text: string };
      expect(callArg.text).toContain('Doe^Jane');
    });

    it('sends to the referrer address', async () => {
      const id = await seedReferral('Accepted');
      await scheduleReferral(id, DETAILS);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'referrer@hospital.direct' }),
      );
    });

    it('logs the outbound SIU message', async () => {
      const id = await seedReferral('Accepted');
      await scheduleReferral(id, DETAILS);

      const messages = await db
        .select()
        .from(outboundMessages)
        .where(eq(outboundMessages.referralId, id));
      expect(messages).toHaveLength(1);
      expect(messages[0].messageType).toBe('SIU');
      expect(messages[0].status).toBe('Pending');
    });
  });

  describe('resource conflict detection', () => {
    it('throws SchedulingConflictError when resource is unavailable', async () => {
      const id = await seedReferral('Accepted');
      // echo-lab is blocked 2026-03-30 08:00–12:00
      await expect(
        scheduleReferral(id, {
          ...DETAILS,
          appointmentDatetime: '2026-03-30T09:00:00',
          resourceIds: ['echo-lab'],
        }),
      ).rejects.toThrow(SchedulingConflictError);
    });

    it('succeeds when requested resources are available', async () => {
      const id = await seedReferral('Accepted');
      // exam-room-2 has no blocked slots
      await scheduleReferral(id, {
        ...DETAILS,
        resourceIds: ['exam-room-2'],
      });

      const [updated] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(updated.state).toBe('Scheduled');
    });
  });

  describe('error handling', () => {
    it('throws ReferralNotFoundError for non-existent referral', async () => {
      await expect(scheduleReferral(99999, DETAILS)).rejects.toThrow(ReferralNotFoundError);
    });

    it('throws InvalidStateTransitionError for wrong state', async () => {
      const id = await seedReferral('Acknowledged');
      await expect(scheduleReferral(id, DETAILS)).rejects.toThrow(InvalidStateTransitionError);
    });

    it('does not update DB when conflict is detected', async () => {
      const id = await seedReferral('Accepted');
      try {
        await scheduleReferral(id, {
          ...DETAILS,
          appointmentDatetime: '2026-03-30T09:00:00',
          resourceIds: ['echo-lab'],
        });
      } catch {
        // expected
      }
      const [unchanged] = await db.select().from(referrals).where(eq(referrals.id, id));
      expect(unchanged.state).toBe('Accepted');
    });
  });
});
