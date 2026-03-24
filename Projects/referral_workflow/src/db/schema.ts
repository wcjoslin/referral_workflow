import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const patients = sqliteTable('patients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  dateOfBirth: text('date_of_birth').notNull(), // ISO 8601: YYYY-MM-DD
});

export const referrals = sqliteTable('referrals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  patientId: integer('patient_id')
    .references(() => patients.id)
    .notNull(),
  sourceMessageId: text('source_message_id').notNull().unique(), // original email Message-ID
  referrerAddress: text('referrer_address').notNull(), // Direct address to reply to
  reasonForReferral: text('reason_for_referral'),
  state: text('state').notNull().default('Received'), // see ReferralState enum
  declineReason: text('decline_reason'),
  clinicianId: text('clinician_id'),
  appointmentDate: text('appointment_date'), // ISO 8601
  appointmentLocation: text('appointment_location'),
  scheduledProvider: text('scheduled_provider'), // clinician assigned to the appointment
  aiAssessment: text('ai_assessment'), // JSON-serialised SufficiencyAssessment, nullable until Gemini responds
  clinicalData: text('clinical_data'), // JSON-serialised extended CDA sections (problems, meds, allergies, results)
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const outboundMessages = sqliteTable('outbound_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  referralId: integer('referral_id')
    .references(() => referrals.id)
    .notNull(),
  messageControlId: text('message_control_id').notNull().unique(), // HL7 MSH-10
  messageType: text('message_type').notNull(), // 'RRI' | 'SIU' | 'ConsultNote'
  status: text('status').notNull().default('Pending'), // 'Pending' | 'Acknowledged'
  sentAt: integer('sent_at', { mode: 'timestamp' }).notNull(),
  acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp' }),
});
