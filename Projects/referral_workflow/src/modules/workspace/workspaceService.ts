/**
 * Referral Workspace Service (PRD-18)
 *
 * Owns `referral_workspaces` — one row per referral, holding the internal
 * collaboration state. This module is the ONLY writer of `work_status`.
 *
 * The dual-status rule, which everything here exists to protect:
 *   - `referrals.state` is externally authoritative. It changes only through a
 *     valid protocol event, via referralStateMachine.transition().
 *   - `referral_workspaces.work_status` is internal processing. It changes only
 *     through a user action or an internal rule, via workStatusMachine.
 *   - Neither silently overwrites the other. A protocol event may *propose* a
 *     work status; the proposal is advisory and is declined when a person has
 *     taken control.
 *
 * Nothing in this file writes `referrals.state`. Keep it that way.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { referrals, referralWorkspaces } from '../../db/schema';
import { emitEvent } from '../analytics/eventService';
import { ReferralState } from '../../state/referralStateMachine';
import {
  WorkStatus,
  allowedTransitions,
  transition as workStatusTransition,
} from '../../state/workStatusMachine';

export class WorkspaceNotFoundError extends Error {
  constructor(id: number | string) {
    super(`Workspace not found: ${id}`);
    this.name = 'WorkspaceNotFoundError';
  }
}

export class WorkspaceAlreadyExistsError extends Error {
  constructor(referralId: number) {
    super(`Referral ${referralId} already has a workspace`);
    this.name = 'WorkspaceAlreadyExistsError';
  }
}

export class WorkspaceNotArchivableError extends Error {
  constructor(workStatus: WorkStatus, detail: string) {
    super(`Cannot archive a workspace in ${workStatus}: ${detail}`);
    this.name = 'WorkspaceNotArchivableError';
  }
}

export interface Workspace {
  id: number;
  referralId: number;
  externalReferralId: string | null;
  correlationKey: string | null;
  workStatus: WorkStatus;
  workStatusIsManual: boolean;
  workStatusSetBy: string | null;
  workStatusSetAt: Date | null;
  ownerUserId: number | null;
  queueId: number | null;
  nextAction: string | null;
  nextActionDueAt: Date | null;
  exceptionReason: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type WorkspaceRow = typeof referralWorkspaces.$inferSelect;

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    referralId: row.referralId,
    externalReferralId: row.externalReferralId,
    correlationKey: row.correlationKey,
    workStatus: row.workStatus as WorkStatus,
    workStatusIsManual: row.workStatusIsManual,
    workStatusSetBy: row.workStatusSetBy,
    workStatusSetAt: row.workStatusSetAt,
    ownerUserId: row.ownerUserId,
    queueId: row.queueId,
    nextAction: row.nextAction,
    nextActionDueAt: row.nextActionDueAt,
    exceptionReason: row.exceptionReason,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── The advisory protocol → work status mapping ───────────────────────────────

/**
 * What each protocol state suggests the internal work status should be.
 *
 * ADVISORY ONLY. Applied through proposeWorkStatus(), which declines when a
 * person has taken control — see PROPOSAL RULE below. `Closed-Confirmed` is
 * absent because it is the one case that branches on outstanding internal work;
 * proposeWorkStatus() resolves it.
 */
const PROTOCOL_WORK_STATUS: Record<Exclude<ReferralState, 'Closed-Confirmed'>, WorkStatus> = {
  [ReferralState.RECEIVED]: WorkStatus.TRIAGE,
  [ReferralState.ACKNOWLEDGED]: WorkStatus.TRIAGE,
  [ReferralState.PENDING_INFORMATION]: WorkStatus.WAITING_EXTERNAL,
  [ReferralState.ACCEPTED]: WorkStatus.IN_PROGRESS,
  [ReferralState.SCHEDULED]: WorkStatus.WAITING_EXTERNAL,
  [ReferralState.NO_SHOW]: WorkStatus.IN_PROGRESS,
  [ReferralState.ENCOUNTER]: WorkStatus.IN_PROGRESS,
  [ReferralState.CONSULT]: WorkStatus.IN_PROGRESS,
  [ReferralState.DECLINED]: WorkStatus.RESOLVED,
  [ReferralState.CLOSED]: WorkStatus.WAITING_EXTERNAL,
};

