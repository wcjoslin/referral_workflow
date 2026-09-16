import { check, index, sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

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
    queueId: integer('queue_id').references(() => queues.id),

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

// ── Parties & Participants (PRD-24) ─────────────────────────────────────────
//
// Two concepts that must stay structurally separate:
//
//   PARTIES are the ORGANIZATIONS on the referral. A party is never a row in
//   `users` and never a row in `workspace_participants`. That separation is the
//   concrete mechanism keeping "external organizations are not workspace users"
//   true even though PRD-30 will let them act.
//
//   PARTICIPANTS are internal staff beyond the owner.
//
// A party determines where artifacts go and which protocol mode applies. A
// participant determines who inside this organization sees and does what.
// Collapsing them is how a system ends up treating a counterparty as a user.
export const workspaceParties = sqliteTable(
  'workspace_parties',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id')
      .references(() => referralWorkspaces.id)
      .notNull(),

    // null => provisional, derived from the address domain and flagged unverified.
    orgName: text('org_name'),
    orgNameVerified: integer('org_name_verified', { mode: 'boolean' }).notNull().default(false),

    // The party's CANONICAL INTAKE address — what PRD-29 addresses artifacts to.
    // Every other address this party has been seen using lives in
    // `party_addresses`; this column is not the full picture, it is the one we
    // reply to. null => local-only, nothing can be transmitted.
    directAddress: text('direct_address'),

    partyRole: text('party_role').notNull(), // 'initiating' | 'receiving' | 'other'

    protocolMode: text('protocol_mode').notNull().default('local-only'),
    // null => auto-resolved rather than chosen by a person.
    protocolModeSetBy: text('protocol_mode_set_by'),
    protocolModeSetAt: integer('protocol_mode_set_at', { mode: 'timestamp' }),

    // Written by PRD-29 after an actual successful exchange, which is what
    // separates a verified capability from an assumed one.
    capabilityVerifiedAt: integer('capability_verified_at', { mode: 'timestamp' }),

    contactName: text('contact_name'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_parties_workspace').on(table.workspaceId, table.partyRole),
    // Lowercase EXPRESSION index — the first in this schema. Direct addresses
    // arrive with inconsistent casing but are stored as received so the audit
    // record keeps the original form, so the match has to be case-folded.
    addressIdx: index('idx_workspace_parties_address').on(sql`lower(${table.directAddress})`),
  }),
);

// Every Direct address ever observed for a party, beyond its canonical intake.
//
// WHY THIS TABLE EXISTS: an organization receives a domain or subdomain from its
// HISP and provisions addresses at whatever granularity it likes — an
// organizational intake address, departmental addresses, per-clinician
// addresses, commonly all at once. With one address per party, a follow-up
// message from a clinician's own address fails to match the party and lands as a
// correlation exception instead of on the right workspace.
//
// It self-populates from recordThreadMessage(), so it needs no admin UI: an
// organization that provisions a new departmental address simply shows up with
// it, and the next message from that address matches exactly rather than
// falling back to the domain.
export const partyAddresses = sqliteTable(
  'party_addresses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Denormalised from the party so uniqueness can be scoped per workspace.
    workspaceId: integer('workspace_id')
      .references(() => referralWorkspaces.id)
      .notNull(),
    partyId: integer('party_id')
      .references(() => workspaceParties.id)
      .notNull(),

    address: text('address').notNull(), // stored as received, matched case-folded
    // 'intake' | 'departmental' | 'individual' | null => unknown. Advisory only;
    // nothing branches on it, it is for the panel to label rows.
    addressKind: text('address_kind'),

    // The message that introduced this address. Null for a seeded intake address,
    // which arrived from the referral rather than from a message.
    firstSeenMessageId: integer('first_seen_message_id').references(() => referralMessages.id),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    partyIdx: index('idx_party_addresses_party').on(table.partyId),
    // Two parties on one workspace may never claim the same address. Enforced
    // here rather than on the party row, because this is the table that now
    // holds every address.
    uniqueIdx: uniqueIndex('idx_party_addresses_unique').on(
      table.workspaceId,
      sql`lower(${table.address})`,
    ),
  }),
);

