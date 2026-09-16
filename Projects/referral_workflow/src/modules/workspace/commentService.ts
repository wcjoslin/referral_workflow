/**
 * PRD-22 — the referral conversation.
 *
 * One thread per workspace carrying two kinds of speech: internal notes that
 * must never leave the organization, and messages meant for the other party.
 *
 * THE BOUNDARY IS STRUCTURAL, NOT COSMETIC. `listSharedComments()` filters on
 * `visibility = 'Shared'` in SQL, so an internal row never enters the guest code
 * path at all — a later rendering mistake cannot expose what was never loaded.
 * The guest type is built field by field and is narrower than the internal one:
 * no job role, no tombstone metadata, no share-lock state. "Omit, do not hide",
 * the rule PRD-30 established.
 *
 * A COMMENT HAS TWO PARTS, and keeping them apart is what makes the audit
 * semantics work:
 *
 *   IDENTITY (`referral_comments`) never changes. It is what an edit targets,
 *   what a tombstone marks, and what a mention hangs off.
 *
 *   CONTENT (`comment_revisions`) is append-only. An edit supersedes the current
 *   revision and inserts the next; a partial unique index guarantees exactly one
 *   current revision per comment.
 *
 * NOTHING IS EVER HARD-DELETED — not a comment, not a revision, not a mention.
 * A delete sets a tombstone and the service stops handing out the body; an edit
 * that drops a mention leaves the old mention row attached to a superseded
 * revision, which is how a retraction is represented without losing the fact.
 */

import { SQL, and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../../db';
import {
  commentMentions,
  commentRevisions,
  referralComments,
  referralWorkspaces,
  users,
  workspaceGuests,
  workspaceInvitations,
  workspaceParties,
} from '../../db/schema';
import { config } from '../../config';
import { emitEvent } from '../analytics/eventService';
import { ActingUser, JobRole, formatActor, listUsers } from './identityService';
import { PartyRole, getParties } from './partyService';
import { getParticipants } from './participantService';
import { GuestContext, formatGuestActor } from './guestAccess';

export type CommentVisibility = 'Internal' | 'Shared';

export const COMMENT_VISIBILITIES: readonly CommentVisibility[] = ['Internal', 'Shared'];

export function isCommentVisibility(value: string): value is CommentVisibility {
  return (COMMENT_VISIBILITIES as readonly string[]).includes(value);
}

/**
 * A cap on the most user-controlled string in the application. Neither the
 * column nor the render should be unbounded.
 */
export const MAX_COMMENT_LENGTH = 4000;

// ── Errors ───────────────────────────────────────────────────────────────────

export class CommentWorkspaceNotFoundError extends Error {
  constructor(workspaceId: number) {
    super(`No workspace with id ${workspaceId}`);
    this.name = 'CommentWorkspaceNotFoundError';
  }
}

export class CommentEmptyError extends Error {
  constructor() {
    super('A comment needs something in it.');
    this.name = 'CommentEmptyError';
  }
}

export class CommentTooLongError extends Error {
  constructor(length: number) {
    super(`A comment may be at most ${MAX_COMMENT_LENGTH} characters; this one is ${length}.`);
    this.name = 'CommentTooLongError';
  }
}

export class CommentNotFoundError extends Error {
  constructor(commentId: number) {
    super(`No comment with id ${commentId}`);
    this.name = 'CommentNotFoundError';
  }
}

export class CommentDeletedError extends Error {
  constructor() {
    super('This comment has been deleted and can no longer be edited.');
    this.name = 'CommentDeletedError';
  }
}

export class CommentNotAuthorError extends Error {
  constructor() {
    super('Only the person who wrote a comment can change its wording.');
    this.name = 'CommentNotAuthorError';
  }
}

export class ShareNotConfirmedError extends Error {
  constructor() {
    super('Sharing a comment with the other organization needs an explicit confirmation.');
    this.name = 'ShareNotConfirmedError';
  }
}

export class VisibilityDowngradeError extends Error {
  constructor() {
    super(
      'This comment cannot be made internal again: someone outside your organization has ' +
        'already had access to it.',
    );
    this.name = 'VisibilityDowngradeError';
  }
}

export class GuestVisibilityError extends Error {
  constructor() {
    super('A comment posted from outside your organization is always shared.');
    this.name = 'GuestVisibilityError';
  }
}

export class SharedMentionError extends Error {
  constructor() {
    super(
      'A shared comment cannot mention a colleague: the other organization would see the ' +
        'mention. Mention the organization instead, or keep the comment internal.',
    );
    this.name = 'SharedMentionError';
  }
}

export class MentionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MentionTargetError';
  }
}

