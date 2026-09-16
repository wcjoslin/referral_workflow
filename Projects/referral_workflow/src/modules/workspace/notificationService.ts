/**
 * PRD-27 — notifications.
 *
 * Before this the application could not tell anyone anything: no table, no
 * badge, no bell, no digest. Outbound email existed only as protocol transport.
 * That was workable while every action was initiated by whoever was looking at
 * the screen, and every collaboration feature in this epic breaks that
 * assumption — assignment means work arrives for someone who is not looking,
 * a mention is pointless if the mentioned person never learns of it, and an
 * overdue action is a fact nobody sees.
 *
 * ── ONE ENTRY POINT ─────────────────────────────────────────────────────────
 *
 * Every trigger calls `notify()`. Not one insert statement lives anywhere else,
 * and that is what makes muting, collapsing and the guest allow list
 * enforceable in ONE place rather than re-argued in seven services.
 *
 * ── THE GUEST BOUNDARY IS AN ALLOW LIST ─────────────────────────────────────
 *
 * `GUEST_ELIGIBLE_TYPES` names the only types a guest may ever receive.
 * Anything not in it is invisible to guests **by default**, so a new internal
 * type added later cannot leak by omission. A deny list cannot give that
 * property — it only protects against the cases someone already thought of.
 *
 * ── EMAIL BODIES CARRY NO CLINICAL CONTENT ──────────────────────────────────
 *
 * Patient name, organization, a link. The content lives behind the link, which
 * is the same discipline PRD-30 applies to the invitation email. `notify()`
 * builds the body, so there is no per-caller opportunity to get this wrong.
 *
 * ── NEVER FAILS A USER ACTION ───────────────────────────────────────────────
 *
 * Called fire-and-forget with the `void notify(...).catch(...)` idiom, like
 * `emitEvent()`. A mail failure must not roll back an assignment.
 */

import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db';
import { config } from '../../config';
import {
  notificationPreferences,
  notifications,
  patients,
  queueMembers,
  referralWorkspaces,
  referrals,
  workspaceGuests,
  workspaceInvitations,
  workspaceParties,
  workspaceParticipants,
} from '../../db/schema';
import { sendMail } from '../messaging/mailer';

export type NotificationType =
  | 'assignment'
  | 'unassignment'
  | 'state_change'
  | 'pending_response'
  | 'response_received'
  | 'new_document'
  | 'mention'
  | 'overdue'
  | 'exception'
  | 'guest_invited'
  | 'guest_activity'
  | 'shared_activity';

export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  'assignment',
  'unassignment',
  'state_change',
  'pending_response',
  'response_received',
  'new_document',
  'mention',
  'overdue',
  'exception',
  'guest_invited',
  'guest_activity',
  'shared_activity',
];

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/**
 * The ONLY notification types a guest may ever receive (AC17).
 *
 * An allow list, and the reason is the one PRD-30 and PRD-25 both give: naming
 * what MAY reach a counterparty fails safe when somebody adds a type, whereas
 * naming what may not only fails for the ones already imagined. Adding an
 * internal type later must be invisible to guests without anyone remembering
 * to update a list, and this is what gives that.
 */
export const GUEST_ELIGIBLE_TYPES: readonly NotificationType[] = [
  'guest_invited',
  'shared_activity',
];

/** Types that go out by email by default, because a guest has no bell to look at. */
const EMAIL_BY_DEFAULT: readonly NotificationType[] = ['guest_invited', 'shared_activity'];

export class GuestIneligibleTypeError extends Error {
  constructor(type: NotificationType) {
    super(
      `${type} is not guest-eligible. A guest may only receive: ${GUEST_ELIGIBLE_TYPES.join(', ')}`,
    );
    this.name = 'GuestIneligibleTypeError';
  }
}

export type NotifyAudience =
  | { kind: 'owner' }
  /** Owner plus every participant. */
  | { kind: 'participants' }
  | { kind: 'users'; userIds: number[] }
  /** Owner, falling back to the queue's managers when unowned (AC9/AC10). */
  | { kind: 'owner-or-queue-managers' }
  | { kind: 'queue-managers' }
  | { kind: 'guest'; guestId: number };

export interface NotifyInput {
  workspaceId: number;
  type: NotificationType;
  title: string;
  body: string;
  linkPath: string;
  triggeredByActor?: string;
  audience: NotifyAudience;
  /**
   * Suppresses a notification to this user — the actor who caused it.
   *
   * AC2's "assigning myself does not notify me", generalised: nobody needs
   * telling about their own action, and self-notification is the fastest way to
   * make a bell worthless.
   */
  excludeUserId?: number;
}