/**
 * Statuses a proposal may never overwrite, whatever the manual flag says.
 *
 * A protocol advance must not clear an exception PRD-28 raised, nor quietly
 * discharge outstanding follow-up.
 */
const PROPOSAL_PROTECTED: readonly WorkStatus[] = [
  WorkStatus.EXCEPTION,
  WorkStatus.FOLLOW_UP_REQUIRED,
];

export type ProposalDeclinedReason = 'manual' | 'protected' | 'same-status' | 'archived';

export interface ProposalResult {
  applied: boolean;
  workStatus: WorkStatus;
  proposed: WorkStatus;
  declinedReason?: ProposalDeclinedReason;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getWorkspace(id: number): Promise<Workspace | null> {
  if (!Number.isInteger(id)) return null;
  const [row] = await db
    .select()
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, id))
    .limit(1);
  return row ? toWorkspace(row) : null;
}

export async function getWorkspaceByReferralId(referralId: number): Promise<Workspace | null> {
  if (!Number.isInteger(referralId)) return null;
  const [row] = await db
    .select()
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.referralId, referralId))
    .limit(1);
  return row ? toWorkspace(row) : null;
}

/**
 * Whether this workspace still has internal work outstanding.
 *
 * PHASE-1 DEFINITION, deliberately concrete so it is testable on day one:
 * anything other than `Resolved` counts as open. Evaluated against the status
 * BEFORE a closure proposal is applied — reading the current status to decide
 * what to propose is not circular, because the proposal is about the next value
 * and the check is about the present one.
 *
 * Later PRDs OR additional sources in here without changing any caller:
 * an unresolved `workspace_exceptions` row (PRD-28), an unacknowledged mention
 * (PRD-22). Each of those PRDs owns adding its clause and its test.
 */
export async function hasOpenInternalItems(workspaceId: number): Promise<boolean> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new WorkspaceNotFoundError(workspaceId);
  return workspaceHasOpenItems(workspace);
}

/**
 * The same definition against an already-loaded row, so the closure branch in
 * resolveProposedStatus() does not need a second read — and, more importantly,
 * so there is exactly ONE definition of "open" for a later PRD to extend.
 *
 * When PRD-28 or PRD-22 add a source that requires a query, give this function
 * an async sibling and have hasOpenInternalItems() OR the two together; do not
 * fork the rule.
 */
function workspaceHasOpenItems(workspace: Workspace): boolean {
  return workspace.workStatus !== WorkStatus.RESOLVED;
}

// ── Creation ──────────────────────────────────────────────────────────────────

/**
 * Creates the workspace for a referral. Called from ingestReferral() in the same
 * operation that creates the referral, so a referral without a workspace is not
 * a reachable state.
 *
 * NOTE on auto-decline: `referralService.autoDecline()` writes no referral row
 * at all — it sends an RRI and emits `referral.auto_declined` with
 * `entityId: 0`. There is therefore nothing to attach a workspace to, and this
 * function is never called for that path. That is stated plainly rather than
 * implying a gap; the durable record that makes those decisions reviewable
 * arrives with PRD-28's `auto_declined_referrals` table.
 */