export const workspaceParticipants = sqliteTable(
  'workspace_participants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id')
      .references(() => referralWorkspaces.id)
      .notNull(),
    userId: integer('user_id')
      .references(() => users.id)
      .notNull(),

    // 'Manager' | 'Collaborator' | 'Viewer'.
    //
    // STORED, NOT ENFORCED, by PRD-24. Nothing reads this to make an access
    // decision yet — PRD-20 and PRD-30 are what turn `Viewer` into a security
    // boundary. Do not assume it is one before then.
    role: text('role').notNull(),

    addedByUserId: integer('added_by_user_id').references(() => users.id),
    addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
    // Soft removal. A removed participant keeps everything they authored.
    removedAt: integer('removed_at', { mode: 'timestamp' }),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_participants_workspace').on(
      table.workspaceId,
      table.removedAt,
    ),
    userIdx: index('idx_workspace_participants_user').on(table.userId, table.removedAt),
    // `removed_at` is deliberately NOT part of the key: re-adding a removed
    // participant revives this row rather than inserting a second. Their
    // history lives in the participant_added / participant_removed events, so
    // the table holds current state and the audit log is the record.
    uniqueIdx: uniqueIndex('idx_workspace_participants_unique').on(table.workspaceId, table.userId),
  }),
);

// ── Guest Participation (PRD-30) ────────────────────────────────────────────
//
// An invitation grants access to ONE workspace, for ONE referral, for ONE
// patient, with an expiry. It is not an account. A guest cannot browse other
// workspaces, see a queue, see internal comments, or see another patient.
//
// A guest is deliberately NOT a row in `users`. Internal staff and external
// guests have different lifecycles, different scoping and different audit
// requirements, and merging them is how an external party ends up in an
// internal picker.
//
// TOKENS ARE STORED AS HASHES ONLY. The raw invitation token exists in exactly
// one place — the URL in the delivered email — and the raw session token exists
// in exactly one place, the guest's cookie. Neither is ever written to a row, a
// log line, an audit metadata blob or an error message.
export const workspaceInvitations = sqliteTable(
  'workspace_invitations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id')
      .references(() => referralWorkspaces.id)
      .notNull(),
    // The PARTY is the access scope: what a guest may see is decided by which
    // organization they represent. Deliberately no FK to party_addresses — see
    // PRD-30 v1.1. An address FK would add nothing to the access decision and
    // would imply verification PRD-24 may only have inferred from a domain.
    partyId: integer('party_id')
      .references(() => workspaceParties.id)
      .notNull(),

    // Where the invitation went. Need not be one of the party's observed
    // addresses — for a first invitation it usually is not.
    recipientEmail: text('recipient_email').notNull(),

    tokenHash: text('token_hash').notNull().unique(),
    invitedByUserId: integer('invited_by_user_id')
      .references(() => users.id)
      .notNull(),

    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    revokedByUserId: integer('revoked_by_user_id').references(() => users.id),
    // Set on the OLD row when re-issued, so the chain is auditable.
    supersededById: integer('superseded_by_id'),
    // False when SMTP failed. The invitation still exists and can be resent —
    // losing it because the mail bounced would be worse than showing it
    // undelivered.
    emailDelivered: integer('email_delivered', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_invitations_workspace').on(
      table.workspaceId,
      table.revokedAt,
    ),
    tokenIdx: index('idx_workspace_invitations_token').on(table.tokenHash),
  }),
);

export const workspaceGuests = sqliteTable(
  'workspace_guests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    invitationId: integer('invitation_id')
      .references(() => workspaceInvitations.id)
      .notNull(),
    // Denormalised from the invitation on purpose: the guard resolves a session
    // to a (workspaceId, partyId) pair, and reading that pair from one row
    // rather than joining is what keeps the guard a single short function with
    // no opportunity to widen scope by accident.
    workspaceId: integer('workspace_id')
      .references(() => referralWorkspaces.id)
      .notNull(),
    partyId: integer('party_id')
      .references(() => workspaceParties.id)
      .notNull(),

    displayName: text('display_name'), // self-supplied on acceptance, optional
    sessionTokenHash: text('session_token_hash'),
    sessionExpiresAt: integer('session_expires_at', { mode: 'timestamp' }),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_guests_workspace').on(table.workspaceId),
    sessionIdx: index('idx_workspace_guests_session').on(table.sessionTokenHash),
  }),
);

