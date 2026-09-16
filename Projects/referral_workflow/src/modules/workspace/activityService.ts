/**
 * PRD-25 — the first per-referral reader of the event log.
 *
 * `workflow_events` has existed since PRD-14 with an index on
 * `(entity_type, entity_id)` that nothing has ever used: the only consumer
 * aggregates across the whole log for dashboards. This module reads it for ONE
 * referral, which is what turns an analytics substrate into a workspace feature.
 *
 * THE MERGE HAPPENS ON READ, not by duplicating content into the log. A comment
 * event records that a comment was written and points at it; the feed joins to
 * get the body. Copying comment text into `metadata` would make the log a second
 * source of truth for it, and the two would drift the first time somebody edited
 * a comment.
 *
 * DELIVERY AND ACCESS ARE NEVER MERGED. A HISP receipt proves an artifact
 * reached an address. A document view proves a person opened it. Collapsing them
 * into one "seen" indicator is the specific error this PRD exists to avoid, so
 * `evidence` is a field on every entry rather than a rendering decision.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import {
  referralComments,
  referralWorkspaces,
  users,
  workflowEvents,
  workspaceDocuments,
  workspaceGuests,
  workspaceParties,
} from '../../db/schema';
import {
  ACTIVITY_KINDS,
  ActivityKind,
  GUEST_VISIBLE_EVENTS,
  evidenceOf,
  kindOf,
} from './eventCatalog';
import { GuestContext } from './guestAccess';

export class ActivityWorkspaceNotFoundError extends Error {
  constructor(workspaceId: number) {
    super(`No workspace with id ${workspaceId}`);
    this.name = 'ActivityWorkspaceNotFoundError';
  }
}

export interface ActivityArtifact {
  kind: 'document' | 'comment' | 'assertion' | 'message';
  id: number;
  label: string;
}

export interface ActivityEntry {
  /** `workflow_events:412` — stable, and unique across any future merged source. */
  id: string;
  kind: ActivityKind;
  eventType: string;
  occurredAt: Date;
  /** The raw actor string, kept so an auditor can see exactly what was stored. */
  actor: string;
  /** The resolved label. Never claims an automation is a person. */
  actorLabel: string;
  summary: string;
  fromState: string | null;
  toState: string | null;
  artifact: ActivityArtifact | null;
  evidence: 'delivery' | 'access' | null;
  metadata: Record<string, unknown>;
}

export interface ActivityFeed {
  entries: ActivityEntry[];
  /** UNFILTERED totals, so a tab can show a count for a tab you are not on. */
  counts: Record<ActivityKind, number>;
  total: number;
}

// ── Actor resolution ─────────────────────────────────────────────────────────

/**
 * Turns an actor string into something a person can read.
 *
 * FOUR SHAPES, and one of them is a trap. PRD-17 established that the
 * `clinician:` namespace already contains non-humans: `skillActions.ts` writes
 * `SYSTEM-SKILL-<name>` and `pendingInfoChecker.ts` writes `SYSTEM-TIMEOUT`,
 * both through `dispositionService`. Rendering those as clinicians is the exact
 * bug PRD-17 fixed in the analytics filter, and it would be worse here: a feed
 * is read as a narrative of who did what, so labelling automation as a named
 * doctor actively misinforms.
 *
 * An unrecognised shape degrades to the raw string. A feed that throws on an
 * actor format nobody anticipated is worse than one that shows `thing:42`.
 */
export interface ActorLabels {
  usersById: Map<number, string>;
  usersBySlug: Map<string, string>;
  guestsById: Map<number, { displayName: string | null; orgName: string | null }>;
}

export function resolveActorLabel(actor: string, labels: ActorLabels): string {
  if (!actor) return 'Unknown';
  if (actor === 'system') return 'System';

  const [prefix, ...rest] = actor.split(':');
  const value = rest.join(':');

  switch (prefix) {
    case 'user': {
      const id = Number(value);
      return labels.usersById.get(id) ?? `User ${value}`;
    }

    case 'guest': {
      // 'guest:unresolved' is a real actor: a denial where no session could be
      // resolved. It is not a missing guest, it is the denial itself.
      if (value === 'unresolved') return 'An unidentified guest';
      const guest = labels.guestsById.get(Number(value));
      if (!guest) return `Guest ${value}`;
      const org = guest.orgName ? ` (${guest.orgName})` : '';
      return `${guest.displayName ?? 'A guest'}${org}`;
    }

    case 'clinician': {
      // THE TRAP. Automation lives in this namespace too.
      if (value.startsWith('SYSTEM-SKILL-')) {
        return `Automated rule: ${value.slice('SYSTEM-SKILL-'.length)}`;
      }
      if (value === 'SYSTEM-TIMEOUT') return 'Automatic timeout';
      if (value.startsWith('SYSTEM-')) return `Automation: ${value.slice('SYSTEM-'.length)}`;
      return labels.usersBySlug.get(value) ?? value;
    }

    case 'skill':
      return `Automated rule: ${value}`;

    case 'payer':
      return `${value} (payer)`;

    default:
      // Not a shape we know. Say so plainly rather than guessing or throwing.
      return actor;
  }
}