export interface Notification {
  id: number;
  workspaceId: number;
  referralId: number | null;
  notificationType: NotificationType;
  title: string;
  body: string;
  linkPath: string;
  triggeredByActor: string | null;
  collapsedCount: number;
  read: boolean;
  createdAt: string;
  patientName: string | null;
}

// ── Recipient resolution ─────────────────────────────────────────────────────

/**
 * Who should hear about this, resolved AT SEND TIME.
 *
 * Deliberately not captured when the event was emitted: a reassignment between
 * the event and delivery must notify the person who holds the work now, not the
 * one who held it a moment ago.
 */
async function resolveUserRecipients(
  workspaceId: number,
  audience: NotifyAudience,
): Promise<number[]> {
  const [ws] = await db
    .select({ ownerUserId: referralWorkspaces.ownerUserId, queueId: referralWorkspaces.queueId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  if (!ws) return [];

  switch (audience.kind) {
    case 'owner':
      return ws.ownerUserId === null ? [] : [ws.ownerUserId];

    case 'users':
      return audience.userIds;

    case 'participants': {
      const rows = await db
        .select({ userId: workspaceParticipants.userId })
        .from(workspaceParticipants)
        .where(eq(workspaceParticipants.workspaceId, workspaceId));
      const ids = new Set(rows.map((r) => r.userId));
      // The owner is a participant by PRD-24's sync, but ORing them in makes
      // this correct even if that sync has not run.
      if (ws.ownerUserId !== null) ids.add(ws.ownerUserId);
      return [...ids];
    }

    case 'owner-or-queue-managers':
      // AC9/AC10: the owner, or the queue's managers when nobody holds it. An
      // unowned exception with nobody told is the case this exists for.
      if (ws.ownerUserId !== null) return [ws.ownerUserId];
      return queueManagers(ws.queueId);

    case 'queue-managers':
      return queueManagers(ws.queueId);

    case 'guest':
      return [];
  }
}

async function queueManagers(queueId: number | null): Promise<number[]> {
  if (queueId === null) return [];
  const rows = await db
    .select({ userId: queueMembers.userId })
    .from(queueMembers)
    .where(and(eq(queueMembers.queueId, queueId), eq(queueMembers.accessLevel, 'manager')));
  return rows.map((r) => r.userId);
}

// ── Preferences ──────────────────────────────────────────────────────────────

interface Preference {
  muted: boolean;
  emailEnabled: boolean;
}

async function preferenceFor(userId: number, type: NotificationType): Promise<Preference> {
  const [row] = await db
    .select({ muted: notificationPreferences.muted, emailEnabled: notificationPreferences.emailEnabled })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.notificationType, type),
      ),
    )
    .limit(1);
  // No row means default: audible, no email. Internal users have a bell.
  return { muted: row?.muted ?? false, emailEnabled: row?.emailEnabled ?? false };
}

export async function setPreference(
  userId: number,
  type: NotificationType,
  patch: { muted?: boolean; emailEnabled?: boolean },
): Promise<Preference> {
  const current = await preferenceFor(userId, type);
  const next = {
    muted: patch.muted ?? current.muted,
    emailEnabled: patch.emailEnabled ?? current.emailEnabled,
  };
  await db
    .insert(notificationPreferences)
    .values({ userId, notificationType: type, ...next })
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.notificationType],
      set: next,
    });
  return next;
}

export async function listPreferences(userId: number): Promise<
  Array<{ notificationType: NotificationType; muted: boolean; emailEnabled: boolean }>
> {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));
  const byType = new Map(rows.map((r) => [r.notificationType, r]));
  // Every type is listed, not only the ones with a stored row, so the UI shows
  // the full set of switches rather than only those already touched.
  return NOTIFICATION_TYPES.map((t) => ({
    notificationType: t,
    muted: byType.get(t)?.muted ?? false,
    emailEnabled: byType.get(t)?.emailEnabled ?? EMAIL_BY_DEFAULT.includes(t),
  }));
}

// ── The single entry point ───────────────────────────────────────────────────

function collapseKeyFor(
  recipient: { userId?: number; guestId?: number },
  workspaceId: number,
  type: NotificationType,
): string {
  const who = recipient.userId !== undefined ? `u${recipient.userId}` : `g${recipient.guestId}`;
  return `${who}:w${workspaceId}:${type}`;
}

