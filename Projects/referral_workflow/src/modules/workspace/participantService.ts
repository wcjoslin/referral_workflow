/**
 * PRD-24 — the internal people on a workspace beyond the owner.
 *
 * A PARTICIPANT is internal staff. Parties are the other thing (partyService),
 * and the two never mix: a party is never a row here and never a row in `users`.
 *
 * ROLES ARE STORED, NOT ENFORCED. Nothing in this module or anywhere else reads
 * `role` to make an access decision. PRD-20 (queue membership as the PHI
 * boundary) and PRD-30 (guest scoping) are what turn `Viewer` into a security
 * boundary. Until then it is a label on a roster, and treating it as a control
 * would be a bug — a confident-looking one, which is why this is stated twice.
 *
 * SOFT REMOVAL. `removed_at` is set rather than the row deleted, so a removed
 * participant keeps everything they authored. Re-adding them revives that row
 * instead of inserting a second: the unique index is `(workspace_id, user_id)`
 * with `removed_at` deliberately out of it, and the participant_added /
 * participant_removed events are the history. Same position as PRD-21 — the
 * audit log is the record, the table holds current state.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { referralWorkspaces, users, workspaceParticipants } from '../../db/schema';
import { emitEvent } from '../analytics/eventService';
import { ActingUser, JobRole, formatActor } from './identityService';

export type ParticipantRole = 'Manager' | 'Collaborator' | 'Viewer';

export const PARTICIPANT_ROLES: readonly ParticipantRole[] = [
  'Manager',
  'Collaborator',
  'Viewer',
];

export function isParticipantRole(value: string): value is ParticipantRole {
  return (PARTICIPANT_ROLES as readonly string[]).includes(value);
}

export interface Participant {
  id: number;
  userId: number;
  displayName: string;
  jobRole: JobRole;
  role: ParticipantRole;
  addedAt: Date;
  addedByDisplayName: string | null;
  /** True when this person has since been deactivated. Still listed, marked. */
  inactive: boolean;
  /** True when they are also the workspace owner, who cannot be removed. */
  isOwner: boolean;
}

export class ParticipantUserNotFoundError extends Error {
  constructor(userId: number) {
    super(`No active user with id ${userId}`);
    this.name = 'ParticipantUserNotFoundError';
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(workspaceId: number) {
    super(`No workspace with id ${workspaceId}`);
    this.name = 'WorkspaceNotFoundError';
  }
}

/** The owner is a Manager participant by definition and cannot be removed. */
export class CannotRemoveOwnerError extends Error {
  constructor(userId: number) {
    super(`User ${userId} owns this workspace and cannot be removed as a participant`);
    this.name = 'CannotRemoveOwnerError';
  }
}

async function ownerOf(workspaceId: number): Promise<number | null> {
  const [row] = await db
    .select({ ownerUserId: referralWorkspaces.ownerUserId, referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  if (!row) throw new WorkspaceNotFoundError(workspaceId);
  return row.ownerUserId;
}

async function referralIdFor(workspaceId: number): Promise<number> {
  const [row] = await db
    .select({ referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  return row?.referralId ?? 0;
}

/** Managers first, then Collaborators, then Viewers; by added date within a role. */
const ROLE_ORDER: Record<ParticipantRole, number> = { Manager: 0, Collaborator: 1, Viewer: 2 };

export async function getParticipants(workspaceId: number): Promise<Participant[]> {
  if (!Number.isInteger(workspaceId)) return [];

  const rows = await db
    .select({
      id: workspaceParticipants.id,
      userId: workspaceParticipants.userId,
      role: workspaceParticipants.role,
      addedAt: workspaceParticipants.addedAt,
      addedByUserId: workspaceParticipants.addedByUserId,
      displayName: users.displayName,
      jobRole: users.jobRole,
      active: users.active,
    })
    .from(workspaceParticipants)
    .innerJoin(users, eq(users.id, workspaceParticipants.userId))
    .where(
      and(
        eq(workspaceParticipants.workspaceId, workspaceId),
        isNull(workspaceParticipants.removedAt),
      ),
    )
    .orderBy(asc(workspaceParticipants.addedAt));

  const currentOwner = await ownerOf(workspaceId).catch(() => null);

  // One extra query resolves every "added by" name, rather than one per row.
  const adderIds = [...new Set(rows.map((r) => r.addedByUserId).filter((id): id is number => id !== null))];
  const adderNames = new Map<number, string>();
  for (const id of adderIds) {
    const [row] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (row) adderNames.set(id, row.displayName);
  }

  return rows
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      displayName: r.displayName,
      jobRole: r.jobRole as JobRole,
      role: r.role as ParticipantRole,
      addedAt: r.addedAt,
      addedByDisplayName: r.addedByUserId === null ? null : adderNames.get(r.addedByUserId) ?? null,
      inactive: !r.active,
      isOwner: currentOwner !== null && currentOwner === r.userId,
    }))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.addedAt.getTime() - b.addedAt.getTime());
}

/**
 * Adds a participant, or updates the role of one already present.
 *
 * Idempotent on `userId` (AC12). Three cases, all landing on one row:
 * a genuinely new person is inserted; a present person has their role updated;
 * a previously REMOVED person is revived rather than duplicated.
 */
export async function addParticipant(
  workspaceId: number,
  userId: number,
  role: ParticipantRole,
  actor: ActingUser,
): Promise<Participant> {
  await ownerOf(workspaceId); // throws WorkspaceNotFoundError for an unknown id

  // Inactive users cannot be added, the same rule PRD-21 applies to assignment:
  // handing work to somebody who has left is not a thing to allow on purpose.
  const [target] = await db
    .select({ id: users.id, active: users.active })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!target || !target.active) throw new ParticipantUserNotFoundError(userId);