async function loadActorLabels(workspaceId: number): Promise<ActorLabels> {
  const roster = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      legacyClinicianId: users.legacyClinicianId,
    })
    .from(users);

  const guests = await db
    .select({
      id: workspaceGuests.id,
      displayName: workspaceGuests.displayName,
      orgName: workspaceParties.orgName,
    })
    .from(workspaceGuests)
    .leftJoin(workspaceParties, eq(workspaceParties.id, workspaceGuests.partyId))
    .where(eq(workspaceGuests.workspaceId, workspaceId));

  return {
    usersById: new Map(roster.map((u) => [u.id, u.displayName])),
    usersBySlug: new Map(
      roster
        .filter((u): u is typeof u & { legacyClinicianId: string } => !!u.legacyClinicianId)
        .map((u) => [u.legacyClinicianId, u.displayName]),
    ),
    guestsById: new Map(guests.map((g) => [g.id, { displayName: g.displayName, orgName: g.orgName }])),
  };
}

// ── Summaries ────────────────────────────────────────────────────────────────

/**
 * One human-readable line per event.
 *
 * Deliberately a lookup with a fallback rather than a required entry per type:
 * a new event type added by a later PRD gets a readable default instead of a
 * blank row, so forgetting to add a phrase here degrades the feed rather than
 * breaking it.
 */
const SUMMARY: Record<string, (m: Record<string, unknown>) => string> = {
  'referral.received': () => 'Referral received',
  'referral.acknowledged': () => 'Receipt acknowledged to the referring organization',
  'referral.routing_assessed': (m) => `Routed to ${String(m.department ?? 'a department')}`,
  'referral.routing_changed': (m) =>
    `Department changed from ${String(m.previousDepartment ?? 'unset')} to ${String(m.department ?? 'unset')}`,
  'referral.auto_declined': () => 'Automatically declined at intake',
  'referral.disposition_overridden': (m) =>
    `Disposition overridden${m.bypassedStateMachine ? ' — reopened from a terminal state' : ''}`,
  'referral.pending_info': () => 'Information requested from the referring organization',
  'referral.pending_info_escalated': () => 'Information request timed out and was escalated',
  'referral.scheduled': () => 'Appointment scheduled',
  'referral.no_show': () => 'Patient did not attend',
  'referral.encounter_complete': () => 'Patient seen',
  'referral.closed': () => 'Consult note returned',
  'referral.closed_confirmed': () => 'Loop closed and confirmed',
  'message.sent': (m) => `${String(m.messageType ?? 'Message')} sent`,
  'message.acknowledged': (m) => `${String(m.messageType ?? 'Message')} acknowledged by the recipient`,
  'workspace.created': () => 'Workspace created',
  'workspace.archived': () => 'Workspace archived',
  'workspace.assigned': (m) => `Assigned${m.toDisplayName ? ` to ${String(m.toDisplayName)}` : ''}`,
  'workspace.released': () => 'Released back to the queue',
  'workspace.work_status_changed': (m) => `Work status set to ${String(m.workStatus ?? m.toStatus ?? '')}`,
  'workspace.work_status_proposal_declined': (m) =>
    `Suggested status ${String(m.proposed ?? '')} not applied (${String(m.declinedReason ?? 'protected')})`,
  'workspace.work_status_resynced': () => 'Work status resynced to the protocol state',
  'workspace.party_seeded': () => 'Parties identified',
  'workspace.party_updated': () => 'Party details updated',
  'workspace.party_address_observed': (m) => `Learned a new address for a party: ${String(m.address ?? '')}`,
  'workspace.protocol_mode_changed': (m) => `Protocol mode set to ${String(m.protocolMode ?? m.mode ?? '')}`,
  'workspace.capability_verified': () => '360X capability confirmed by a real exchange',
  'workspace.participant_added': (m) => `${String(m.displayName ?? 'Somebody')} added to the referral`,
  'workspace.participant_removed': (m) => `${String(m.displayName ?? 'Somebody')} removed from the referral`,
  'workspace.comment_added': (m) =>
    `${m.visibility === 'Shared' ? 'Shared' : 'Internal'} comment added`,
  'workspace.comment_edited': () => 'Comment edited',
  'workspace.comment_deleted': () => 'Comment deleted',
  'workspace.comment_shared': () => 'Comment shared with the other organization',
  'workspace.comment_downgrade_refused': () =>
    'Attempt to make a shared comment internal again was refused',
  'workspace.comment_mention': () => 'Somebody was mentioned',
  'workspace.comment_mention_acknowledged': (m) => `${String(m.count ?? 0)} mention(s) marked as read`,
  'workspace.document_indexed': (m) => `${String(m.docType ?? 'Document')} added to the collection`,
  'workspace.document_uploaded': (m) => `${String(m.contentType ?? 'File')} uploaded`,
  'workspace.document_viewed': () => 'Document opened',
  'workspace.document_downloaded': () => 'Document downloaded',
  'workspace.document_access_denied': (m) => `Document access refused (${String(m.reason ?? 'not permitted')})`,
  'workspace.guest_invited': () => 'The other organization was invited',
  'workspace.guest_reissued': () => 'Invitation reissued',
  'workspace.guest_revoked': () => 'Guest access ended',
  'workspace.guest_accepted': () => 'Invitation accepted',
  'workspace.guest_access_denied': (m) => `Guest access refused (${String(m.reason ?? 'not permitted')})`,
  'workspace.assertion_made': (m) => `Protocol assertion: ${String(m.assertionType ?? 'unknown')}`,
  'workspace.artifact_not_transmitted': (m) =>
    `Artifact recorded but not sent — ${String(m.reason ?? 'no address on file')}`,
  'skill.evaluated': (m) => `Rule evaluated: ${String(m.skillName ?? '')}`,
  'skill.action_executed': (m) => `Rule action taken: ${String(m.action ?? '')}`,
  'prior_auth.submitted': () => 'Prior authorization submitted',
  'prior_auth.expired': () => 'Prior authorization expired',
  'prior_auth.error': () => 'Prior authorization error',
};

