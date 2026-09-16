/**
 * PRD-21 — ownership and assignment.
 *
 * One accountable owner per workspace, or an explicitly visible unassigned
 * state. Four actions — assign, reassign, claim, release — each attributable and
 * each leaving a from→to audit row.
 *
 * THIS MODULE IS THE ONLY WRITER OF `owner_user_id`. Keeping the column out of
 * every other update statement is what makes "no ownership change without an
 * event" true by construction rather than by convention. If you find yourself
 * needing to set it elsewhere, call in here instead.
 *
 * NOT the dispositioning clinician. `referrals.clinician_id` records who
 * accepted or declined; that person and the workspace owner are frequently
 * different, and conflating them would lose both facts.
 *
 * Emits but never notifies. PRD-27 subscribes to these events; no mail
 * transport is reachable from here.
 *
 * ACTOR CONVENTION, deliberately different from workspaceService: every function
 * there takes a pre-formatted `actor: string`. These take the whole
 * `ActingUser`, because claiming needs the actor's *id* as the new owner, not
 * just a label for the audit row. `formatActor()` converts at the emit boundary.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { referralWorkspaces, referrals, patients } from '../../db/schema';
import { emitEvent } from '../analytics/eventService';
import { ReferralState } from '../../state/referralStateMachine';
import { WorkStatus } from '../../state/workStatusMachine';
import { ActingUser, formatActor, getUser } from './identityService';
import { Workspace, getWorkspace } from './workspaceService';
import { syncOwnerParticipant } from './participantService';

/** Unknown id, or a user whose `active` flag is false. */
export class OwnerNotFoundError extends Error {
  constructor(userId: number) {
    super(`No active user with id ${userId}`);
    this.name = 'OwnerNotFoundError';
  }
}

export class WorkspaceArchivedError extends Error {
  constructor(workspaceId: number) {
    super(`Workspace ${workspaceId} is archived and read-only`);
    this.name = 'WorkspaceArchivedError';
  }
}

/**
 * Release needs a reason once work has actually started. In `Triage` nobody has
 * committed to anything yet, so putting it back is not a decision that needs
 * explaining.
 */
export class ReleaseReasonRequiredError extends Error {
  constructor(workStatus: WorkStatus) {
    super(`Releasing a workspace in ${workStatus} requires a reason`);
    this.name = 'ReleaseReasonRequiredError';
  }
}

/** A claim that lost the race. Carries the winner so the message can name them. */
export class OwnershipConflictError extends Error {
  constructor(
    readonly currentOwnerUserId: number,
    readonly currentOwnerDisplayName: string,
  ) {
    super(`Already claimed by ${currentOwnerDisplayName}`);
    this.name = 'OwnershipConflictError';
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(workspaceId: number) {
    super(`No workspace with id ${workspaceId}`);
    this.name = 'WorkspaceNotFoundError';
  }
}

export interface OwnershipResult {
  workspaceId: number;
  ownerUserId: number | null;
  ownerDisplayName: string | null;
  /** False for a no-op — assigning the owner who already holds it. */
  changed: boolean;
}

export interface MyWorkItem {
  workspaceId: number;
  referralId: number;
  patientName: string;
  workStatus: WorkStatus;
  referralState: ReferralState;
  nextAction: string | null;
  /** Always null until PRD-26 populates it. */
  nextActionDueAt: Date | null;
  /** Therefore always false until PRD-26. Kept so the shape does not change then. */
  overdue: boolean;
}

/** Shared guard: the workspace must exist and must not be archived. */
async function loadAssignable(workspaceId: number): Promise<Workspace> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new WorkspaceNotFoundError(workspaceId);
  if (workspace.archivedAt !== null) throw new WorkspaceArchivedError(workspaceId);
  return workspace;
}

/**
 * Assignment is allowed in every work status, including `Resolved` and
 * `Exception`, and on a `Closed-Confirmed` referral — somebody still owns
 * follow-up on a closed loop. Only archival refuses.
 */