export async function createWorkspace(referralId: number): Promise<Workspace> {
  const existing = await getWorkspaceByReferralId(referralId);
  if (existing) throw new WorkspaceAlreadyExistsError(referralId);

  const now = new Date();
  const [row] = await db
    .insert(referralWorkspaces)
    .values({
      referralId,
      workStatus: WorkStatus.TRIAGE,
      workStatusIsManual: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  void emitEvent({
    eventType: 'workspace.created',
    entityType: 'referral',
    entityId: referralId,
    toState: WorkStatus.TRIAGE,
    actor: 'system',
    metadata: { workspaceId: row.id },
  }).catch((err) => console.error('[WorkspaceService]', err));

  return toWorkspace(row);
}

// ── Work status writes ────────────────────────────────────────────────────────

/**
 * The ONLY writer of `work_status`. Guards through the machine, updates, emits.
 *
 * Sets `workStatusIsManual = true`: once an actor has set the status explicitly,
 * protocol progress stops rewriting it until resyncWorkStatus() clears the flag.
 * That stickiness is the intended behaviour, not a limitation.
 */
export async function setWorkStatus(
  workspaceId: number,
  next: WorkStatus,
  actor: string,
  reason?: string,
): Promise<Workspace> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

  // Throws InvalidWorkStatusTransitionError and writes nothing.
  workStatusTransition(workspace.workStatus, next);

  return applyWorkStatus(workspace, next, actor, true, reason);
}

/**
 * Shared write path for both a manual set and an applied proposal, so there is
 * exactly one place that touches the column.
 */
async function applyWorkStatus(
  workspace: Workspace,
  next: WorkStatus,
  actor: string,
  isManual: boolean,
  reason?: string,
): Promise<Workspace> {
  const now = new Date();
  const [row] = await db
    .update(referralWorkspaces)
    .set({
      workStatus: next,
      workStatusIsManual: isManual,
      workStatusSetBy: actor,
      workStatusSetAt: now,
      updatedAt: now,
    })
    .where(eq(referralWorkspaces.id, workspace.id))
    .returning();

  void emitEvent({
    eventType: 'workspace.work_status_changed',
    entityType: 'referral',
    entityId: workspace.referralId,
    fromState: workspace.workStatus,
    toState: next,
    actor,
    metadata: {
      workspaceId: workspace.id,
      manual: isManual,
      ...(reason ? { reason } : {}),
    },
  }).catch((err) => console.error('[WorkspaceService]', err));

  return toWorkspace(row);
}

/**
 * Called from every protocol transition site.
 *
 * Derives the proposed status from `protocolState` — including the
 * `Closed-Confirmed` → `Resolved` | `Follow-up-Required` branch, computed HERE
 * so each call site stays a one-liner and the mapping lives in one place. No
 * caller may compute a proposed status itself, or the "never silently overwrite"
 * rule becomes unenforceable in review.
 *
 * PROPOSAL RULE — the proposal applies if and only if:
 *
 *     workStatusIsManual === false
 *       AND current status ∉ { Exception, Follow-up-Required }
 *
 * Otherwise nothing is written and `workspace.work_status_proposal_declined`
 * records the proposal, the current status and which condition declined it.
 *
 * (The first draft of PRD-18 said a proposal applies "only when the work status
 * has not been manually set since the last protocol event". That is
 * unimplementable: this function is only ever called *from* a protocol
 * transition, so the condition is always true and the declined path would be
 * unreachable.)
 */
export async function proposeWorkStatus(
  workspaceId: number,
  protocolState: ReferralState,
  actor = 'system',
): Promise<ProposalResult> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

  const proposed = resolveProposedStatus(workspace, protocolState);
  return applyProposal(workspace, proposed, actor);
}

/** Resolves the mapping, including the closure branch. */
function resolveProposedStatus(workspace: Workspace, protocolState: ReferralState): WorkStatus {
  if (protocolState === ReferralState.CLOSED_CONFIRMED) {
    // The protocol lifecycle has closed. If internal work is still outstanding
    // the workspace stays visible as Follow-up-Required — the external state is
    // never reopened to represent internal work.
    return workspaceHasOpenItems(workspace) ? WorkStatus.FOLLOW_UP_REQUIRED : WorkStatus.RESOLVED;
  }
  return PROTOCOL_WORK_STATUS[protocolState];
}