  const [existing] = await db
    .select()
    .from(workspaceParticipants)
    .where(
      and(
        eq(workspaceParticipants.workspaceId, workspaceId),
        eq(workspaceParticipants.userId, userId),
      ),
    )
    .limit(1);

  const now = new Date();
  const referralId = await referralIdFor(workspaceId);

  if (existing) {
    const revived = existing.removedAt !== null;
    const roleChanged = existing.role !== role;

    if (!revived && !roleChanged) {
      // Nothing to do and nothing to say. Emitting here would fill the activity
      // feed with identical "added" rows on every repeated call.
      return await requireParticipant(workspaceId, userId);
    }

    await db
      .update(workspaceParticipants)
      .set({ role, removedAt: null, ...(revived ? { addedAt: now, addedByUserId: actor.id } : {}) })
      .where(eq(workspaceParticipants.id, existing.id));

    void emitEvent({
      eventType: revived ? 'workspace.participant_added' : 'workspace.participant_role_changed',
      entityType: 'referral',
      entityId: referralId,
      ...(roleChanged ? { fromState: existing.role, toState: role } : {}),
      actor: formatActor(actor),
      metadata: { workspaceId, userId, role, ...(revived ? { revived: true } : {}) },
    }).catch((err) => console.error('[ParticipantService]', err));

    return await requireParticipant(workspaceId, userId);
  }

  await db.insert(workspaceParticipants).values({
    workspaceId,
    userId,
    role,
    addedByUserId: actor.id,
    addedAt: now,
    removedAt: null,
  });

  void emitEvent({
    eventType: 'workspace.participant_added',
    entityType: 'referral',
    entityId: referralId,
    toState: role,
    actor: formatActor(actor),
    metadata: { workspaceId, userId, role, self: actor.id === userId },
  }).catch((err) => console.error('[ParticipantService]', err));

  return await requireParticipant(workspaceId, userId);
}

async function requireParticipant(workspaceId: number, userId: number): Promise<Participant> {
  const found = (await getParticipants(workspaceId)).find((p) => p.userId === userId);
  if (!found) throw new ParticipantUserNotFoundError(userId);
  return found;
}

/**
 * Soft-removes a participant. Refuses the current owner (AC10): the owner is
 * accountable for the workspace, so removing them from its roster would leave
 * the accountable person off the list of people involved.
 */
export async function removeParticipant(
  workspaceId: number,
  userId: number,
  actor: ActingUser,
): Promise<void> {
  const currentOwner = await ownerOf(workspaceId);
  if (currentOwner !== null && currentOwner === userId) {
    throw new CannotRemoveOwnerError(userId);
  }

  const [existing] = await db
    .select()
    .from(workspaceParticipants)
    .where(
      and(
        eq(workspaceParticipants.workspaceId, workspaceId),
        eq(workspaceParticipants.userId, userId),
        isNull(workspaceParticipants.removedAt),
      ),
    )
    .limit(1);
  // Removing somebody who is not there is a no-op, not an error: the caller's
  // intent is already satisfied. Same reasoning as PRD-21's release.
  if (!existing) return;

  await db
    .update(workspaceParticipants)
    .set({ removedAt: new Date() })
    .where(eq(workspaceParticipants.id, existing.id));

  void emitEvent({
    eventType: 'workspace.participant_removed',
    entityType: 'referral',
    entityId: await referralIdFor(workspaceId),
    fromState: existing.role,
    actor: formatActor(actor),
    metadata: { workspaceId, userId, role: existing.role },
  }).catch((err) => console.error('[ParticipantService]', err));
}

/**
 * Ensures the workspace owner is on the roster as a Manager (AC10).
 *
 * Called on assignment rather than computed on read, so the roster is a real
 * list rather than a list plus an implicit extra member that every consumer has
 * to remember to add.
 */
export async function syncOwnerParticipant(
  workspaceId: number,
  ownerUserId: number,
  actor: ActingUser,
): Promise<void> {
  const [target] = await db
    .select({ active: users.active })
    .from(users)
    .where(eq(users.id, ownerUserId))
    .limit(1);
  // An owner deactivated after assignment stays the owner (PRD-21 AC7a), so
  // this must not throw for them — it simply has nothing to add.
  if (!target || !target.active) return;
  await addParticipant(workspaceId, ownerUserId, 'Manager', actor);
}

/**
 * Everyone inside this organization who should hear about the workspace.
 *
 * The owner plus every participant, Viewers INCLUDED — a Viewer was added
 * because somebody wanted them to see it, and silently excluding them from
 * notifications would defeat that. Parties are EXCLUDED: an external
 * organization is notified through PRD-30's guest mechanism, never by dropping
 * their address into an internal notification list.
 *
 * Returns user ids, deduplicated. PRD-27 turns them into recipients.
 */
export async function resolveNotificationRecipients(workspaceId: number): Promise<number[]> {
  if (!Number.isInteger(workspaceId)) return [];

  const recipients = new Set<number>();

  const owner = await ownerOf(workspaceId).catch(() => null);
  if (owner !== null) recipients.add(owner);

  for (const participant of await getParticipants(workspaceId)) {
    // A deactivated person gets no notifications; they are still shown on the
    // roster, because they were genuinely involved, but mail to them is waste.
    if (!participant.inactive) recipients.add(participant.userId);
  }

  return [...recipients].sort((a, b) => a - b);
}
