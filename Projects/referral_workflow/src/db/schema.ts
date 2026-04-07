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
  rawCcdaXml: text('raw_ccda_xml'), // original inbound C-CDA XML, nullable for seeded demo data
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  priorityFlag: integer('priority_flag', { mode: 'boolean' }).default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const skillExecutions = sqliteTable('skill_executions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  skillName: text('skill_name').notNull(),
  referralId: integer('referral_id')
    .references(() => referrals.id)
    .notNull(),
  triggerPoint: text('trigger_point').notNull(), // 'post-intake' | 'post-acceptance' | 'encounter-complete'
  matched: integer('matched', { mode: 'boolean' }).notNull(),
  confidence: text('confidence').notNull(), // stored as text, parsed to float
  actionTaken: text('action_taken'), // null if no match, test mode, or below threshold
  explanation: text('explanation').notNull(),
  wasOverridden: integer('was_overridden', { mode: 'boolean' }).notNull().default(false),
  overriddenBy: text('overridden_by'),
  overrideReason: text('override_reason'),
  executedAt: integer('executed_at', { mode: 'timestamp' }).notNull(),
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

// ── Claims Attachment Workflow (X12N 277/275) ─────────────────────────────────

export const attachmentRequests = sqliteTable('attachment_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  patientId: integer('patient_id').references(() => patients.id), // nullable until FHIR patient matched
  controlNumber: text('control_number').notNull().unique(), // ISA13 interchange control number from 277
  claimNumber: text('claim_number'), // claim reference from 277
  payerName: text('payer_name').notNull(),
  payerIdentifier: text('payer_identifier').notNull(), // payer ID from NM1 loop
  subscriberName: text('subscriber_name').notNull(), // patient name as provided by payer
  subscriberId: text('subscriber_id'), // member/subscriber ID
  subscriberDob: text('subscriber_dob'), // ISO 8601, used for FHIR patient match
  requestedLoincCodes: text('requested_loinc_codes').notNull(), // JSON array of LOINC strings
  sourceFile: text('source_file').notNull(), // original .edi filename
  state: text('state').notNull().default('Received'), // see ClaimsAttachmentState
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const attachmentResponses = sqliteTable('attachment_responses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  requestId: integer('request_id')
    .references(() => attachmentRequests.id)
    .notNull(),
  loincCode: text('loinc_code').notNull(), // one response per LOINC code requested
  ccdaDocumentType: text('ccda_document_type').notNull(), // human label, e.g. "History and Physical"
  ccdaXml: text('ccda_xml'), // generated C-CDA document (null until built)
  fhirData: text('fhir_data'), // JSON — FHIR query results used to build the C-CDA
  signedByName: text('signed_by_name'),
  signedByNpi: text('signed_by_npi'),
  signedAt: integer('signed_at', { mode: 'timestamp' }),
  sentAt: integer('sent_at', { mode: 'timestamp' }),
  x12ControlNumber: text('x12_control_number'), // 275 ISA control number assigned at send time
});

// ── Prior Authorization (Da Vinci PAS) ──────────────────────────────────────

export const priorAuthRequests = sqliteTable('prior_auth_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  referralId: integer('referral_id').references(() => referrals.id),
  patientId: integer('patient_id')
    .references(() => patients.id)
    .notNull(),
  state: text('state').notNull().default('Draft'), // see PriorAuthState
  claimJson: text('claim_json').notNull(), // serialized FHIR Claim resource
  bundleJson: text('bundle_json'), // full PAS Bundle sent to payer
  insurerName: text('insurer_name').notNull(),
  insurerId: text('insurer_id').notNull(),
  serviceCode: text('service_code').notNull(), // CPT/HCPCS code
  serviceDisplay: text('service_display'), // human-readable service name
  providerNpi: text('provider_npi').notNull(),
  providerName: text('provider_name').notNull(),
  subscriberId: text('subscriber_id'), // member/insurance ID
  subscriptionId: text('subscription_id'), // payer-assigned subscription ID for rest-hook
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  submittedAt: integer('submitted_at', { mode: 'timestamp' }),
});

export const priorAuthResponses = sqliteTable('prior_auth_responses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  requestId: integer('request_id')
    .references(() => priorAuthRequests.id)
    .notNull(),
  responseJson: text('response_json').notNull(), // full FHIR ClaimResponse
  outcome: text('outcome').notNull(), // 'approved' | 'denied' | 'pended'
  reviewAction: text('review_action'), // PAS reviewAction code
  authNumber: text('auth_number'), // payer-assigned auth reference number
  denialReason: text('denial_reason'), // human-readable reason if denied
  itemAdjudications: text('item_adjudications'), // JSON array of item-level decisions
  receivedVia: text('received_via').notNull(), // 'sync' | 'subscription' | 'inquire'
  receivedAt: integer('received_at', { mode: 'timestamp' }).notNull(),
});
