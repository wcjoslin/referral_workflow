/**
 * The schema the workspace unit tests run against, as DDL.
 *
 * WHY THIS IS HAND-WRITTEN AND NOT `migrate()`. The tests mock `src/db` with an
 * in-memory SQLite handle created inside a `jest.mock` factory, which is hoisted
 * above the imports — so it cannot await a migration run. Hand-written DDL is
 * the price of that isolation.
 *
 * WHY IT IS SHARED. It was previously pasted into each test file, and PRD-24
 * showed the cost: adding three tables meant editing three identical copies, and
 * a fourth and fifth were about to be written. Copies also drift — the point of
 * these tests is to catch schema mistakes, which they cannot do if each file
 * describes a different schema.
 *
 * KEEP IN SYNC with `src/db/schema.ts` when you add a column the workspace
 * modules read. A missing column surfaces as `no such column`, not as a subtle
 * wrong answer, so the failure mode is at least loud.
 *
 * The PRD-22 tables carry two CHECK constraints and a PARTIAL unique index, and
 * they are reproduced here deliberately: they are the enforcement, not
 * decoration, so a test suite running against DDL without them would pass while
 * the real schema rejected the same write. `idx_comment_revisions_current` is
 * what makes "exactly one current revision per comment" a database invariant.
 *
 * `tests/unit/workspace/identityService.test.ts` and
 * `tests/unit/analytics/analyticsQueries.test.ts` still carry their own copies.
 * Neither needed the PRD-24 tables, so neither was touched; both are candidates
 * for this helper next time one of them has to change.
 */

export const TEST_SCHEMA_DDL = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    direct_address TEXT,
    job_role TEXT NOT NULL,
    legacy_clinician_id TEXT,
    all_queues_access INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
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
    created_at INTEGER NOT NULL,
    priority_flag INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE referral_workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referral_id INTEGER NOT NULL UNIQUE,
    external_referral_id TEXT,
    correlation_key TEXT,
    work_status TEXT NOT NULL DEFAULT 'Triage',
    work_status_is_manual INTEGER NOT NULL DEFAULT 0,
    work_status_set_by TEXT,
    work_status_set_at INTEGER,
    owner_user_id INTEGER,
    queue_id INTEGER,
    next_action TEXT,
    next_action_due_at INTEGER,
    exception_reason TEXT,
    archived_at INTEGER,
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
  CREATE TABLE prior_auth_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referral_id INTEGER,
    patient_id INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'Draft',
    claim_json TEXT NOT NULL,
    bundle_json TEXT,
    insurer_name TEXT NOT NULL,
    insurer_id TEXT NOT NULL,
    service_code TEXT NOT NULL,
    service_display TEXT,
    provider_npi TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    subscriber_id TEXT,
    subscription_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    submitted_at INTEGER
  );
  CREATE TABLE workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    from_state TEXT,
    to_state TEXT,
    actor TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL
  );


  -- ── Parties & Participants (PRD-24) ───────────────────────────────────────
  -- The unique indexes are part of what these tests assert, so they are
  -- created here too: idx_party_addresses_unique is the case-folded expression
  -- index that stops two parties claiming one address, and
  -- idx_workspace_participants_unique is what makes re-adding a removed
  -- participant revive their row rather than insert a second.
  CREATE TABLE workspace_parties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    org_name TEXT,
    org_name_verified INTEGER NOT NULL DEFAULT 0,
    direct_address TEXT,
    party_role TEXT NOT NULL,
    protocol_mode TEXT NOT NULL DEFAULT 'local-only',
    protocol_mode_set_by TEXT,
    protocol_mode_set_at INTEGER,
    capability_verified_at INTEGER,
    contact_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_workspace_parties_address ON workspace_parties (lower("direct_address"));
  CREATE TABLE party_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    party_id INTEGER NOT NULL,
    address TEXT NOT NULL,
    address_kind TEXT,
    first_seen_message_id INTEGER,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_party_addresses_unique ON party_addresses (workspace_id, lower("address"));
  CREATE TABLE workspace_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    added_by_user_id INTEGER,
    added_at INTEGER NOT NULL,
    removed_at INTEGER
  );
  CREATE UNIQUE INDEX idx_workspace_participants_unique ON workspace_participants (workspace_id, user_id);
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

  -- ── Guest participation (PRD-30) ──────────────────────────────────────────
  -- token_hash is UNIQUE here as in the real schema: two invitations cannot
  -- collide on a hash, and a test that inserted a duplicate would be testing
  -- something the database forbids.
  CREATE TABLE workspace_invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    party_id INTEGER NOT NULL,
    recipient_email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    invited_by_user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    accepted_at INTEGER,
    revoked_at INTEGER,
    revoked_by_user_id INTEGER,
    superseded_by_id INTEGER,
    email_delivered INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE workspace_guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invitation_id INTEGER NOT NULL,
    workspace_id INTEGER NOT NULL,
    party_id INTEGER NOT NULL,
    display_name TEXT,
    session_token_hash TEXT,
    session_expires_at INTEGER,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL
  );

  -- ── Protocol assertions (PRD-29) ──────────────────────────────────────────
  -- assertion_key is UNIQUE here as in the real schema: that index IS the
  -- idempotency guarantee, so a test that dropped it would be testing a
  -- weaker system than the one that ships.
  CREATE TABLE workspace_assertions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    assertion_key TEXT NOT NULL UNIQUE,
    assertion_type TEXT NOT NULL,
    asserted_by_party_id INTEGER NOT NULL,
    asserted_by_actor TEXT NOT NULL,
    context TEXT,
    from_state TEXT,
    to_state TEXT,
    artifact_message_id INTEGER,
    delivery_mode TEXT NOT NULL,
    transport_mode TEXT NOT NULL,
    sent_to_address TEXT,
    sent_from_address TEXT,
    address_matched_on TEXT,
    delivery_status TEXT NOT NULL DEFAULT 'Pending',
    delivery_error TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE TABLE referral_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    author_user_id INTEGER,
    author_guest_id INTEGER,
    author_party_id INTEGER,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    deleted_by_actor TEXT,
    CONSTRAINT referral_comments_author_union
      CHECK ((author_user_id IS NULL) <> (author_guest_id IS NULL))
  );
  CREATE INDEX idx_referral_comments_workspace ON referral_comments (workspace_id, created_at);
  CREATE TABLE comment_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    revision_number INTEGER NOT NULL,
    body TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'Internal',
    created_at INTEGER NOT NULL,
    created_by_actor TEXT NOT NULL,
    superseded_at INTEGER
  );
  CREATE UNIQUE INDEX idx_comment_revisions_number
    ON comment_revisions (comment_id, revision_number);
  CREATE UNIQUE INDEX idx_comment_revisions_current
    ON comment_revisions (comment_id) WHERE superseded_at IS NULL;
  CREATE TABLE comment_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    revision_id INTEGER NOT NULL,
    workspace_id INTEGER NOT NULL,
    mentioned_user_id INTEGER,
    mentioned_party_id INTEGER,
    created_at INTEGER NOT NULL,
    acknowledged_at INTEGER,
    acknowledged_by_actor TEXT,
    CONSTRAINT comment_mentions_target_union
      CHECK ((mentioned_user_id IS NULL) <> (mentioned_party_id IS NULL))
  );
  CREATE INDEX idx_comment_mentions_workspace
    ON comment_mentions (workspace_id, acknowledged_at);
  CREATE INDEX idx_comment_mentions_user
    ON comment_mentions (mentioned_user_id, acknowledged_at);
`