/**
 * Creates the notifications for one event.
 *
 * Order matters and each step is a stated requirement:
 *   1. resolve recipients from CURRENT relationships
 *   2. drop the actor, so nobody is told about their own action
 *   3. drop muted types — NOT created rather than created and hidden, because a
 *      hidden row still shows in a count and the count is what a bell is for
 *   4. collapse into an existing recent row for the same (recipient, workspace,
 *      type) instead of adding another
 *   5. email only when enabled for that type
 */
export async function notify(input: NotifyInput): Promise<number[]> {
  if (input.audience.kind === 'guest') {
    // The allow list, enforced at the funnel. Throwing rather than silently
    // dropping: a caller trying to send an internal type to a guest is a bug in
    // the caller, and swallowing it would hide that.
    if (!GUEST_ELIGIBLE_TYPES.includes(input.type)) {
      throw new GuestIneligibleTypeError(input.type);
    }
    const id = await notifyGuest(input, input.audience.guestId);
    return id === null ? [] : [id];
  }

  const recipients = (await resolveUserRecipients(input.workspaceId, input.audience)).filter(
    (id) => id !== input.excludeUserId,
  );

  const created: number[] = [];
  for (const userId of [...new Set(recipients)]) {
    const pref = await preferenceFor(userId, input.type);
    if (pref.muted) continue;

    const id = await createOrCollapse({ userId }, input);
    if (id === null) continue;
    created.push(id);

    if (pref.emailEnabled) await deliverEmailToUser(userId, input);
  }
  return created;
}

/** Fire-and-forget wrapper, for the call sites on user-action paths. */
export function notifyQuietly(input: NotifyInput): void {
  void notify(input).catch((err) =>
    console.error(`[NotificationService] ${input.type} notification failed`, err),
  );
}

async function createOrCollapse(
  recipient: { userId?: number; guestId?: number },
  input: NotifyInput,
): Promise<number | null> {
  const now = new Date();
  const key = collapseKeyFor(recipient, input.workspaceId, input.type);
  const windowStart = new Date(
    now.getTime() - config.workspace.notificationCollapseWindowMinutes * 60 * 1000,
  );

  // AC13. Only an UNREAD row collapses: once somebody has read a notification,
  // a new event deserves a new one rather than silently bumping a count on
  // something already dismissed.
  const [existing] = await db
    .select({ id: notifications.id, collapsedCount: notifications.collapsedCount })
    .from(notifications)
    .where(
      and(
        eq(notifications.collapseKey, key),
        isNull(notifications.readAt),
        sql`${notifications.createdAt} >= ${Math.floor(windowStart.getTime() / 1000)}`,
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1);

  if (existing) {
    await db
      .update(notifications)
      .set({
        collapsedCount: existing.collapsedCount + 1,
        // Bumped so the collapsed row surfaces as recent activity rather than
        // sinking down the list while still accumulating.
        createdAt: now,
        title: input.title,
        body: input.body,
      })
      .where(eq(notifications.id, existing.id));
    return existing.id;
  }

  const [row] = await db
    .insert(notifications)
    .values({
      recipientUserId: recipient.userId ?? null,
      recipientGuestId: recipient.guestId ?? null,
      workspaceId: input.workspaceId,
      notificationType: input.type,
      title: input.title,
      body: input.body,
      linkPath: input.linkPath,
      triggeredByActor: input.triggeredByActor ?? null,
      collapseKey: key,
      collapsedCount: 1,
      createdAt: now,
    })
    .returning();
  return row.id;
}

/**
 * A guest notification, which is always by email — a guest has no bell.
 *
 * AC18: a revoked or expired guest receives nothing further. Checked HERE at
 * send time rather than trusted from the caller, so no trigger can bypass it.
 */
async function notifyGuest(input: NotifyInput, guestId: number): Promise<number | null> {
  const [guest] = await db
    .select({
      id: workspaceGuests.id,
      workspaceId: workspaceGuests.workspaceId,
      invitationId: workspaceGuests.invitationId,
      sessionExpiresAt: workspaceGuests.sessionExpiresAt,
    })
    .from(workspaceGuests)
    .where(eq(workspaceGuests.id, guestId))
    .limit(1);
  if (!guest) return null;

  // Scope check: a guest is bound to ONE workspace, and a notification for
  // another one is a bug that must not reach them.
  if (guest.workspaceId !== input.workspaceId) {
    console.error(
      `[NotificationService] refusing to notify guest ${guestId} about workspace ${input.workspaceId}; they are bound to ${guest.workspaceId}`,
    );
    return null;
  }

  const [invitation] = await db
    .select({
      recipientEmail: workspaceInvitations.recipientEmail,
      revokedAt: workspaceInvitations.revokedAt,
      expiresAt: workspaceInvitations.expiresAt,
    })
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, guest.invitationId))
    .limit(1);
  if (!invitation) return null;
  if (invitation.revokedAt !== null) return null;
  if (invitation.expiresAt.getTime() < Date.now()) return null;

  const id = await createOrCollapse({ guestId }, input);

  const sent = await sendMail({
    to: invitation.recipientEmail,
    subject: input.title,
    // NO CLINICAL CONTENT. `input.body` is built by the trigger helpers below,
    // which carry the patient name and organization only.
    text: `${input.body}\n\n${config.workspace.publicBaseUrl}${input.linkPath}\n`,
  });
  if (sent && id !== null) {
    await db.update(notifications).set({ emailSentAt: new Date() }).where(eq(notifications.id, id));
  }

  return id;
}

