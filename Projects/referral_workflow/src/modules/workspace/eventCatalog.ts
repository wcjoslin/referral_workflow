/**
 * PRD-25 — the event vocabulary, in one place.
 *
 * THIS NAMES WHAT IS ACTUALLY EMITTED, and nothing else. The draft of PRD-25
 * declared eleven event types nothing emitted, omitted four that are, and
 * misnamed a fifth — `workspace.document_added` where PRD-23 emits
 * `workspace.document_indexed`. A source of truth listing phantoms is worse
 * than no catalog: a reader checks it, believes it, and writes a feed that
 * silently matches nothing.
 *
 * So the rule for this file is: an entry goes in when a call site emits it, and
 * the test below the catalog proves the two agree. Future events
 * (`queue_changed`, `exception_raised`, `overdue`, …) belong to the PRDs that
 * will emit them, and they add their names here in the same change.
 *
 * THE ACTOR PREFIX FORMAT IS LOAD-BEARING. `analyticsQueries.ts` matches
 * `actor = 'payer:' + payer` exactly and parses `skill:<name>`. Adding a prefix
 * is safe; changing or reordering an existing one breaks a dashboard.
 */

/** Emitted by the pre-epic referral pipeline (PRD-01 … PRD-14). */
export const ReferralEvents = {
  RECEIVED: 'referral.received',
  ACKNOWLEDGED: 'referral.acknowledged',
  ROUTING_ASSESSED: 'referral.routing_assessed',
  AUTO_DECLINED: 'referral.auto_declined',
  PENDING_INFO: 'referral.pending_info',
  SCHEDULED: 'referral.scheduled',
  NO_SHOW: 'referral.no_show',
  ENCOUNTER_COMPLETE: 'referral.encounter_complete',
  CONSULT_REQUESTED: 'referral.consult_requested',
  CONSULT_RESOLVED: 'referral.consult_resolved',
  CLOSED: 'referral.closed',
  CLOSED_CONFIRMED: 'referral.closed_confirmed',

  // ── Added by PRD-25, closing the three audit gaps ───────────────────────
  /** `POST /api/referrals/:id/routing` emitted nothing at all before this. */
  ROUTING_CHANGED: 'referral.routing_changed',
  /** A coordinator reversing a disposition. Records whether it bypassed the machine. */
  DISPOSITION_OVERRIDDEN: 'referral.disposition_overridden',
  /** The pendingInfoChecker escalation, which wrote `state` directly before this. */
  PENDING_INFO_ESCALATED: 'referral.pending_info_escalated',
} as const;

/** Emitted by the messaging and analytics layers. */
export const MessageEvents = {
  SENT: 'message.sent',
  ACKNOWLEDGED: 'message.acknowledged',
} as const;

export const PriorAuthEvents = {
  SUBMITTED: 'prior_auth.submitted',
  EXPIRED: 'prior_auth.expired',
  ERROR: 'prior_auth.error',
} as const;

export const SkillEvents = {
  EVALUATED: 'skill.evaluated',
  ACTION_EXECUTED: 'skill.action_executed',
} as const;

/** Emitted by the collaboration workspace (PRD-18 … PRD-23, PRD-29, PRD-30). */
export const WorkspaceEvents = {
  CREATED: 'workspace.created',
  ARCHIVED: 'workspace.archived',
  ASSIGNED: 'workspace.assigned',
  RELEASED: 'workspace.released',
  WORK_STATUS_CHANGED: 'workspace.work_status_changed',
  WORK_STATUS_PROPOSAL_DECLINED: 'workspace.work_status_proposal_declined',
  WORK_STATUS_RESYNCED: 'workspace.work_status_resynced',

  PARTY_SEEDED: 'workspace.party_seeded',
  PARTY_UPDATED: 'workspace.party_updated',
  PARTY_ADDRESS_OBSERVED: 'workspace.party_address_observed',
  PROTOCOL_MODE_CHANGED: 'workspace.protocol_mode_changed',
  CAPABILITY_VERIFIED: 'workspace.capability_verified',
  PARTICIPANT_ADDED: 'workspace.participant_added',
  PARTICIPANT_REMOVED: 'workspace.participant_removed',

  COMMENT_ADDED: 'workspace.comment_added',
  COMMENT_EDITED: 'workspace.comment_edited',
  COMMENT_DELETED: 'workspace.comment_deleted',
  COMMENT_SHARED: 'workspace.comment_shared',
  COMMENT_DOWNGRADE_REFUSED: 'workspace.comment_downgrade_refused',
  COMMENT_MENTION: 'workspace.comment_mention',
  COMMENT_MENTION_ACKNOWLEDGED: 'workspace.comment_mention_acknowledged',

  DOCUMENT_INDEXED: 'workspace.document_indexed',
  DOCUMENT_UPLOADED: 'workspace.document_uploaded',
  DOCUMENT_VIEWED: 'workspace.document_viewed',
  DOCUMENT_DOWNLOADED: 'workspace.document_downloaded',
  DOCUMENT_ACCESS_DENIED: 'workspace.document_access_denied',

  GUEST_INVITED: 'workspace.guest_invited',
  GUEST_REISSUED: 'workspace.guest_reissued',
  GUEST_REVOKED: 'workspace.guest_revoked',
  GUEST_ACCEPTED: 'workspace.guest_accepted',
  GUEST_ACCESS_DENIED: 'workspace.guest_access_denied',

  ASSERTION_MADE: 'workspace.assertion_made',
  ARTIFACT_NOT_TRANSMITTED: 'workspace.artifact_not_transmitted',
} as const;