export class CommentRevisionConflictError extends Error {
  constructor() {
    super('This comment was changed by someone else. Reload the conversation and try again.');
    this.name = 'CommentRevisionConflictError';
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface CommentMentionSummary {
  kind: 'user' | 'party';
  id: number;
  displayName: string;
  acknowledgedAt: Date | null;
}

export interface Comment {
  id: number;
  workspaceId: number;
  /** null when tombstoned. The service does not hand out a deleted body. */
  body: string | null;
  visibility: CommentVisibility;
  authorKind: 'user' | 'guest';
  /**
   * The author's user id, or null for a guest. Present so the panel can offer
   * the edit control only to the author. The rule is still ENFORCED on the
   * server — this is presentation, not permission.
   */
  authorUserId: number | null;
  authorDisplayName: string;
  authorJobRole: JobRole | null;
  authorPartyOrgName: string | null;
  /** Author since deactivated, or guest invitation since revoked. Still attributed. */
  authorInactive: boolean;
  mentions: CommentMentionSummary[];
  createdAt: Date;
  editedAt: Date | null;
  revisionCount: number;
  deleted: boolean;
  deletedAt: Date | null;
  deletedByActor: string | null;
  /** True when a guest has been active since this first became shared. */
  shareLocked: boolean;
}

/**
 * What a guest receives. Deliberately narrower than `Comment` — asserted against
 * GUEST_COMMENT_KEYS by a test, so a field added to the internal shape does not
 * silently reach an external reader.
 */
export interface GuestSharedComment {
  id: number;
  body: string;
  authorDisplayName: string;
  authorOrgName: string;
  createdAt: string;
  edited: boolean;
  /** True when this guest wrote it, so the panel can style it as theirs. */
  own: boolean;
}

export const GUEST_COMMENT_KEYS: readonly string[] = [
  'id',
  'body',
  'authorDisplayName',
  'authorOrgName',
  'createdAt',
  'edited',
  'own',
];

export interface CommentRevisionRecord {
  revisionNumber: number;
  body: string;
  visibility: CommentVisibility;
  createdAt: Date;
  createdByActor: string;
  supersededAt: Date | null;
}

export interface MentionTargets {
  users: { id: number; displayName: string; jobRole: JobRole; isParticipant: boolean }[];
  parties: { id: number; orgName: string; partyRole: PartyRole; hasLiveInvitation: boolean }[];
}

export interface CommentMentionInput {
  users?: number[];
  parties?: number[];
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Local copy, matching partyService / participantService / invitationService.
 *
 * Four identical copies is not a virtue. It is left alone here because moving it
 * somewhere shared would mean `partyService` importing `workspaceService`, which
 * already imports `partyService` — a cycle. Consolidating it needs its own small
 * change, not this PRD's.
 */
async function referralIdFor(workspaceId: number): Promise<number> {
  const [row] = await db
    .select({ referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  return row?.referralId ?? 0;
}

async function requireWorkspace(workspaceId: number): Promise<void> {
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
    throw new CommentWorkspaceNotFoundError(workspaceId);
  }
  const [row] = await db
    .select({ id: referralWorkspaces.id })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  if (!row) throw new CommentWorkspaceNotFoundError(workspaceId);
}

/** Trim, then refuse empty and over-length. A body of three spaces is empty. */
function normalizeBody(raw: unknown): string {
  const body = typeof raw === 'string' ? raw.trim() : '';
  if (!body) throw new CommentEmptyError();
  if (body.length > MAX_COMMENT_LENGTH) throw new CommentTooLongError(body.length);
  return body;
}

function asVisibility(value: string): CommentVisibility {
  // A stored value outside the pair would be a schema violation; treat it as
  // Internal rather than leaking it, because the safe default is the private one.
  return value === 'Shared' ? 'Shared' : 'Internal';
}

/**
 * The organization name a guest should see against an internally-authored
 * comment: the receiving party's, which PRD-24 seeded from config.
 */
async function internalOrgName(workspaceId: number): Promise<string> {
  const [row] = await db
    .select({ orgName: workspaceParties.orgName })
    .from(workspaceParties)
    .where(
      and(
        eq(workspaceParties.workspaceId, workspaceId),
        eq(workspaceParties.partyRole, 'receiving'),
      ),
    )
    .limit(1);
  return row?.orgName ?? config.receiving.orgName;
}

/**
 * The latest moment any guest on this workspace was active, or null when the
 * workspace has never had one.
 *
 * `requireGuest()` stamps `last_seen_at` on every authenticated guest request,
 * which is what lets the share lock work without a read-receipt table.
 */
async function latestGuestActivity(workspaceId: number): Promise<Date | null> {
  const rows = await db
    .select({ lastSeenAt: workspaceGuests.lastSeenAt })
    .from(workspaceGuests)
    .where(and(eq(workspaceGuests.workspaceId, workspaceId), isNotNull(workspaceGuests.lastSeenAt)))
    .orderBy(desc(workspaceGuests.lastSeenAt))
    .limit(1);
  return rows[0]?.lastSeenAt ?? null;
}

/**
 * When each of these comments FIRST became shared.
 *
 * The earliest share is the right anchor rather than the current revision's: a
 * comment that was shared, pulled back and shared again was exposed from the
 * first of those, and anchoring on the earliest over-locks rather than
 * under-locks.
 */
async function firstSharedAt(commentIds: number[]): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  if (commentIds.length === 0) return out;
  const rows = await db
    .select({
      commentId: commentRevisions.commentId,
      createdAt: commentRevisions.createdAt,
    })
    .from(commentRevisions)
    .where(
      and(
        inArray(commentRevisions.commentId, commentIds),
        eq(commentRevisions.visibility, 'Shared'),
      ),
    )
    .orderBy(asc(commentRevisions.createdAt));
  for (const row of rows) {
    if (!out.has(row.commentId)) out.set(row.commentId, row.createdAt);
  }
  return out;
}

/** The mentions attached to these revisions, with display names resolved. */
async function mentionsForRevisions(
  revisionIds: number[],
): Promise<Map<number, CommentMentionSummary[]>> {
  const out = new Map<number, CommentMentionSummary[]>();
  if (revisionIds.length === 0) return out;

  const rows = await db
    .select({
      revisionId: commentMentions.revisionId,
      mentionedUserId: commentMentions.mentionedUserId,
      mentionedPartyId: commentMentions.mentionedPartyId,
      acknowledgedAt: commentMentions.acknowledgedAt,
      userName: users.displayName,
      partyName: workspaceParties.orgName,
    })
    .from(commentMentions)
    .leftJoin(users, eq(users.id, commentMentions.mentionedUserId))
    .leftJoin(workspaceParties, eq(workspaceParties.id, commentMentions.mentionedPartyId))
    .where(inArray(commentMentions.revisionId, revisionIds))
    .orderBy(asc(commentMentions.id));

  for (const row of rows) {
    const list = out.get(row.revisionId) ?? [];
    if (row.mentionedUserId !== null) {
      list.push({
        kind: 'user',
        id: row.mentionedUserId,
        displayName: row.userName ?? `User ${row.mentionedUserId}`,
        acknowledgedAt: row.acknowledgedAt,
      });
    } else if (row.mentionedPartyId !== null) {
      list.push({
        kind: 'party',
        id: row.mentionedPartyId,
        displayName: row.partyName ?? `Party ${row.mentionedPartyId}`,
        acknowledgedAt: row.acknowledgedAt,
      });
    }
    out.set(row.revisionId, list);
  }
  return out;
}

/**
 * Validates mention targets before anything is written.
 *
 * A shared comment may not mention internal users at all — that is the rule that
 * stops "@Priya can you believe this referral" from reaching the other side.
 */
async function resolveMentions(
  workspaceId: number,
  visibility: CommentVisibility,
  input: CommentMentionInput | undefined,
): Promise<{ users: number[]; parties: number[] }> {
  const userIds = [...new Set((input?.users ?? []).filter((n) => Number.isInteger(n) && n > 0))];
  const partyIds = [...new Set((input?.parties ?? []).filter((n) => Number.isInteger(n) && n > 0))];

  if (visibility === 'Shared' && userIds.length > 0) throw new SharedMentionError();

  if (userIds.length > 0) {
    const found = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, userIds), eq(users.active, true)));
    const ok = new Set(found.map((r) => r.id));
    const bad = userIds.filter((id) => !ok.has(id));
    if (bad.length > 0) {
      throw new MentionTargetError(
        `Cannot mention ${bad.length === 1 ? 'user' : 'users'} ${bad.join(', ')}: no such active user.`,
      );
    }
  }