async function deliverEmailToUser(userId: number, input: NotifyInput): Promise<void> {
  const { getUser } = await import('./identityService');
  const user = await getUser(userId);
  // An internal user's Direct address is their mailbox here. Nullable, and most
  // non-clinical staff have none — so no address simply means no email, not an
  // error worth logging on every send.
  if (!user?.directAddress) return;
  const sent = await sendMail({
    to: user.directAddress,
    subject: input.title,
    text: `${input.body}\n\n${config.workspace.publicBaseUrl}${input.linkPath}\n`,
  });
  if (!sent) {
    console.warn(`[NotificationService] email to user ${userId} was not accepted by SMTP`);
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

type Row = typeof notifications.$inferSelect;

function toNotification(
  row: Row,
  extra: { patientName?: string | null; referralId?: number | null } = {},
): Notification {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    referralId: extra.referralId ?? null,
    notificationType: row.notificationType as NotificationType,
    title: row.title,
    body: row.body,
    linkPath: row.linkPath,
    triggeredByActor: row.triggeredByActor,
    collapsedCount: row.collapsedCount,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
    patientName: extra.patientName ?? null,
  };
}

export async function listNotifications(
  userId: number,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<Notification[]> {
  const rows = await db
    .select({
      n: notifications,
      referralId: referralWorkspaces.referralId,
      firstName: patients.firstName,
      lastName: patients.lastName,
    })
    .from(notifications)
    .innerJoin(referralWorkspaces, eq(referralWorkspaces.id, notifications.workspaceId))
    .innerJoin(referrals, eq(referrals.id, referralWorkspaces.referralId))
    .innerJoin(patients, eq(patients.id, referrals.patientId))
    .where(
      and(
        eq(notifications.recipientUserId, userId),
        opts.unreadOnly ? isNull(notifications.readAt) : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit ?? 50);

  return rows.map((r) =>
    toNotification(r.n, {
      referralId: r.referralId,
      patientName: `${r.firstName} ${r.lastName}`.trim(),
    }),
  );
}

export async function getUnreadCount(userId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(notifications)
    .where(and(eq(notifications.recipientUserId, userId), isNull(notifications.readAt)));
  return Number(row?.n ?? 0);
}

/**
 * Marks ONE notification read, scoped to its recipient.
 *
 * AC11: opening the list does not mark everything read. Reading is an explicit
 * act, individually or all at once — a bell that empties itself the moment you
 * glance at it loses the one thing it was for.
 */
export async function markRead(notificationId: number, userId: number): Promise<boolean> {
  const result = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.recipientUserId, userId),
        isNull(notifications.readAt),
      ),
    );
  // Scoped to the recipient, so marking somebody else's notification read is a
  // miss rather than a cross-user write.
  return (result as unknown as { changes?: number }).changes !== 0;
}

export async function markAllRead(userId: number): Promise<number> {
  const result = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.recipientUserId, userId), isNull(notifications.readAt)));
  return (result as unknown as { changes?: number }).changes ?? 0;
}

/**
 * Prunes notifications past the retention period (AC14).
 *
 * Runs in the overdue sweep rather than as a second scheduled job, per the
 * PRD's constraint. Only READ notifications are pruned regardless of age: an
 * unread one is still outstanding work, and silently deleting it would be the
 * notification equivalent of losing a message.
 */