export async function assignOwner(
  workspaceId: number,
  toUserId: number,
  actor: ActingUser,
  reason?: string,
): Promise<OwnershipResult> {
  const workspace = await loadAssignable(workspaceId);

  const target = await getUser(toUserId);
  // getUser() returns inactive users on purpose, so the active check is ours.
  if (!target || !target.active) throw new OwnerNotFoundError(toUserId);

  // AC6: reassigning the current owner writes nothing and emits nothing. An
  // event storm of identical reassignments makes the activity feed useless.
  if (workspace.ownerUserId === toUserId) {
    return {
      workspaceId,
      ownerUserId: toUserId,
      ownerDisplayName: target.displayName,
      changed: false,
    };
  }

  const previousOwnerUserId = workspace.ownerUserId;
  const now = new Date();
  await db
    .update(referralWorkspaces)
    .set({ ownerUserId: toUserId, updatedAt: now })
    .where(eq(referralWorkspaces.id, workspaceId));

  // First owner is an assignment; replacing one is a reassignment. Two event
  // types rather than one with a nullable field, because PRD-27 will want to
  // notify differently and PRD-25 renders them differently.
  void emitEvent({
    eventType: previousOwnerUserId === null ? 'workspace.assigned' : 'workspace.reassigned',
    entityType: 'referral',
    entityId: workspace.referralId,
    actor: formatActor(actor),
    metadata: {
      workspaceId,
      fromOwnerUserId: previousOwnerUserId,
      toOwnerUserId: toUserId,
      self: actor.id === toUserId,
      ...(reason ? { reason } : {}),
    },
  }).catch((err) => console.error('[AssignmentService]', err));

  // PRD-27 AC1/AC3. Fire-and-forget, so a mail failure cannot roll back an
  // assignment, and `excludeUserId` inside notify() is what makes AC2 true —
  // assigning yourself notifies nobody.
  void (async (): Promise<void> => {
    const { notifyAssignment, notifyUnassignment } = await import('./notificationService');
    await notifyAssignment(workspaceId, toUserId, actor.id, actor.displayName);
    // A REASSIGNMENT also takes the referral off whoever held it. AC3 wants
    // them told, and only reassignment reaches this — a first assignment has
    // no previous owner to notify.
    if (previousOwnerUserId !== null && previousOwnerUserId !== toUserId) {
      await notifyUnassignment(workspaceId, previousOwnerUserId, actor.id, actor.displayName);
    }
  })().catch((err) => console.error('[AssignmentService] assignment notification failed', err));

  // PRD-24 AC10: the owner is a Manager participant. Recorded here rather than
  // computed when the roster is read, so the roster is a real list instead of a
  // list plus an implicit extra member every consumer must remember to add.
  //
  // AFTER the assignment event, not before, so the activity feed reads
  // "assigned to X" and then "X added as Manager" rather than the reverse.
  // A previous owner is deliberately NOT removed — they stay on the roster,
  // because they really were involved.
  await syncOwnerParticipant(workspaceId, toUserId, actor);

  return {
    workspaceId,
    ownerUserId: toUserId,
    ownerDisplayName: target.displayName,
    changed: true,
  };
}

/**
 * Claims an unassigned workspace for the acting user.
 *
 * The write is a single CONDITIONAL statement — `WHERE owner_user_id IS NULL` —
 * and the rows-changed count decides the outcome. This is not incidental: a
 * read-then-write cannot make "exactly one of two claims wins" true, because the
 * await between reading a null owner and writing is exactly where a second
 * claim slips in. Both would then believe they owned it, and both would emit.
 */
export async function claimOwnership(
  workspaceId: number,
  actor: ActingUser,
): Promise<OwnershipResult> {
  await loadAssignable(workspaceId);

  const updated = await db
    .update(referralWorkspaces)
    .set({ ownerUserId: actor.id, updatedAt: new Date() })
    .where(and(eq(referralWorkspaces.id, workspaceId), isNull(referralWorkspaces.ownerUserId)))
    .returning();

  if (updated.length === 0) {
    // Somebody else won, or it was already owned. Re-read to name them.
    const current = await getWorkspace(workspaceId);
    const holder = current?.ownerUserId == null ? null : await getUser(current.ownerUserId);
    throw new OwnershipConflictError(
      current?.ownerUserId ?? -1,
      holder?.displayName ?? 'another user',
    );
  }

  const row = updated[0];
  void emitEvent({
    eventType: 'workspace.assigned',
    entityType: 'referral',
    entityId: row.referralId,
    actor: formatActor(actor),
    metadata: {
      workspaceId,
      fromOwnerUserId: null,
      toOwnerUserId: actor.id,
      self: true,
    },
  }).catch((err) => console.error('[AssignmentService]', err));

  await syncOwnerParticipant(workspaceId, actor.id, actor);

  return {
    workspaceId,
    ownerUserId: actor.id,
    ownerDisplayName: actor.displayName,
    changed: true,
  };
}