// ── Protocol Assertions (PRD-29) ────────────────────────────────────────────
//
// An ASSERTION is a protocol statement a participant makes from inside the
// workspace — "accept this referral", "here is the consult note". The gateway
// renders each into a conformant artifact using the EXISTING builders, guarded
// by referralStateMachine.transition(), and decides whether there is anywhere
// to send it.
//
// The point of the epic: a counterparty needs a Direct address, not a 360X
// implementation.
//
// ALWAYS RECORD, CONDITIONALLY TRANSMIT. The artifact is stored whether or not
// there is anywhere to send it, so the record is complete even for a party with
// no Direct address.
export const workspaceAssertions = sqliteTable(
  'workspace_assertions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id')
      .references(() => referralWorkspaces.id)
      .notNull(),

    // Client-supplied idempotency key. UNIQUE, which is what makes a
    // double-clicked button or a reconnecting guest emit one artifact and not
    // two — enforced by the database rather than by a check-then-insert.
    assertionKey: text('assertion_key').notNull().unique(),
    assertionType: text('assertion_type').notNull(),

    // The party this assertion was made ON BEHALF OF, resolved server-side.
    // Never taken from the request body: that is how a guest would assert as
    // the other side.
    assertedByPartyId: integer('asserted_by_party_id')
      .references(() => workspaceParties.id)
      .notNull(),
    assertedByActor: text('asserted_by_actor').notNull(), // 'user:<id>' | 'guest:<id>'

    context: text('context'), // JSON: appointment, LOINC, reason, note

    fromState: text('from_state'),
    toState: text('to_state'), // null => no protocol transition

    // The rendered artifact's row in `referral_messages`, where the bytes live.
    //
    // NOT a workspace_documents FK: PRD-23 is an INDEX over artifacts rather
    // than their store — its own context section says it deliberately does not
    // copy content — so the bytes belong here and PRD-23 later indexes this row
    // like any other artifact. Nothing about this waits on PRD-23.
    artifactMessageId: integer('artifact_message_id').references(() => referralMessages.id),

    deliveryMode: text('delivery_mode').notNull(), // 'transmitted' | 'local-only'
    // Resolved at SEND time from the party row, never baked in, so moving a
    // party from Mode A to Mode B is a configuration change and not a migration.
    transportMode: text('transport_mode').notNull(), // 'address-on-file' | 'delegated-mailbox'

    // The address actually used, recorded so the audit trail names where it
    // went, and how that address was identified (PRD-24's matchedOn): an
    // address resolved by domain alone is an inference, so routing falls back
    // to intake and this records which.
    sentToAddress: text('sent_to_address'),
    sentFromAddress: text('sent_from_address'),
    addressMatchedOn: text('address_matched_on'),

    deliveryStatus: text('delivery_status').notNull().default('Pending'),
    // 'Pending' | 'Delivered' | 'Failed' | 'Not-Transmitted'
    deliveryError: text('delivery_error'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_assertions_workspace').on(
      table.workspaceId,
      table.createdAt,
    ),
    keyIdx: index('idx_workspace_assertions_key').on(table.assertionKey),
  }),
);

// ── Shared Queues (PRD-20) ───────────────────────────────────────
//
// There was no queue entity before this. What looked like queues were view-level
// filters: /scheduler/queue selects referrals in Accepted or No-Show, the
// dashboard selects everything and filters by department in the BROWSER. No
// membership, no per-queue ordering, no access boundary.
//
// WHAT QUEUE SCOPING IS AND IS NOT. Every query is constrained by the acting
// user's membership before any user-supplied filter, server-side, so a client
// cannot widen its own scope by changing a query parameter. That is real and
// worth having.
//
// It is NOT authentication. `tryGetActingUser()` reads a cookie anybody can
// set, so somebody who wants to read another queue can claim to be a user who
// belongs to it. Making queue scoping an actual PHI boundary needs a real
// caller identity, which is deferred to PRD-31 by an explicit decision. Until
// then this is a least-privilege DEFAULT, not a control, and no comment in this
// file should imply otherwise.
export const queues = sqliteTable(
  'queues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    // Matches referrals.routing_department. Null on the default queue, which
    // takes everything that matches nothing.
    departmentFilter: text('department_filter'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({ slugIdx: index('idx_queues_slug').on(table.slug) }),
);

export const queueMembers = sqliteTable(
  'queue_members',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    queueId: integer('queue_id')
      .references(() => queues.id)
      .notNull(),
    userId: integer('user_id')
      .references(() => users.id)
      .notNull(),
    accessLevel: text('access_level').notNull().default('member'), // 'member' | 'manager'
    addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    queueIdx: index('idx_queue_members_queue').on(table.queueId),
    userIdx: index('idx_queue_members_user').on(table.userId),
    // One membership row per person per queue. Re-adding revives rather than
    // duplicating, the same shape PRD-24 used for participants.
    uniqueIdx: uniqueIndex('idx_queue_members_unique').on(table.queueId, table.userId),
  }),
);