export async function pruneOld(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(
    now.getTime() - config.workspace.notificationRetentionDays * 24 * 60 * 60 * 1000,
  );
  const result = await db
    .delete(notifications)
    .where(and(lt(notifications.createdAt, cutoff), sql`${notifications.readAt} IS NOT NULL`));
  return (result as unknown as { changes?: number }).changes ?? 0;
}

// ── Trigger helpers ──────────────────────────────────────────────────────────
//
// One per source PRD. They exist so the TITLE AND BODY WORDING lives here
// rather than being invented at each call site — which is what keeps the
// no-clinical-content rule checkable in one file instead of seven.

/** Patient name and referring organization only. Never a reason or a diagnosis. */
async function workspaceContext(
  workspaceId: number,
): Promise<{ patientName: string; orgName: string | null; referralId: number } | null> {
  const [row] = await db
    .select({
      referralId: referralWorkspaces.referralId,
      firstName: patients.firstName,
      lastName: patients.lastName,
    })
    .from(referralWorkspaces)
    .innerJoin(referrals, eq(referrals.id, referralWorkspaces.referralId))
    .innerJoin(patients, eq(patients.id, referrals.patientId))
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  if (!row) return null;

  const [party] = await db
    .select({ orgName: workspaceParties.orgName })
    .from(workspaceParties)
    .where(
      and(eq(workspaceParties.workspaceId, workspaceId), eq(workspaceParties.partyRole, 'initiating')),
    )
    .limit(1);

  return {
    patientName: `${row.firstName} ${row.lastName}`.trim(),
    orgName: party?.orgName ?? null,
    referralId: row.referralId,
  };
}

export async function notifyAssignment(
  workspaceId: number,
  newOwnerUserId: number,
  actorUserId: number | null,
  actorLabel: string,
): Promise<void> {
  const ctx = await workspaceContext(workspaceId);
  if (!ctx) return;
  await notify({
    workspaceId,
    type: 'assignment',
    title: `Assigned to you: ${ctx.patientName}`,
    body: `${actorLabel} assigned you the referral for ${ctx.patientName}${
      ctx.orgName ? ` from ${ctx.orgName}` : ''
    }.`,
    linkPath: `/workspaces/${workspaceId}`,
    triggeredByActor: actorLabel,
    audience: { kind: 'users', userIds: [newOwnerUserId] },
    // AC2. Self-assignment notifies nobody.
    excludeUserId: actorUserId ?? undefined,
  });
}

export async function notifyUnassignment(
  workspaceId: number,
  previousOwnerUserId: number,
  actorUserId: number | null,
  actorLabel: string,
): Promise<void> {
  const ctx = await workspaceContext(workspaceId);
  if (!ctx) return;
  await notify({
    workspaceId,
    type: 'unassignment',
    title: `No longer assigned: ${ctx.patientName}`,
    body: `${actorLabel} took the referral for ${ctx.patientName} off you.`,
    linkPath: `/workspaces/${workspaceId}`,
    triggeredByActor: actorLabel,
    audience: { kind: 'users', userIds: [previousOwnerUserId] },
    // AC3 says the previous owner is notified when unassigned BY SOMEONE ELSE.
    // Releasing your own work needs no telling.
    excludeUserId: actorUserId ?? undefined,
  });
}

export async function notifyStateChange(
  workspaceId: number,
  toState: string,
  actorLabel: string,
): Promise<void> {
  const ctx = await workspaceContext(workspaceId);
  if (!ctx) return;
  await notify({
    workspaceId,
    type: 'state_change',
    title: `${ctx.patientName}: now ${toState}`,
    body: `The referral for ${ctx.patientName} moved to ${toState}.`,
    linkPath: `/workspaces/${workspaceId}`,
    triggeredByActor: actorLabel,
    audience: { kind: 'participants' },
  });
}

export async function notifyNewDocument(
  workspaceId: number,
  documentTitle: string,
  actorLabel: string,
  actorUserId?: number,
): Promise<void> {
  const ctx = await workspaceContext(workspaceId);
  if (!ctx) return;
  await notify({
    workspaceId,
    type: 'new_document',
    title: `New document: ${ctx.patientName}`,
    body: `${documentTitle} was added to the referral for ${ctx.patientName}.`,
    linkPath: `/workspaces/${workspaceId}`,
    triggeredByActor: actorLabel,
    audience: { kind: 'participants' },
    excludeUserId: actorUserId,
  });
}