/** A readable last resort: `workspace.foo_bar` → "Foo bar". */
function fallbackSummary(eventType: string): string {
  const verb = eventType.includes('.') ? eventType.split('.').slice(1).join('.') : eventType;
  const words = verb.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function summarize(eventType: string, metadata: Record<string, unknown>): string {
  const fn = SUMMARY[eventType];
  if (!fn) return fallbackSummary(eventType);
  try {
    return fn(metadata);
  } catch {
    // A malformed metadata shape degrades this one line, not the whole feed.
    return fallbackSummary(eventType);
  }
}

/** Tolerates a malformed value rather than failing the feed for it. */
function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Artifact resolution ──────────────────────────────────────────────────────

/**
 * Links an entry to the thing it concerns, by joining rather than by trusting a
 * label copied into the event.
 */
async function loadArtifactLabels(
  workspaceId: number,
): Promise<{ documents: Map<number, string>; comments: Set<number> }> {
  const documents = await db
    .select({ id: workspaceDocuments.id, docType: workspaceDocuments.docType })
    .from(workspaceDocuments)
    .where(eq(workspaceDocuments.workspaceId, workspaceId));

  const comments = await db
    .select({ id: referralComments.id })
    .from(referralComments)
    .where(eq(referralComments.workspaceId, workspaceId));

  return {
    documents: new Map(documents.map((d) => [d.id, d.docType])),
    comments: new Set(comments.map((c) => c.id)),
  };
}

function artifactFor(
  metadata: Record<string, unknown>,
  labels: { documents: Map<number, string>; comments: Set<number> },
): ActivityArtifact | null {
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

  const documentId = num(metadata.documentId);
  if (documentId !== null) {
    return {
      kind: 'document',
      id: documentId,
      // A document deleted after its event was emitted is shown as unavailable
      // rather than omitted: the event happened, and hiding it would be a
      // quieter kind of lie than saying the target is gone.
      label: labels.documents.get(documentId) ?? 'Document no longer available',
    };
  }

  const commentId = num(metadata.commentId);
  if (commentId !== null) {
    return {
      kind: 'comment',
      id: commentId,
      label: labels.comments.has(commentId) ? 'Comment' : 'Comment no longer available',
    };
  }

  const assertionId = num(metadata.assertionId);
  if (assertionId !== null) {
    return { kind: 'assertion', id: assertionId, label: 'Protocol artifact' };
  }

  return null;
}

// ── The feed ─────────────────────────────────────────────────────────────────

function emptyCounts(): Record<ActivityKind, number> {
  return { system: 0, user: 0, guest: 0, status: 0, delivery: 0, access: 0 };
}

/**
 * Every recorded event for this workspace's referral, in the order it happened.
 *
 * `counts` is always the UNFILTERED total, so a tab can show how many entries it
 * holds while you are looking at a different one. Returning filtered counts
 * would make every tab read zero except the active one.
 */
export async function getActivityFeed(
  workspaceId: number,
  kind?: ActivityKind,
): Promise<ActivityFeed> {
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
    throw new ActivityWorkspaceNotFoundError(workspaceId);
  }
  const [workspace] = await db
    .select({ id: referralWorkspaces.id, referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  if (!workspace) throw new ActivityWorkspaceNotFoundError(workspaceId);

  const rows = await db
    .select()
    .from(workflowEvents)
    .where(
      and(eq(workflowEvents.entityType, 'referral'), eq(workflowEvents.entityId, workspace.referralId)),
    )
    // Deterministic tiebreak by id: two events written in the same second must
    // not reorder between requests.
    .orderBy(asc(workflowEvents.createdAt), asc(workflowEvents.id));

  const [actorLabels, artifactLabels] = await Promise.all([
    loadActorLabels(workspaceId),
    loadArtifactLabels(workspaceId),
  ]);

  const counts = emptyCounts();
  const all: ActivityEntry[] = rows.map((row) => {
    const metadata = parseMetadata(row.metadata);
    const entryKind = kindOf(row.eventType, row.actor);
    counts[entryKind] += 1;
    return {
      id: `workflow_events:${row.id}`,
      kind: entryKind,
      eventType: row.eventType,
      occurredAt: row.createdAt,
      actor: row.actor,
      actorLabel: resolveActorLabel(row.actor, actorLabels),
      summary: summarize(row.eventType, metadata),
      fromState: row.fromState,
      toState: row.toState,
      artifact: artifactFor(metadata, artifactLabels),
      evidence: evidenceOf(row.eventType),
      metadata,
    };
  });

  return {
    entries: kind ? all.filter((e) => e.kind === kind) : all,
    counts,
    total: all.length,
  };
}

/**
 * What a GUEST sees: protocol milestones only.
 *
 * CONSTRUCTED FROM AN ALLOW-LIST, never the internal feed with entries removed.
 * That is the same rule as PRD-30's payload and PRD-23's document list, and the
 * reason is identical: a deny-list fails only for the event types somebody
 * already thought of, so PRD-28 adding `workspace.exception_raised` would
 * silently surface an internal exception to a counterparty.
 *
 * The filter is in the SQL, so an internal event is never loaded into the
 * process on a guest's behalf.
 */
export async function getGuestActivityFeed(guest: GuestContext): Promise<ActivityFeed> {
  const [workspace] = await db
    .select({ referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, guest.workspaceId))
    .limit(1);
  if (!workspace) return { entries: [], counts: emptyCounts(), total: 0 };

  const rows = await db
    .select()
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.entityType, 'referral'),
        eq(workflowEvents.entityId, workspace.referralId),
        inArray(workflowEvents.eventType, [...GUEST_VISIBLE_EVENTS]),
      ),
    )
    .orderBy(asc(workflowEvents.createdAt), asc(workflowEvents.id));

  const counts = emptyCounts();
  const entries: ActivityEntry[] = rows.map((row) => {
    counts.status += 1;
    return {
      id: `workflow_events:${row.id}`,
      kind: 'status' as ActivityKind,
      eventType: row.eventType,
      occurredAt: row.createdAt,
      // The actor is NOT passed through. Which coordinator moved the referral is
      // internal staffing detail; that the organization did is the fact a guest
      // needs.
      actor: 'organization',
      actorLabel: 'The specialist organization',
      summary: summarize(row.eventType, {}),
      fromState: row.fromState,
      toState: row.toState,
      artifact: null,
      evidence: null,
      metadata: {},
    };
  });

  return { entries, counts, total: entries.length };
}

/** Exported for the test that asserts the catalog and the classifier agree. */
export { ACTIVITY_KINDS };