export const savedFilters = sqliteTable(
  'saved_filters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .references(() => users.id)
      .notNull(),
    name: text('name').notNull(),
    surface: text('surface').notNull().default('queue'),
    filtersJson: text('filters_json').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    userIdx: index('idx_saved_filters_user').on(table.userId, table.surface),
    uniqueIdx: uniqueIndex('idx_saved_filters_name').on(table.userId, table.surface, table.name),
  }),
);

// ── Referral Conversation (PRD-22) ─────────────────────────────────
//
// One conversation per workspace, carrying two kinds of speech: internal notes
// that must never leave the organization, and messages meant for the other
// party. Split across two tables because a comment has two parts that behave
// differently:
//
//   IDENTITY (referral_comments) — who wrote it, where, when, and whether it has
//   been tombstoned. Never changes. What a PATCH targets, what a tombstone
//   marks, what a mention hangs off.
//
//   CONTENT (comment_revisions) — the body and the visibility at one point in
//   time. Append-only. An edit supersedes the current revision and inserts the
//   next, so "what did this say, and who could read it, on Tuesday" is
//   answerable.
//
// The first draft put both in one self-referencing table. That gives a comment
// no stable id: a tombstone, a mention and a PATCH would all target a row that
// changes on every edit.
//
// DELIBERATELY NOT AN EXTENSION OF referral_messages. That table is the
// protocol thread — machine-authored, tied to message control ids and ack
// status. PRD-25 may interleave the two for display; the storage stays separate.
export const referralComments = sqliteTable(
  'referral_comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id')
      .references(() => referralWorkspaces.id)
      .notNull(),

    // EXACTLY ONE AUTHOR, enforced by the check constraint below rather than by
    // the service alone. `(a IS NULL) <> (b IS NULL)` is XOR: it rejects both
    // set and neither set. Verified against SQLite before being relied on.
    authorUserId: integer('author_user_id').references(() => users.id),
    authorGuestId: integer('author_guest_id').references(() => workspaceGuests.id),
    // Denormalised from the guest row for the same reason workspace_guests
    // denormalises its own pair: attribution reads one row. NULL for an
    // internal author, who acts for the organization rather than for a party.
    authorPartyId: integer('author_party_id').references(() => workspaceParties.id),

    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),

    // Tombstone. Nothing here is ever hard-deleted — the row survives, and the
    // service stops handing out the body.
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
    deletedByActor: text('deleted_by_actor'),
  },
  (table) => ({
    workspaceIdx: index('idx_referral_comments_workspace').on(table.workspaceId, table.createdAt),
    authorUnion: check(
      'referral_comments_author_union',
      sql`(${table.authorUserId} IS NULL) <> (${table.authorGuestId} IS NULL)`,
    ),
  }),
);