  if (partyIds.length > 0) {
    const found = await db
      .select({ id: workspaceParties.id })
      .from(workspaceParties)
      .where(
        and(inArray(workspaceParties.id, partyIds), eq(workspaceParties.workspaceId, workspaceId)),
      );
    const ok = new Set(found.map((r) => r.id));
    const bad = partyIds.filter((id) => !ok.has(id));
    if (bad.length > 0) {
      throw new MentionTargetError(
        `Cannot mention ${bad.length === 1 ? 'party' : 'parties'} ${bad.join(', ')}: not on this referral.`,
      );
    }
  }

  return { users: userIds, parties: partyIds };
}

async function insertMentions(
  workspaceId: number,
  commentId: number,
  revisionId: number,
  targets: { users: number[]; parties: number[] },
  now: Date,
): Promise<void> {
  const rows = [
    ...targets.users.map((id) => ({ mentionedUserId: id, mentionedPartyId: null })),
    ...targets.parties.map((id) => ({ mentionedUserId: null, mentionedPartyId: id })),
  ];
  if (rows.length === 0) return;
  await db.insert(commentMentions).values(
    rows.map((r) => ({
      commentId,
      revisionId,
      workspaceId,
      mentionedUserId: r.mentionedUserId,
      mentionedPartyId: r.mentionedPartyId,
      createdAt: now,
      acknowledgedAt: null,
      acknowledgedByActor: null,
    })),
  );
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The internal thread: every comment, both visibilities, tombstones included as
 * tombstones.
 *
 * `revisionCount` is the current revision's number rather than a `COUNT(*)`.
 * Revision numbers are 1-based and every edit increments by exactly one, and no
 * revision is ever deleted, so the two are the same figure and this is one fewer
 * query.
 */
export async function listComments(workspaceId: number): Promise<Comment[]> {
  await requireWorkspace(workspaceId);

  const rows = await db
    .select({
      id: referralComments.id,
      workspaceId: referralComments.workspaceId,
      authorUserId: referralComments.authorUserId,
      authorGuestId: referralComments.authorGuestId,
      createdAt: referralComments.createdAt,
      deletedAt: referralComments.deletedAt,
      deletedByActor: referralComments.deletedByActor,
      revisionId: commentRevisions.id,
      revisionNumber: commentRevisions.revisionNumber,
      body: commentRevisions.body,
      visibility: commentRevisions.visibility,
      revisionCreatedAt: commentRevisions.createdAt,
      userName: users.displayName,
      userJobRole: users.jobRole,
      userActive: users.active,
      guestName: workspaceGuests.displayName,
      guestPartyOrg: workspaceParties.orgName,
      invitationRevokedAt: workspaceInvitations.revokedAt,
    })
    .from(referralComments)
    .innerJoin(
      commentRevisions,
      and(
        eq(commentRevisions.commentId, referralComments.id),
        isNull(commentRevisions.supersededAt),
      ),
    )
    .leftJoin(users, eq(users.id, referralComments.authorUserId))
    .leftJoin(workspaceGuests, eq(workspaceGuests.id, referralComments.authorGuestId))
    .leftJoin(workspaceParties, eq(workspaceParties.id, referralComments.authorPartyId))
    .leftJoin(workspaceInvitations, eq(workspaceInvitations.id, workspaceGuests.invitationId))
    .where(eq(referralComments.workspaceId, workspaceId))
    .orderBy(asc(referralComments.createdAt), asc(referralComments.id));

  const mentionMap = await mentionsForRevisions(rows.map((r) => r.revisionId));
  const sharedMap = await firstSharedAt(rows.map((r) => r.id));
  const guestActivity = await latestGuestActivity(workspaceId);

  return rows.map((row) => {
    const deleted = row.deletedAt !== null;
    const isGuest = row.authorGuestId !== null;
    const shared = sharedMap.get(row.id) ?? null;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      body: deleted ? null : row.body,
      visibility: asVisibility(row.visibility),
      authorKind: isGuest ? 'guest' : 'user',
      authorUserId: row.authorUserId,
      authorDisplayName: isGuest
        ? (row.guestName ?? `Guest at ${row.guestPartyOrg ?? 'another organization'}`)
        : (row.userName ?? 'Unknown user'),
      authorJobRole: isGuest ? null : ((row.userJobRole as JobRole | null) ?? null),
      authorPartyOrgName: isGuest ? (row.guestPartyOrg ?? null) : null,
      authorInactive: isGuest ? row.invitationRevokedAt !== null : row.userActive === false,
      mentions: mentionMap.get(row.revisionId) ?? [],
      createdAt: row.createdAt,
      editedAt: row.revisionNumber > 1 ? row.revisionCreatedAt : null,
      revisionCount: row.revisionNumber,
      deleted,
      deletedAt: row.deletedAt,
      deletedByActor: row.deletedByActor,
      // `>=`, NOT `>`. Both columns are drizzle `mode: 'timestamp'`, which
      // stores WHOLE SECONDS, so a guest who loads the page in the same second
      // as the share reads an identical value. The smoke check caught this: the
      // guest had demonstrably loaded the page after the comment was shared and
      // the downgrade was still allowed, because both timestamps truncated to
      // the same second. Ties lock, which is the safe direction — the cost is
      // over-locking inside a one-second window.
      shareLocked:
        shared !== null && guestActivity !== null && guestActivity.getTime() >= shared.getTime(),
    };
  });
}