/**
 * Clears the owner, leaving the owning queue intact — releasing work is not
 * re-routing it.
 */
export async function releaseOwnership(
  workspaceId: number,
  actor: ActingUser,
  reason?: string,
): Promise<OwnershipResult> {
  const workspace = await loadAssignable(workspaceId);

  const trimmed = reason?.trim();
  if (!trimmed && workspace.workStatus !== WorkStatus.TRIAGE) {
    throw new ReleaseReasonRequiredError(workspace.workStatus);
  }

  // Releasing an already-unassigned workspace is a no-op, not an error: the
  // caller's intent is already satisfied.
  if (workspace.ownerUserId === null) {
    return { workspaceId, ownerUserId: null, ownerDisplayName: null, changed: false };
  }

  const previousOwnerUserId = workspace.ownerUserId;
  await db
    .update(referralWorkspaces)
    .set({ ownerUserId: null, updatedAt: new Date() })
    .where(eq(referralWorkspaces.id, workspaceId));

  void emitEvent({
    eventType: 'workspace.released',
    entityType: 'referral',
    entityId: workspace.referralId,
    actor: formatActor(actor),
    metadata: {
      workspaceId,
      fromOwnerUserId: previousOwnerUserId,
      ...(trimmed ? { reason: trimmed } : {}),
    },
  }).catch((err) => console.error('[AssignmentService]', err));

  // AC3: the previous owner is told when somebody ELSE took it off them.
  // Releasing your own work needs no telling, which notify()'s excludeUserId
  // handles.
  if (previousOwnerUserId !== null) {
    void (async (): Promise<void> => {
      const { notifyUnassignment } = await import('./notificationService');
      await notifyUnassignment(workspaceId, previousOwnerUserId, actor.id, actor.displayName);
    })().catch((err) => console.error('[AssignmentService] release notification failed', err));
  }

  return { workspaceId, ownerUserId: null, ownerDisplayName: null, changed: true };
}

/**
 * Everything the given user currently owns, excluding archived workspaces.
 *
 * ORDERING, stated plainly: the intended order is due date ascending with nulls
 * last, then created date. `next_action_due_at` is populated by PRD-26, so in
 * Phase 2 every value is null and the created-date clause does all the real
 * work. The due-date clause is present so PRD-26 needs no change here — but a
 * test asserting it today would be asserting nothing.
 */
export async function getMyWork(userId: number): Promise<MyWorkItem[]> {
  if (!Number.isInteger(userId)) return [];

  const rows = await db
    .select({
      workspaceId: referralWorkspaces.id,
      referralId: referralWorkspaces.referralId,
      workStatus: referralWorkspaces.workStatus,
      nextAction: referralWorkspaces.nextAction,
      nextActionDueAt: referralWorkspaces.nextActionDueAt,
      referralState: referrals.state,
      createdAt: referralWorkspaces.createdAt,
      firstName: patients.firstName,
      lastName: patients.lastName,
    })
    .from(referralWorkspaces)
    .innerJoin(referrals, eq(referrals.id, referralWorkspaces.referralId))
    .innerJoin(patients, eq(patients.id, referrals.patientId))
    .where(and(eq(referralWorkspaces.ownerUserId, userId), isNull(referralWorkspaces.archivedAt)))
    .orderBy(asc(referralWorkspaces.createdAt));

  const now = Date.now();

  // Nulls-last cannot be expressed portably in the query builder here, so the
  // due-date ordering is applied in memory over an already-filtered set. It is
  // one user's open work, not a table scan.
  return rows
    .map((r) => ({
      workspaceId: r.workspaceId,
      referralId: r.referralId,
      patientName: `${r.firstName} ${r.lastName}`.trim(),
      workStatus: r.workStatus as WorkStatus,
      referralState: r.referralState as ReferralState,
      nextAction: r.nextAction,
      nextActionDueAt: r.nextActionDueAt,
      overdue: r.nextActionDueAt !== null && r.nextActionDueAt.getTime() < now,
      _createdAt: r.createdAt.getTime(),
    }))
    .sort((a, b) => {
      const da = a.nextActionDueAt?.getTime() ?? Number.POSITIVE_INFINITY;
      const dbb = b.nextActionDueAt?.getTime() ?? Number.POSITIVE_INFINITY;
      if (da !== dbb) return da - dbb;
      return a._createdAt - b._createdAt;
    })
    .map(({ _createdAt, ...item }) => item);
}