async function applyProposal(
  workspace: Workspace,
  proposed: WorkStatus,
  actor: string,
): Promise<ProposalResult> {
  const decline = (declinedReason: ProposalDeclinedReason): ProposalResult => {
    // 'same-status' is a genuine no-op, not a judgement call — do not spend an
    // audit row on it.
    if (declinedReason !== 'same-status') {
      void emitEvent({
        eventType: 'workspace.work_status_proposal_declined',
        entityType: 'referral',
        entityId: workspace.referralId,
        actor,
        metadata: {
          workspaceId: workspace.id,
          proposed,
          current: workspace.workStatus,
          declinedReason,
        },
      }).catch((err) => console.error('[WorkspaceService]', err));
    }
    return { applied: false, workStatus: workspace.workStatus, proposed, declinedReason };
  };

  // 'same-status' is checked FIRST, before the flags. A proposal that asks for
  // the status the workspace already holds is a no-op whatever else is true of
  // it — reporting that as 'protected' or 'manual' would claim something was
  // defended when nothing was, and would spend an audit row doing it. It also
  // makes a repeated backfill genuinely idempotent rather than merely
  // harmless.
  if (workspace.workStatus === proposed) return decline('same-status');
  if (workspace.archivedAt !== null) return decline('archived');
  if (PROPOSAL_PROTECTED.includes(workspace.workStatus)) return decline('protected');
  if (workspace.workStatusIsManual) return decline('manual');

  // The mapping can propose a status the machine disallows from here (for
  // instance a late protocol event against a Resolved workspace). Treat that as
  // a declined proposal rather than an exception: a protocol event must never
  // fail because of internal state.
  if (!allowedTransitions(workspace.workStatus).includes(proposed)) {
    return decline('protected');
  }

  const updated = await applyWorkStatus(workspace, proposed, actor, false);
  return { applied: true, workStatus: updated.workStatus, proposed };
}

/**
 * Convenience wrapper for protocol transition sites: resolve the workspace from
 * the referral id and propose.
 *
 * NEVER THROWS. A protocol event must not fail because of internal state — the
 * 360X status is externally authoritative and its transition has already been
 * guarded and written by the time this runs. A missing workspace is silent and
 * expected: a referral that predates PRD-18 and has not been backfilled, or an
 * auto-declined referral, which has no referral row and therefore no workspace.
 */
export async function proposeForReferral(
  referralId: number,
  protocolState: ReferralState,
  actor = 'system',
): Promise<void> {
  try {
    const workspace = await getWorkspaceByReferralId(referralId);
    if (!workspace) return;
    await proposeWorkStatus(workspace.id, protocolState, actor);
  } catch (err) {
    console.error(
      `[WorkspaceService] work status proposal failed for referral ${referralId}:`,
      err,
    );
  }
}

/**
 * Clears the manual flag and applies the mapping for the referral's current
 * protocol state.
 *
 * Required, not optional: without it a single manual override would freeze the
 * work status for the life of the workspace.
 */
export async function resyncWorkStatus(workspaceId: number, actor: string): Promise<Workspace> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new WorkspaceNotFoundError(workspaceId);

  const [referral] = await db
    .select({ state: referrals.state })
    .from(referrals)
    .where(eq(referrals.id, workspace.referralId))
    .limit(1);
  if (!referral) throw new WorkspaceNotFoundError(workspace.referralId);

  const now = new Date();
  await db
    .update(referralWorkspaces)
    .set({ workStatusIsManual: false, updatedAt: now })
    .where(eq(referralWorkspaces.id, workspaceId));

  void emitEvent({
    eventType: 'workspace.work_status_resynced',
    entityType: 'referral',
    entityId: workspace.referralId,
    actor,
    metadata: { workspaceId, protocolState: referral.state },
  }).catch((err) => console.error('[WorkspaceService]', err));

  const cleared: Workspace = { ...workspace, workStatusIsManual: false };
  const proposed = resolveProposedStatus(cleared, referral.state as ReferralState);
  await applyProposal(cleared, proposed, actor);

  const refreshed = await getWorkspace(workspaceId);
  if (!refreshed) throw new WorkspaceNotFoundError(workspaceId);
  return refreshed;
}

// ── Archival ──────────────────────────────────────────────────────────────────

