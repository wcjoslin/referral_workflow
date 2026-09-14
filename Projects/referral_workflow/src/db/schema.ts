import { index, sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// ── Internal Staff Identity (PRD-17) ────────────────────────────────────────
//
// Real people only. Automation identities (SYSTEM-SKILL-<name>, SYSTEM-TIMEOUT)
// are NOT rows here — they stay the plain strings that skillActions.ts and
// pendingInfoChecker.ts already write. Guests (PRD-30) are a separate entity too.
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    displayName: text('display_name').notNull(),
    email: text('email').notNull().unique(),

    // This user's own Direct address within the organisation's domain. Nullable,
    // because an organisation provisions addresses at whatever granularity it
    // chooses — individual, departmental or organizational are all normal in
    // Direct — and most non-clinical staff have none. ADDITIVE to
    // config.receiving.directAddress (the organizational intake address), never a
    // replacement for it. Read by PRD-29 as the outbound sender/author identity
    // when senderIdentityMode is 'individual'; ignored when it is 'organization'.
    directAddress: text('direct_address'),

    // Descriptive only. No code path may branch on this to decide access — that
    // is allQueuesAccess. A `jobRole ===` comparison guarding data access is a bug.
    jobRole: text('job_role').notNull(), // 'coordinator' | 'clinician' | 'scheduler' | 'manager'

    // The historical referrals.clinician_id slug this person was recorded as,
    // e.g. 'dr-chen'. Lets this table and the existing demo data describe the same
    // people, and is what the analytics Clinician filter resolves its labels
    // through. Nullable: most staff have no historical slug.
    legacyClinicianId: text('legacy_clinician_id'),

    // Explicit grant of the PRD-20 see-all-queues scope. Never inferred from jobRole.
    allQueuesAccess: integer('all_queues_access', { mode: 'boolean' }).notNull().default(false),

    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    legacyIdx: index('idx_users_legacy_clinician').on(table.legacyClinicianId),
  }),
);

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
  aiAssessment: text('ai_assessment'), // JSON-serialised RoutingAssessment (immutable AI suggestion), nullable until Gemini responds
  routingDepartment: text('routing_department').notNull().default('Unassigned'), // effective department, editable by coordinator
  routingEquipment: text('routing_equipment'), // JSON array of resource IDs, editable by coordinator
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

// ── Workflow Analytics Event Log ─────────────────────────────────────────────

export const workflowEvents = sqliteTable(
  'workflow_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventType: text('event_type').notNull(), // e.g. 'referral.received', 'prior_auth.denied'
    entityType: text('entity_type').notNull(), // 'referral' | 'priorAuth'
    entityId: integer('entity_id').notNull(), // referral.id or priorAuthRequest.id
    fromState: text('from_state'), // nullable — not all events are state transitions
    toState: text('to_state'), // nullable
    actor: text('actor').notNull(), // 'system' | 'clinician:<id>' | 'skill:<name>' | 'payer:<name>'
    metadata: text('metadata'), // JSON blob for event-specific context
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    entityIdx: index('idx_workflow_events_entity').on(table.entityType, table.entityId),
    typeTimeIdx: index('idx_workflow_events_type_time').on(table.eventType, table.createdAt),
  }),
);

// ── Referral Workspace (PRD-18) ─────────────────────────────────────────────
//
// One row per referral, holding the INTERNAL collaboration state. Deliberately
// its own table rather than columns on `referrals`: the referral row is the
// protocol record, and keeping internal state separate is what makes the
// "never silently overwrite one with the other" rule enforceable in review.
export const referralWorkspaces = sqliteTable(
  'referral_workspaces',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    referralId: integer('referral_id')
      .references(() => referrals.id)
      .notNull()
      .unique(),

    // Correlation identifiers. Defined here, populated fully by PRD-28.
    externalReferralId: text('external_referral_id'), // the 360X id preserved across orgs
    correlationKey: text('correlation_key'), // sender+recipient+patient composite

    // Internal work state. NEVER mirrors referrals.state — see workStatusMachine.ts.
    workStatus: text('work_status').notNull().default('Triage'),

    // True once any actor has set the work status explicitly through
    // setWorkStatus(); false when the advisory protocol mapping last wrote it.
    // This single flag is what makes the mapping advisory: a proposal applies
    // only when it is false. resyncWorkStatus() clears it.
    workStatusIsManual: integer('work_status_is_manual', { mode: 'boolean' })
      .notNull()
      .default(false),

    // Plain audit detail — who and when. NOT load-bearing for the advisory rule.
    workStatusSetBy: text('work_status_set_by'),
    workStatusSetAt: integer('work_status_set_at', { mode: 'timestamp' }),

    // Ownership (PRD-21) and routing (PRD-20).
    ownerUserId: integer('owner_user_id').references(() => users.id),
    queueId: integer('queue_id'), // real FK added by PRD-20

    // Next action. Columns here; the values are computed by PRD-26.
    nextAction: text('next_action'),
    nextActionDueAt: integer('next_action_due_at', { mode: 'timestamp' }),

    // Exception condition. Status and column here; raised by PRD-28.
    exceptionReason: text('exception_reason'),

    archivedAt: integer('archived_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    referralIdx: index('idx_referral_workspaces_referral').on(table.referralId),
    ownerIdx: index('idx_referral_workspaces_owner').on(table.ownerUserId, table.workStatus),
    queueIdx: index('idx_referral_workspaces_queue').on(table.queueId, table.workStatus),
    dueIdx: index('idx_referral_workspaces_due').on(table.nextActionDueAt),
  }),
);

// ── Referral Message Thread ─────────────────────────────────────────────────

export const referralMessages = sqliteTable(
  'referral_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    referralId: integer('referral_id')
      .references(() => referrals.id)
      .notNull(),
    direction: text('direction').notNull(), // 'inbound' | 'outbound'
    messageType: text('message_type').notNull(), // ReferralCCDA, MDN, RRI, SIU, InterimUpdate, ConsultNote, ConsultRequest, NoShowNotification, InfoRequest, InfoReply, ACK
    subject: text('subject'),
    summary: text('summary').notNull(), // human-readable one-liner
    senderAddress: text('sender_address'),
    recipientAddress: text('recipient_address'),
    contentBody: text('content_body'), // plain-text email body
    contentHl7: text('content_hl7'), // raw HL7 message body
    contentXml: text('content_xml'), // C-CDA XML content
    messageControlId: text('message_control_id'), // HL7 MSH-10 for ACK correlation
    ackStatus: text('ack_status'), // 'Pending' | 'Acknowledged' | null (inbound)
    ackAt: integer('ack_at', { mode: 'timestamp' }),
    relatedStateTransition: text('related_state_transition'), // e.g. 'Acknowledged->Accepted'
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    referralIdx: index('idx_referral_messages_referral').on(table.referralId, table.createdAt),
    controlIdIdx: index('idx_referral_messages_control_id').on(table.messageControlId),
  }),
);

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