// Content. One row per revision, never updated except to set superseded_at.
export const commentRevisions = sqliteTable(
  'comment_revisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    commentId: integer('comment_id')
      .references(() => referralComments.id)
      .notNull(),
    revisionNumber: integer('revision_number').notNull(), // 1-based
    body: text('body').notNull(),

    // Recorded PER REVISION and never mutated in place, so a later change
    // cannot disguise what was visible when.
    visibility: text('visibility').notNull().default('Internal'), // 'Internal' | 'Shared'

    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    createdByActor: text('created_by_actor').notNull(),
    supersededAt: integer('superseded_at', { mode: 'timestamp' }),
  },
  (table) => ({
    numberIdx: uniqueIndex('idx_comment_revisions_number').on(table.commentId, table.revisionNumber),
    // EXACTLY ONE CURRENT REVISION PER COMMENT, as a database invariant rather
    // than a service convention. A partial unique index: SQLite enforces
    // uniqueness only over rows matching the WHERE clause, so any number of
    // superseded revisions coexist and only one may be current. Two concurrent
    // edits therefore cannot both win — the second is refused, which beats
    // leaving two rows each claiming to be the live text.
    currentIdx: uniqueIndex('idx_comment_revisions_current')
      .on(table.commentId)
      .where(sql`${table.supersededAt} IS NULL`),
  }),
);

// Resolved mention targets, per revision, with acknowledgement.
//
// Stored relationally rather than as a JSON array because a mention needs an
// acknowledgement state: PRD-18 named the unacknowledged mention as one of two
// intended sources for hasOpenInternalItems(), and a JSON column cannot carry
// that fact.
export const commentMentions = sqliteTable(
  'comment_mentions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    commentId: integer('comment_id')
      .references(() => referralComments.id)
      .notNull(),
    // The revision that made this mention. An edit that drops a mention leaves
    // the old row attached to a superseded revision, which is how a retraction
    // is represented without deleting anything.
    revisionId: integer('revision_id')
      .references(() => commentRevisions.id)
      .notNull(),
    // Denormalised so hasOpenInternalItems(workspaceId) is one indexed query
    // rather than a join through comments — it is consulted on every protocol
    // transition via resolveProposedStatus().
    workspaceId: integer('workspace_id')
      .references(() => referralWorkspaces.id)
      .notNull(),

    // Exactly one target, the same XOR shape as the author. A user mention is
    // internal and can be an open item; a party mention is a routing hint for
    // PRD-27 and never is.
    mentionedUserId: integer('mentioned_user_id').references(() => users.id),
    mentionedPartyId: integer('mentioned_party_id').references(() => workspaceParties.id),

    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp' }),
    acknowledgedByActor: text('acknowledged_by_actor'),
  },
  (table) => ({
    workspaceIdx: index('idx_comment_mentions_workspace').on(
      table.workspaceId,
      table.acknowledgedAt,
    ),
    userIdx: index('idx_comment_mentions_user').on(table.mentionedUserId, table.acknowledgedAt),
    targetUnion: check(
      'comment_mentions_target_union',
      sql`(${table.mentionedUserId} IS NULL) <> (${table.mentionedPartyId} IS NULL)`,
    ),
  }),
);