/**
 * Archives a workspace. Only reachable from `Resolved`, and never alters any
 * protocol field.
 *
 * A workspace in `Follow-up-Required` is refused with what is still open —
 * closing the loop externally must not make internal work disappear.
 */
export async function archiveWorkspace(workspaceId: number, actor: string): Promise<Workspace> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) throw new WorkspaceNotFoundError(workspaceId);
  if (workspace.archivedAt !== null) return workspace;

  if (workspace.workStatus === WorkStatus.FOLLOW_UP_REQUIRED) {
    throw new WorkspaceNotArchivableError(
      workspace.workStatus,
      'internal follow-up is still outstanding. Resolve it first.',
    );
  }
  if (workspace.workStatus !== WorkStatus.RESOLVED) {
    throw new WorkspaceNotArchivableError(
      workspace.workStatus,
      `a workspace can only be archived from ${WorkStatus.RESOLVED}`,
    );
  }

  const now = new Date();
  const [row] = await db
    .update(referralWorkspaces)
    .set({ archivedAt: now, updatedAt: now })
    .where(eq(referralWorkspaces.id, workspaceId))
    .returning();

  void emitEvent({
    eventType: 'workspace.archived',
    entityType: 'referral',
    entityId: workspace.referralId,
    actor,
    metadata: { workspaceId },
  }).catch((err) => console.error('[WorkspaceService]', err));

  return toWorkspace(row);
}

// ── Backfill ──────────────────────────────────────────────────────────────────

export interface BackfillResult {
  /** Referrals that had no workspace; one was created and its status derived. */
  created: number;
  /** Existing workspaces whose status was stale against the protocol and re-derived. */
  updated: number;
  /** Existing workspaces left untouched — already correct, manual, protected or archived. */
  skipped: number;
}

/**
 * Brings every referral's workspace into line with its protocol state.
 *
 * Two jobs, not one:
 *
 *   - a referral with no workspace gets one, its status derived from the mapping
 *   - a referral whose workspace is STALE gets that status re-derived
 *
 * The second job is why this is not simply "create the missing rows". A
 * workspace goes stale whenever `referrals.state` is written without a proposal
 * reaching the workspace — `seed-full-demo.ts` advances all 100 demo referrals
 * with direct `db.update()` calls, so without this every seeded workspace would
 * sit at `Triage` no matter how far its referral had actually progressed. That
 * is the exact misrepresentation the derive-don't-default decision below exists
 * to prevent, so skipping existing rows would have defeated it.
 *
 * Re-deriving goes through the ordinary proposal path, so it cannot overwrite a
 * status a person set (`manual`), an `Exception` or `Follow-up-Required`
 * (`protected`), or an archived workspace — those are reported as skipped.
 *
 * Idempotent, and quietly so: a second run proposes what each workspace already
 * holds, which declines as `same-status` and writes no audit row.
 *
 * Derived statuses are written as mapping-set (`workStatusIsManual: false`) so
 * the advisory rule behaves correctly from then on.
 *
 * Setting everything to `Triage` was considered and rejected: it would
 * misrepresent a hundred seeded referrals as untriaged and make the queue views
 * useless on first run. Deriving is also honest about provenance, because the
 * flag records that no person chose these values.
 */
export async function backfillWorkspaces(): Promise<BackfillResult> {
  const rows = await db.select({ id: referrals.id, state: referrals.state }).from(referrals);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const referral of rows) {
    const state = referral.state as ReferralState;
    const existing = await getWorkspaceByReferralId(referral.id);

    if (existing) {
      // Stale, not correct — re-derive. applyProposal decides whether it may.
      const { applied } = await applyProposal(
        existing,
        resolveProposedStatus(existing, state),
        'system',
      );
      if (applied) updated += 1;
      else skipped += 1;
      continue;
    }

    const workspace = await createWorkspace(referral.id);
    const proposed = resolveProposedStatus(workspace, state);
    if (proposed !== workspace.workStatus) {
      await applyProposal(workspace, proposed, 'system');
    }
    created += 1;
  }

  return { created, updated, skipped };
}