/**
 * What a guest sees: shared, non-tombstoned, current revisions only.
 *
 * The three restrictions are in the SQL, not applied afterwards, so an internal
 * comment is never loaded into this process on a guest's behalf.
 */
export async function listSharedComments(
  workspaceId: number,
  viewerGuestId: number,
): Promise<GuestSharedComment[]> {
  const rows = await db
    .select({
      id: referralComments.id,
      authorGuestId: referralComments.authorGuestId,
      createdAt: referralComments.createdAt,
      body: commentRevisions.body,
      revisionNumber: commentRevisions.revisionNumber,
      userName: users.displayName,
      guestName: workspaceGuests.displayName,
      guestPartyOrg: workspaceParties.orgName,
    })
    .from(referralComments)
    .innerJoin(
      commentRevisions,
      and(
        eq(commentRevisions.commentId, referralComments.id),
        isNull(commentRevisions.supersededAt),
        eq(commentRevisions.visibility, 'Shared'),
      ),
    )
    .leftJoin(users, eq(users.id, referralComments.authorUserId))
    .leftJoin(workspaceGuests, eq(workspaceGuests.id, referralComments.authorGuestId))
    .leftJoin(workspaceParties, eq(workspaceParties.id, referralComments.authorPartyId))
    .where(and(eq(referralComments.workspaceId, workspaceId), isNull(referralComments.deletedAt)))
    .orderBy(asc(referralComments.createdAt), asc(referralComments.id));

  const ourOrg = rows.some((r) => r.authorGuestId === null)
    ? await internalOrgName(workspaceId)
    : '';

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    authorDisplayName:
      row.authorGuestId !== null
        ? (row.guestName ?? `Guest at ${row.guestPartyOrg ?? 'another organization'}`)
        : (row.userName ?? 'Care coordination team'),
    authorOrgName:
      row.authorGuestId !== null ? (row.guestPartyOrg ?? 'Another organization') : ourOrg,
    createdAt: row.createdAt.toISOString(),
    edited: row.revisionNumber > 1,
    own: row.authorGuestId === viewerGuestId,
  }));
}