/** AC8: the mentioned user ONLY, never the whole participant list. */
export async function notifyMention(
  workspaceId: number,
  mentionedUserId: number,
  actorLabel: string,
  actorUserId?: number,
): Promise<void> {
  const ctx = await workspaceContext(workspaceId);
  if (!ctx) return;
  await notify({
    workspaceId,
    type: 'mention',
    title: `${actorLabel} mentioned you: ${ctx.patientName}`,
    body: `${actorLabel} mentioned you in the conversation on ${ctx.patientName}'s referral.`,
    linkPath: `/workspaces/${workspaceId}`,
    triggeredByActor: actorLabel,
    audience: { kind: 'users', userIds: [mentionedUserId] },
    excludeUserId: actorUserId,
  });
}

export async function notifyOverdue(
  workspaceId: number,
  nextAction: string,
  hoursOverdue: number,
): Promise<void> {
  const ctx = await workspaceContext(workspaceId);
  if (!ctx) return;
  await notify({
    workspaceId,
    type: 'overdue',
    title: `Overdue: ${ctx.patientName}`,
    body: `"${nextAction}" is ${hoursOverdue}h overdue on ${ctx.patientName}'s referral.`,
    linkPath: `/workspaces/${workspaceId}`,
    triggeredByActor: 'system',
    audience: { kind: 'owner-or-queue-managers' },
  });
}

export async function notifyException(
  workspaceId: number,
  exceptionType: string,
  summary: string,
): Promise<void> {
  const ctx = await workspaceContext(workspaceId);
  if (!ctx) return;
  await notify({
    workspaceId,
    type: 'exception',
    title: `Exception on ${ctx.patientName}: ${exceptionType}`,
    body: summary,
    linkPath: '/exceptions',
    triggeredByActor: 'system',
    audience: { kind: 'owner-or-queue-managers' },
  });
}

/** AC19/AC20: names the party AND the guest, so the reader knows who acted. */
export async function notifyGuestActivity(
  workspaceId: number,
  guestLabel: string,
  orgName: string | null,
  what: string,
): Promise<void> {
  const ctx = await workspaceContext(workspaceId);
  if (!ctx) return;
  await notify({
    workspaceId,
    type: 'guest_activity',
    title: `${orgName ?? 'The counterparty'} acted on ${ctx.patientName}`,
    body: `${guestLabel}${orgName ? ` at ${orgName}` : ''} ${what} on ${ctx.patientName}'s referral.`,
    linkPath: `/workspaces/${workspaceId}`,
    triggeredByActor: guestLabel,
    audience: { kind: 'participants' },
  });
}

/**
 * AC16: a guest learns something was shared. By email, with NO clinical content.
 *
 * Note what the body does NOT contain: the comment text, the document content,
 * or any clinical detail. Only that there is something new, for whom, and a
 * link — the same rule as the invitation email.
 */
export async function notifySharedActivity(
  workspaceId: number,
  guestId: number,
  what: string,
  guestPath: string,
): Promise<void> {
  const ctx = await workspaceContext(workspaceId);
  if (!ctx) return;
  await notify({
    workspaceId,
    type: 'shared_activity',
    title: `New on the referral for ${ctx.patientName}`,
    body:
      `${what} was shared with you on the referral for ${ctx.patientName}` +
      `${ctx.orgName ? ` from ${ctx.orgName}` : ''}. Open the workspace to read it.`,
    linkPath: guestPath,
    audience: { kind: 'guest', guestId },
  });
}

/** Every guest on a workspace who can still be reached. Used by the share paths. */
export async function activeGuestIds(workspaceId: number): Promise<number[]> {
  const rows = await db
    .select({ id: workspaceGuests.id, invitationId: workspaceGuests.invitationId })
    .from(workspaceGuests)
    .where(eq(workspaceGuests.workspaceId, workspaceId));
  if (rows.length === 0) return [];

  const invitations = await db
    .select({
      id: workspaceInvitations.id,
      revokedAt: workspaceInvitations.revokedAt,
      expiresAt: workspaceInvitations.expiresAt,
    })
    .from(workspaceInvitations)
    .where(
      inArray(
        workspaceInvitations.id,
        rows.map((r) => r.invitationId),
      ),
    );
  const live = new Set(
    invitations
      .filter((i) => i.revokedAt === null && i.expiresAt.getTime() >= Date.now())
      .map((i) => i.id),
  );
  return rows.filter((r) => live.has(r.invitationId)).map((r) => r.id);
}