// ── Referral Document Collection (PRD-23) ──────────────────────────
//
// AN INDEX, NOT A STORE. One row per document, pointing at wherever the bytes
// already live. A second copy of every C-CDA would be a synchronization problem
// and would double the PHI footprint for no benefit, so the only content this
// table's own storage holds is an upload — the one case with nowhere to point.
//
// SIX CONTENT SOURCES, because the bytes genuinely live in six places:
//
//   referral-message     referral_messages.content_xml ?? _hl7 ?? _body
//   referral-ccda        referrals.raw_ccda_xml — LEGACY FALLBACK ONLY, see below
//   attachment-response  attachment_responses.ccda_xml
//   prior-auth-request   prior_auth_requests.bundle_json ?? claim_json
//   prior-auth-response  prior_auth_responses.response_json
//   upload               a file at upload_path
//
// `referral-ccda` is not the primary path for the inbound C-CDA. The live ingest
// already writes it into the thread (referralService.ts) with the same bytes,
// and backfill-thread.ts did the same for history, so a referral-message row
// normally covers it. This source exists only for a referral whose raw_ccda_xml
// has no ReferralCCDA thread row — possible where the thread backfill was
// skipped because the table already had rows.
export const workspaceDocuments = sqliteTable(
  'workspace_documents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id')
      .references(() => referralWorkspaces.id)
      .notNull(),

    contentSource: text('content_source').notNull(),
    contentRef: integer('content_ref'), // null only for 'upload'
    uploadPath: text('upload_path'), // set only for 'upload'
    contentType: text('content_type').notNull(),
    // What the client CLAIMED, recorded only when it disagreed with the type
    // detected from the file's magic bytes. The detected type is what we serve;
    // this is kept so the disagreement is auditable rather than silently lost.
    claimedContentType: text('claimed_content_type'),

    docType: text('doc_type').notNull(),
    loincCode: text('loinc_code'),
    protocolRelationship: text('protocol_relationship'),
    source: text('source').notNull(),
    // 'inbound-dsm' | 'outbound-dsm' | 'generated' | 'uploaded'
    //   | 'payer-outbound' | 'payer-inbound'

    // SCOPE IS NOT VISIBILITY, and both gate a guest.
    //
    // attachment_responses has no path to a referral: the chain is
    // attachment_responses -> attachment_requests -> patients, and
    // attachment_requests links to PATIENTS. A claims attachment belongs to a
    // patient and was produced for a payer's claim, which may concern a
    // different episode of care entirely, so indexing it against a referral is
    // a patient-level association and a patient with three referrals sees it on
    // all three.
    //
    // Rather than hide that, it is recorded: 'patient' for claims attachments
    // alone, 'referral' for everything with a real link. A patient-scoped
    // document is withheld from a guest UNCONDITIONALLY, independent of
    // visibility — two gates, so a payer document about another episode cannot
    // reach a referring office because somebody toggled one flag.
    scope: text('scope').notNull().default('referral'), // 'referral' | 'patient'

    senderPartyId: integer('sender_party_id').references(() => workspaceParties.id),
    senderAddress: text('sender_address'),
    receivedAt: integer('received_at', { mode: 'timestamp' }).notNull(),

    // DERIVED FROM DIRECTION, not defaulted to Internal for everything: a
    // document that has already crossed the wire to a party is Shared, because
    // calling it internal is a fiction — they have it. "Inbound" and "outbound"
    // mean from or to a party ON THIS WORKSPACE; a payer is neither, so
    // prior-auth and claims traffic is Internal despite being outbound in the
    // everyday sense.
    visibility: text('visibility').notNull().default('Internal'), // 'Internal' | 'Shared'

    deliveryMode: text('delivery_mode'), // 'transmitted' | 'local-only' | null (inbound)
    immutable: integer('immutable', { mode: 'boolean' }).notNull().default(true),
    sha256: text('sha256'),
    // Metadata ONLY. Never a path component: storage uses a generated name, so a
    // filename containing traversal characters is inert.
    originalFilename: text('original_filename'),
    uploadedByUserId: integer('uploaded_by_user_id').references(() => users.id),
    uploadedByGuestId: integer('uploaded_by_guest_id').references(() => workspaceGuests.id),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_documents_workspace').on(
      table.workspaceId,
      table.receivedAt,
    ),
    // Idempotency as a DATABASE guarantee rather than a check-then-insert, the
    // same choice PRD-29 made for assertion_key. An upload has a null
    // contentRef and SQLite treats NULLs as distinct in a unique index, so every
    // upload is its own row — which is what we want, since uploading the same
    // file twice is a real thing a person may mean to do.
    sourceIdx: uniqueIndex('idx_workspace_documents_source').on(
      table.workspaceId,
      table.contentSource,
      table.contentRef,
    ),
  }),
);

// Who opened what, and when. Written BEFORE the bytes are streamed, so a failed
// stream still leaves evidence of the attempt.
//
// No check constraint on the viewer union, unlike PRD-22's author union: a
// 'denied' record may legitimately have neither viewer set, because a request
// with no resolvable identity is exactly the kind of attempt worth recording.
export const documentAccessLog = sqliteTable(
  'document_access_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentId: integer('document_id')
      .references(() => workspaceDocuments.id)
      .notNull(),
    viewerUserId: integer('viewer_user_id').references(() => users.id),
    viewerGuestId: integer('viewer_guest_id').references(() => workspaceGuests.id),
    action: text('action').notNull(), // 'view' | 'download' | 'denied'
    reason: text('reason'), // why, on a 'denied'
    viewedAt: integer('viewed_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    documentIdx: index('idx_document_access_document').on(table.documentId, table.viewedAt),
  }),
);

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