/**
 * The full revision history. THE AUDIT PATH — this is the only way to read the
 * text of a superseded or tombstoned revision, and it has no guest route.
 */
export async function getCommentHistory(
  workspaceId: number,
  commentId: number,
): Promise<CommentRevisionRecord[]> {
  // Scoped to the workspace like every other comment operation. Nothing
  // internally restricts which workspaces a user may see, so this is not a
  // privilege boundary today — but a reader should not have to work out which
  // of these functions checks and which does not.
  const [comment] = await db
    .select({ id: referralComments.id })
    .from(referralComments)
    .where(
      and(eq(referralComments.id, commentId), eq(referralComments.workspaceId, workspaceId)),
    )
    .limit(1);
  if (!comment) throw new CommentNotFoundError(commentId);

  const rows = await db
    .select()
    .from(commentRevisions)
    .where(eq(commentRevisions.commentId, commentId))
    .orderBy(asc(commentRevisions.revisionNumber));

  return rows.map((row) => ({
    revisionNumber: row.revisionNumber,
    body: row.body,
    visibility: asVisibility(row.visibility),
    createdAt: row.createdAt,
    createdByActor: row.createdByActor,
    supersededAt: row.supersededAt,
  }));
}

/** One comment by id, from the internal thread. */
async function getComment(workspaceId: number, commentId: number): Promise<Comment> {
  const all = await listComments(workspaceId);
  const found = all.find((c) => c.id === commentId);
  if (!found) throw new CommentNotFoundError(commentId);
  return found;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface PostCommentInput {
  workspaceId: number;
  body: string;
  /** Defaults to 'Internal'. A missing value is never 'Shared'. */
  visibility?: CommentVisibility;
  confirmShared?: boolean;
  author: { kind: 'user'; user: ActingUser } | { kind: 'guest'; guest: GuestContext };
  mentions?: CommentMentionInput;
}

export async function postComment(input: PostCommentInput): Promise<Comment> {
  await requireWorkspace(input.workspaceId);
  const body = normalizeBody(input.body);

  let visibility: CommentVisibility;
  if (input.author.kind === 'guest') {
    // Forced, and a different supplied value is REFUSED rather than coerced, so
    // a client bug surfaces instead of hiding.
    if (input.visibility !== undefined && input.visibility !== 'Shared') {
      throw new GuestVisibilityError();
    }
    visibility = 'Shared';
  } else {
    visibility = input.visibility ?? 'Internal';
    if (visibility === 'Shared' && input.confirmShared !== true) throw new ShareNotConfirmedError();
  }

  const targets = await resolveMentions(input.workspaceId, visibility, input.mentions);

  const actor =
    input.author.kind === 'guest'
      ? formatGuestActor(input.author.guest)
      : formatActor(input.author.user);
  const now = new Date();

  const [comment] = await db
    .insert(referralComments)
    .values({
      workspaceId: input.workspaceId,
      authorUserId: input.author.kind === 'user' ? input.author.user.id : null,
      authorGuestId: input.author.kind === 'guest' ? input.author.guest.guestId : null,
      authorPartyId: input.author.kind === 'guest' ? input.author.guest.partyId : null,
      createdAt: now,
      deletedAt: null,
      deletedByActor: null,
    })
    .returning();

  const [revision] = await db
    .insert(commentRevisions)
    .values({
      commentId: comment.id,
      revisionNumber: 1,
      body,
      visibility,
      createdAt: now,
      createdByActor: actor,
      supersededAt: null,
    })
    .returning();

  await insertMentions(input.workspaceId, comment.id, revision.id, targets, now);

  const referralId = await referralIdFor(input.workspaceId);
  void emitEvent({
    eventType: 'workspace.comment_added',
    entityType: 'referral',
    entityId: referralId,
    actor,
    metadata: {
      workspaceId: input.workspaceId,
      commentId: comment.id,
      visibility,
      authorKind: input.author.kind,
      ...(input.author.kind === 'guest' ? { partyId: input.author.guest.partyId } : {}),
      mentionCount: targets.users.length + targets.parties.length,
    },
  }).catch((err) => console.error('[CommentService]', err));

  if (visibility === 'Shared') {
    void emitShared(referralId, input.workspaceId, comment.id, actor);
  }
  await emitMentionEvents(referralId, input.workspaceId, comment.id, actor, targets);

  // PRD-27. Two DIFFERENT notifications depending on who wrote it, and the
  // direction is the whole point:
  //
  //   - a GUEST comment is guest_activity, delivered INTERNALLY, naming the
  //     organization that acted (AC19/AC20)
  //   - an INTERNAL shared comment is shared_activity, delivered to the guest
  //     by email with NO comment text in the body (AC16)
  //
  // An internal-only comment notifies nobody externally, which is the boundary
  // the guest allow list enforces at the funnel rather than here.
  void (async (): Promise<void> => {
    const n = await import('./notificationService');
    if (input.author.kind === 'guest') {
      const { getParty } = await import('./partyService');
      const party = await getParty(input.author.guest.partyId);
      await n.notifyGuestActivity(
        input.workspaceId,
        input.author.guest.displayName ?? 'A guest',
        party?.orgName ?? null,
        'posted a comment',
      );
      return;
    }
    if (visibility === 'Shared') {
      for (const guestId of await n.activeGuestIds(input.workspaceId)) {
        await n.notifySharedActivity(
          input.workspaceId,
          guestId,
          'A comment',
          `/guest/workspace`,
        );
      }
    }
  })().catch((err) => console.error('[CommentService] comment notification failed', err));

  return getComment(input.workspaceId, comment.id);
}

export interface EditCommentInput {
  workspaceId: number;
  commentId: number;
  body: string;
  visibility: CommentVisibility;
  confirmShared?: boolean;
  user: ActingUser;
  mentions?: CommentMentionInput;
}

/**
 * An edit appends. It supersedes the current revision and inserts the next one,
 * so the previous text and the previous visibility both survive.
 */
export async function editComment(input: EditCommentInput): Promise<Comment> {
  await requireWorkspace(input.workspaceId);

  const [row] = await db
    .select()
    .from(referralComments)
    .where(
      and(
        eq(referralComments.id, input.commentId),
        eq(referralComments.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw new CommentNotFoundError(input.commentId);
  if (row.deletedAt !== null) throw new CommentDeletedError();

  // Only the author changes their own wording. A guest-authored comment has a
  // null authorUserId, so this refuses every internal user for it too — which is
  // correct: an internal user may TOMBSTONE a guest's comment but never rewrite
  // what they said.
  if (row.authorUserId !== input.user.id) throw new CommentNotAuthorError();

  const [current] = await db
    .select()
    .from(commentRevisions)
    .where(
      and(eq(commentRevisions.commentId, input.commentId), isNull(commentRevisions.supersededAt)),
    )
    .limit(1);
  if (!current) throw new CommentNotFoundError(input.commentId);

  const body = normalizeBody(input.body);
  const from = asVisibility(current.visibility);
  const to = input.visibility;

  // Confirmation is required when a comment BECOMES shared, not on every edit of
  // one that already is. Re-confirming an edit to an already-shared comment
  // would train people to click through the confirmation, which costs more
  // safety than it buys.
  if (to === 'Shared' && from === 'Internal' && input.confirmShared !== true) {
    throw new ShareNotConfirmedError();
  }

  const referralId = await referralIdFor(input.workspaceId);
  const actor = formatActor(input.user);

  if (from === 'Shared' && to === 'Internal') {
    const existing = await getComment(input.workspaceId, input.commentId);
    if (existing.shareLocked) {
      // Recorded, not just refused: an attempted retroactive downgrade is
      // exactly what an auditor wants to see.
      void emitEvent({
        eventType: 'workspace.comment_downgrade_refused',
        entityType: 'referral',
        entityId: referralId,
        actor,
        metadata: { workspaceId: input.workspaceId, commentId: input.commentId },
      }).catch((err) => console.error('[CommentService]', err));
      throw new VisibilityDowngradeError();
    }
  }

  const targets = await resolveMentions(input.workspaceId, to, input.mentions);
  const now = new Date();

  // Supersede FIRST. The partial unique index permits one current revision per
  // comment, so the new row cannot be inserted until this one steps aside — and
  // `changes === 0` means somebody else already superseded it.
  const superseded = await db
    .update(commentRevisions)
    .set({ supersededAt: now })
    .where(and(eq(commentRevisions.id, current.id), isNull(commentRevisions.supersededAt)));
  if (superseded.changes === 0) throw new CommentRevisionConflictError();

  const [revision] = await db
    .insert(commentRevisions)
    .values({
      commentId: input.commentId,
      revisionNumber: current.revisionNumber + 1,
      body,
      visibility: to,
      createdAt: now,
      createdByActor: actor,
      supersededAt: null,
    })
    .returning();

  await insertMentions(input.workspaceId, input.commentId, revision.id, targets, now);

  void emitEvent({
    eventType: 'workspace.comment_edited',
    entityType: 'referral',
    entityId: referralId,
    actor,
    metadata: {
      workspaceId: input.workspaceId,
      commentId: input.commentId,
      revisionNumber: revision.revisionNumber,
      fromVisibility: from,
      toVisibility: to,
    },
  }).catch((err) => console.error('[CommentService]', err));

  if (to === 'Shared' && from === 'Internal') {
    void emitShared(referralId, input.workspaceId, input.commentId, actor);
  }
  await emitMentionEvents(referralId, input.workspaceId, input.commentId, actor, targets);

  return getComment(input.workspaceId, input.commentId);
}

/**
 * Tombstone. ANY internal user may do this, including to a guest's comment.
 *
 * Deliberate: if a colleague shares an internal note or a piece of PHI by
 * mistake, whoever notices should be able to take it down rather than hunt for
 * the author. Nothing is lost — the row survives, the actor is recorded, and the
 * text stays reachable through getCommentHistory().
 *
 * Idempotent: tombstoning an already-tombstoned comment returns it unchanged.
 */
export async function deleteComment(
  workspaceId: number,
  commentId: number,
  actor: string,
): Promise<Comment> {
  await requireWorkspace(workspaceId);

  const [row] = await db
    .select()
    .from(referralComments)
    .where(and(eq(referralComments.id, commentId), eq(referralComments.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new CommentNotFoundError(commentId);
  if (row.deletedAt !== null) return getComment(workspaceId, commentId);

  await db
    .update(referralComments)
    .set({ deletedAt: new Date(), deletedByActor: actor })
    .where(eq(referralComments.id, commentId));

  void emitEvent({
    eventType: 'workspace.comment_deleted',
    entityType: 'referral',
    entityId: await referralIdFor(workspaceId),
    actor,
    metadata: {
      workspaceId,
      commentId,
      authorKind: row.authorGuestId !== null ? 'guest' : 'user',
      // Whether the actor is removing their own comment or somebody else's is
      // the interesting fact in this event, since anyone internal may do it.
      // Compared against the AUTHOR, not against `deletedByActor`, which is
      // still null at this point by definition.
      ownComment: row.authorUserId !== null && actor === `user:${row.authorUserId}`,
    },
  }).catch((err) => console.error('[CommentService]', err));

  return getComment(workspaceId, commentId);
}

// ── Mentions ─────────────────────────────────────────────────────────────────

/**
 * Who can be mentioned, and what the share confirmation needs to say.
 *
 * Users are the whole ACTIVE ROSTER, not the participant list: nothing
 * internally restricts which workspaces a person may see, so narrowing this to
 * existing participants would block the one gesture that matters — pulling in
 * somebody not yet involved. `isParticipant` is a UI hint, never a filter.
 *
 * `hasLiveInvitation` is what AC7's confirmation reports: a party with a live
 * invitation has somebody who can actually read a shared comment.
 */
export async function mentionTargets(workspaceId: number): Promise<MentionTargets> {
  await requireWorkspace(workspaceId);

  const [roster, participants, parties, liveParties] = await Promise.all([
    listUsers(),
    getParticipants(workspaceId),
    getParties(workspaceId),
    livelyInvitedParties(workspaceId),
  ]);

  const participantIds = new Set(participants.map((p) => p.userId));

  return {
    users: roster.map((u) => ({
      id: u.id,
      displayName: u.displayName,
      jobRole: u.jobRole,
      isParticipant: participantIds.has(u.id),
    })),
    parties: parties.map((p) => ({
      id: p.id,
      orgName: p.orgName,
      partyRole: p.partyRole,
      hasLiveInvitation: liveParties.has(p.id),
    })),
  };
}

/** Parties with an invitation that is neither revoked, superseded nor expired. */
async function livelyInvitedParties(workspaceId: number): Promise<Set<number>> {
  const rows = await db
    .select({ partyId: workspaceInvitations.partyId, expiresAt: workspaceInvitations.expiresAt })
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        isNull(workspaceInvitations.revokedAt),
        isNull(workspaceInvitations.supersededById),
      ),
    );
  const now = Date.now();
  return new Set(rows.filter((r) => r.expiresAt.getTime() > now).map((r) => r.partyId));
}

/**
 * An OPEN mention is unacknowledged, on the CURRENT revision of a comment that
 * is not tombstoned, and targets a user.
 *
 * The current-revision clause is what makes a retraction work: editing a comment
 * to drop a mention leaves the old row on a superseded revision, where it stops
 * being open without being deleted. A party mention is a routing hint for PRD-27
 * and is never an internal open item.
 */
function openMentionWhere(workspaceId: number): SQL | undefined {
  return and(
    eq(commentMentions.workspaceId, workspaceId),
    isNull(commentMentions.acknowledgedAt),
    isNotNull(commentMentions.mentionedUserId),
    isNull(commentRevisions.supersededAt),
    isNull(referralComments.deletedAt),
  );
}

async function openMentionIds(workspaceId: number, userId?: number): Promise<number[]> {
  const rows = await db
    .select({ id: commentMentions.id })
    .from(commentMentions)
    .innerJoin(commentRevisions, eq(commentRevisions.id, commentMentions.revisionId))
    .innerJoin(referralComments, eq(referralComments.id, commentMentions.commentId))
    .where(
      userId === undefined
        ? openMentionWhere(workspaceId)
        : and(openMentionWhere(workspaceId), eq(commentMentions.mentionedUserId, userId)),
    );
  return rows.map((r) => r.id);
}

/** The source PRD-18's `hasOpenInternalItems()` ORs in. */
export async function hasUnacknowledgedMention(workspaceId: number): Promise<boolean> {
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) return false;
  return (await openMentionIds(workspaceId)).length > 0;
}

export async function openMentionCount(workspaceId: number, userId: number): Promise<number> {
  return (await openMentionIds(workspaceId, userId)).length;
}

/**
 * "I have seen the conversation." Clears every open mention of this user on this
 * workspace in one gesture, which is the unit people actually act in.
 */
export async function acknowledgeMentions(
  workspaceId: number,
  userId: number,
  actor: string,
): Promise<number> {
  await requireWorkspace(workspaceId);
  const ids = await openMentionIds(workspaceId, userId);
  if (ids.length === 0) return 0;

  await db
    .update(commentMentions)
    .set({ acknowledgedAt: new Date(), acknowledgedByActor: actor })
    .where(inArray(commentMentions.id, ids));

  void emitEvent({
    eventType: 'workspace.comment_mention_acknowledged',
    entityType: 'referral',
    entityId: await referralIdFor(workspaceId),
    actor,
    metadata: { workspaceId, userId, count: ids.length },
  }).catch((err) => console.error('[CommentService]', err));

  return ids.length;
}

// ── Events ───────────────────────────────────────────────────────────────────

function emitShared(
  referralId: number,
  workspaceId: number,
  commentId: number,
  actor: string,
): void {
  void emitEvent({
    eventType: 'workspace.comment_shared',
    entityType: 'referral',
    entityId: referralId,
    actor,
    metadata: { workspaceId, commentId },
  }).catch((err) => console.error('[CommentService]', err));
}

/** One event per mention, carrying the target, for PRD-27 to act on. */
async function emitMentionEvents(
  referralId: number,
  workspaceId: number,
  commentId: number,
  actor: string,
  targets: { users: number[]; parties: number[] },
): Promise<void> {
  for (const userId of targets.users) {
    await emitEvent({
      eventType: 'workspace.comment_mention',
      entityType: 'referral',
      entityId: referralId,
      actor,
      metadata: { workspaceId, commentId, mentionedKind: 'user', mentionedUserId: userId },
    }).catch((err) => console.error('[CommentService]', err));

    // PRD-27 AC8: the MENTIONED USER ONLY, never the participant list. A
    // mention that notified everybody would make @-mentioning meaningless —
    // and the whole point of the ack in PRD-22 is that it is addressed to one
    // person.
    void (async (): Promise<void> => {
      const { notifyMention } = await import('./notificationService');
      const actorUserId = actor.startsWith('user:') ? Number(actor.slice(5)) : undefined;
      await notifyMention(workspaceId, userId, actor, Number.isNaN(actorUserId) ? undefined : actorUserId);
    })().catch((err) => console.error('[CommentService] mention notification failed', err));
  }
  for (const partyId of targets.parties) {
    await emitEvent({
      eventType: 'workspace.comment_mention',
      entityType: 'referral',
      entityId: referralId,
      actor,
      metadata: { workspaceId, commentId, mentionedKind: 'party', mentionedPartyId: partyId },
    }).catch((err) => console.error('[CommentService]', err));
  }
}