export const ALL_EVENT_TYPES: readonly string[] = [
  ...Object.values(ReferralEvents),
  ...Object.values(MessageEvents),
  ...Object.values(PriorAuthEvents),
  ...Object.values(SkillEvents),
  ...Object.values(WorkspaceEvents),
];

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Which filter tab an event belongs under.
 *
 * Derived from the event type rather than from the actor, because the two answer
 * different questions and only the first is stable. A work status change made by
 * a person and one derived from a protocol event are the same KIND of thing to
 * somebody scanning the feed; the actor column already says who.
 *
 * `delivery` and `access` are deliberately separate from each other and from
 * everything else: a HISP delivery receipt is not evidence that a person read
 * anything, and merging them into one "seen" indicator is the specific mistake
 * PRD-23 and this PRD both refuse to make.
 */
export type ActivityKind = 'system' | 'user' | 'guest' | 'status' | 'delivery' | 'access';

export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  'system',
  'user',
  'guest',
  'status',
  'delivery',
  'access',
];

/** Events that record a person opening content. Documents only — see below. */
const ACCESS_EVENTS: readonly string[] = [
  WorkspaceEvents.DOCUMENT_VIEWED,
  WorkspaceEvents.DOCUMENT_DOWNLOADED,
  WorkspaceEvents.DOCUMENT_ACCESS_DENIED,
];

/** Events that record an artifact reaching an address. */
const DELIVERY_EVENTS: readonly string[] = [
  MessageEvents.SENT,
  MessageEvents.ACKNOWLEDGED,
  WorkspaceEvents.ARTIFACT_NOT_TRANSMITTED,
];

/** Events that move the protocol or the work status. */
const STATUS_EVENTS: readonly string[] = [
  ReferralEvents.RECEIVED,
  ReferralEvents.ACKNOWLEDGED,
  ReferralEvents.AUTO_DECLINED,
  ReferralEvents.PENDING_INFO,
  ReferralEvents.PENDING_INFO_ESCALATED,
  ReferralEvents.SCHEDULED,
  ReferralEvents.NO_SHOW,
  ReferralEvents.ENCOUNTER_COMPLETE,
  ReferralEvents.CONSULT_REQUESTED,
  ReferralEvents.CONSULT_RESOLVED,
  ReferralEvents.CLOSED,
  ReferralEvents.CLOSED_CONFIRMED,
  ReferralEvents.DISPOSITION_OVERRIDDEN,
  WorkspaceEvents.WORK_STATUS_CHANGED,
  WorkspaceEvents.WORK_STATUS_PROPOSAL_DECLINED,
  WorkspaceEvents.WORK_STATUS_RESYNCED,
  WorkspaceEvents.ASSERTION_MADE,
];

/** Events a guest performed, whatever their actor string turns out to be. */
const GUEST_EVENTS: readonly string[] = [
  WorkspaceEvents.GUEST_ACCEPTED,
  WorkspaceEvents.GUEST_ACCESS_DENIED,
];

/**
 * Classifies one event.
 *
 * Order matters: access and delivery are checked first because they are the two
 * that must never be absorbed into a broader bucket. A guest opening a document
 * is `access`, not `guest` — the evidence it carries is the more important fact,
 * and the actor label still says a guest did it.
 */
export function kindOf(eventType: string, actor: string): ActivityKind {
  if (ACCESS_EVENTS.includes(eventType)) return 'access';
  if (DELIVERY_EVENTS.includes(eventType)) return 'delivery';
  if (STATUS_EVENTS.includes(eventType)) return 'status';
  if (GUEST_EVENTS.includes(eventType) || actor.startsWith('guest:')) return 'guest';
  if (actor.startsWith('user:')) return 'user';
  return 'system';
}

/** What an entry proves, kept in the data rather than only in the UI. */
export function evidenceOf(eventType: string): 'delivery' | 'access' | null {
  if (ACCESS_EVENTS.includes(eventType)) return 'access';
  // NOT_TRANSMITTED is a delivery FACT — that it did not happen. Recording it as
  // delivery evidence is what lets the feed say "never sent" rather than leaving
  // a reader to infer it from an absence.
  if (DELIVERY_EVENTS.includes(eventType)) return 'delivery';
  return null;
}

/**
 * The events a GUEST may see, as an allow-list.
 *
 * An allow-list, not a deny-list, for the reason PRD-30 established: naming what
 * may appear fails when somebody adds an internal event type, whereas naming
 * what may not only fails for the ones already thought of. Adding
 * `workspace.exception_raised` in PRD-28 must not quietly surface it to a
 * counterparty.
 *
 * Protocol milestones only. No assignment, no work status, no routing, no
 * comment or document event — a guest's own comments and documents are on their
 * page already, and telling them WHEN somebody internally opened a document is
 * internal operational detail.
 */
export const GUEST_VISIBLE_EVENTS: readonly string[] = [
  ReferralEvents.RECEIVED,
  ReferralEvents.ACKNOWLEDGED,
  ReferralEvents.SCHEDULED,
  ReferralEvents.NO_SHOW,
  ReferralEvents.ENCOUNTER_COMPLETE,
  ReferralEvents.CLOSED,
  ReferralEvents.CLOSED_CONFIRMED,
];
