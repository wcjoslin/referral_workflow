/**
 * PRD-26 — what to do next, by when, and who owes the move.
 *
 * PRD-21 answers *who* owns a workspace. This answers *what* and *by when*, and
 * the question the source document is careful about and the codebase could not
 * previously express: whether the next move is **ours or theirs**. "Waiting on
 * the referring office" and "waiting on us to schedule" look identical in a
 * status column and call for opposite responses.
 *
 * THIS MODULE IS THE ONLY WRITER of `next_action`, `next_action_due_at`,
 * `awaited_by` and the override columns — the same single-writer rule
 * assignmentService follows for `owner_user_id` and queueService for
 * `queue_id`.
 *
 * ── COMPUTED SYNCHRONOUSLY, NOT SWEPT ───────────────────────────────────────
 *
 * Every next action and due date is written by the transition that caused it,
 * so a coordinator who changes a work status sees the new instruction
 * immediately. The interval sweep in overdueChecker exists ONLY to notice the
 * passage of time — it never computes an action. That split is why a due date is
 * measured from the moment the state was entered rather than from whenever a
 * job happened to run.
 *
 * ── WHAT THE OFFSETS ARE NOT ────────────────────────────────────────────────
 *
 * Not SLAs. No business-hours awareness, no holiday calendar, no contractual
 * basis: 48 hours means 48 elapsed hours including a weekend. The rule table in
 * config.ts says the same thing where it is edited.
 */

import { and, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { db } from '../../db';
import {
  NEXT_ACTION_BY_STATE,
  NEXT_ACTION_BY_STATE_AND_WORK_STATUS,
  NEXT_ACTION_BY_WORK_STATUS,
  NextActionRule,
} from './nextActionRules';
import { patients, referralWorkspaces, referrals, workspaceParties } from '../../db/schema';
import { emitEvent } from '../analytics/eventService';
import { outboundMessages } from '../../db/schema';
import { ReferralState } from '../../state/referralStateMachine';
import { WorkStatus } from '../../state/workStatusMachine';
import { WorkspaceEvents } from './eventCatalog';
import { ActingUser, formatActor } from './identityService';

export type AwaitedBy = 'us' | 'party' | 'nobody';

/**
 * Deliberately NOT named `WorkspaceNotFoundError`.
 *
 * workspaceService already exports a class by that name, and server.ts imports
 * THAT one. Two same-named classes in different modules would make
 * `err instanceof WorkspaceNotFoundError` silently false for whichever the
 * route did not import — a 500 instead of a 404, and very hard to spot.
 *
 * Reusing workspaceService's class instead would need an import back into a
 * module that already imports this one, so the distinct name is the cheap fix.
 */
export class NextActionWorkspaceNotFoundError extends Error {
  constructor(workspaceId: number) {
    super(`No workspace with id ${workspaceId}`);
    this.name = 'NextActionWorkspaceNotFoundError';
  }
}

/** A due-date override without a reason is refused — the reason IS the record. */
export class OverrideReasonRequiredError extends Error {
  constructor() {
    super('Overriding a due date requires a reason');
    this.name = 'OverrideReasonRequiredError';
  }
}

export class NextActionEmptyError extends Error {
  constructor() {
    super('A next action cannot be empty');
    this.name = 'NextActionEmptyError';
  }
}

export class NextActionTooLongError extends Error {
  constructor(length: number) {
    super(`A next action may be at most ${MAX_NEXT_ACTION_LENGTH} characters (got ${length})`);
    this.name = 'NextActionTooLongError';
  }
}

/**
 * A next action is one instruction, not a note — the conversation (PRD-22) is
 * where discussion belongs. Bounded so it cannot break the queue row layout.
 */
export const MAX_NEXT_ACTION_LENGTH = 500;

export interface NextActionState {
  nextAction: string;
  nextActionDueAt: Date | null;
  nextActionSetBy: string | null;
  dueDateOverridden: boolean;
  dueDateOverrideReason: string | null;
  awaitedBy: AwaitedBy;
  awaitedByPartyId: number | null;
  awaitedByPartyOrgName: string | null;
  overdue: boolean;
  /** Hours past due, rounded. Null when not overdue or when there is no due date. */
  overdueByHours: number | null;
}

/**
 * The fallback for a state the table does not know.
 *
 * An action with NO due date, deliberately (AC8). Inventing a deadline for a
 * combination nobody configured would be a fabricated commitment, and a
 * fabricated deadline is worse than an absent one — it gets chased.
 */
const UNMAPPED: NextActionRule = {
  action: 'Review this referral and decide the next step',
  dueInHours: null,
  awaitedBy: 'us',
};

/**
 * Resolves the rule for a state pair. Three layers, most specific first.
 *
 * The work-status layer wins outright: an `Exception` is the thing to deal with,
 * and what the protocol happens to say meanwhile is not the next action.
 */
export function resolveRule(state: ReferralState, workStatus: WorkStatus): NextActionRule {
  const byWorkStatus = NEXT_ACTION_BY_WORK_STATUS[workStatus];
  if (byWorkStatus) return byWorkStatus;

  const pair = NEXT_ACTION_BY_STATE_AND_WORK_STATUS[`${state}|${workStatus}`];
  if (pair) return pair;

  return NEXT_ACTION_BY_STATE[state] ?? UNMAPPED;
}

/**
 * Turns a rule's offset into an absolute due date.
 *
 * `enteredAt` is the moment the state was entered, NOT now — the two are the
 * same when called from a transition, and differ for the backfill, where using
 * `now` would reset every deadline in the database to the moment of the
 * backfill and quietly un-overdue everything.
 */
function dueDateFor(
  rule: NextActionRule,
  enteredAt: Date,
  appointmentDate: string | null,
): Date | null {
  if (rule.dueInHours === null) return null;

  if (rule.dueInHours === 'appointment') {
    // The one rule that is not an offset. No appointment date => no due date,
    // for the same reason as UNMAPPED above: better absent than invented.
    if (!appointmentDate) return null;
    const parsed = new Date(appointmentDate);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // Stored through drizzle `mode: 'timestamp'`, which keeps WHOLE SECONDS, so
  // the value read back is truncated to the second. Deadlines are hours apart,
  // so that is immaterial here — noted because the same truncation was a real
  // bug in PRD-22's share lock, where the comparison was sub-second.
  return new Date(enteredAt.getTime() + rule.dueInHours * 60 * 60 * 1000);
}

/**
 * Which party owes the move, and whether they really do.
 *
 * Two downgrades to `us`, both of which matter:
 *
 *   - a `local-only` party (AC12). Nothing was transmitted to them, so they
 *     cannot owe a response — showing them as owing one would send a
 *     coordinator to chase a message that was never sent.
 *   - no party of the owed role exists at all. A workspace whose counterparty
 *     was removed falls back to us rather than pointing at nothing.
 *
 * `Closed` additionally requires an UNACKNOWLEDGED outbound message (AC11): once
 * the consult note is acknowledged nobody owes anything, whatever the rule says,
 * because the rule cannot see delivery state.
 */
async function resolveAwaited(
  workspaceId: number,
  referralId: number,
  rule: NextActionRule,
  state: ReferralState,
): Promise<{ awaitedBy: AwaitedBy; partyId: number | null; orgName: string | null }> {
  if (rule.awaitedBy !== 'party') {
    return { awaitedBy: rule.awaitedBy, partyId: null, orgName: null };
  }

  // Every state where a party owes the move, owes it to the INITIATING party —
  // they sent the referral and they are who we reply to. Written as a lookup
  // rather than hardcoded so a state owing a different role can be added
  // without rewriting the branch.
  const owedRole = OWED_BY_ROLE[state] ?? 'initiating';

  const [party] = await db
    .select({
      id: workspaceParties.id,
      orgName: workspaceParties.orgName,
      protocolMode: workspaceParties.protocolMode,
    })
    .from(workspaceParties)
    .where(and(eq(workspaceParties.workspaceId, workspaceId), eq(workspaceParties.partyRole, owedRole)))
    .limit(1);

  if (!party) return { awaitedBy: 'us', partyId: null, orgName: null };
  if (party.protocolMode === 'local-only') {
    return { awaitedBy: 'us', partyId: null, orgName: null };
  }

  // AC11. Only for the states whose "they owe us" claim IS a delivery claim.
  if (ACK_GATED_STATES.includes(state)) {
    const [pending] = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.referralId, referralId),
          eq(outboundMessages.status, 'Pending'),
          isNull(outboundMessages.acknowledgedAt),
        ),
      )
      .limit(1);
    // Nothing outstanding to acknowledge => they do not owe a move.
    if (!pending) return { awaitedBy: 'nobody', partyId: null, orgName: null };
  }

  return { awaitedBy: 'party', partyId: party.id, orgName: party.orgName };
}

/** Which party role owes the response, per protocol state. Default initiating. */
const OWED_BY_ROLE: Partial<Record<ReferralState, string>> = {
  [ReferralState.PENDING_INFORMATION]: 'initiating',
  [ReferralState.SCHEDULED]: 'initiating',
  [ReferralState.CLOSED]: 'initiating',
};

/**
 * States where "the party owes a move" is specifically "they owe an ACK".
 *
 * `Scheduled` is NOT here on purpose: what is awaited is the appointment
 * happening, not a message. Gating it on ack state would flip the indicator to
 * "nobody" the moment the SIU came back acknowledged, while the appointment is
 * still days away and very much awaited.
 */
const ACK_GATED_STATES: readonly ReferralState[] = [ReferralState.CLOSED];

interface WorkspaceRow {
  id: number;
  referralId: number;
  workStatus: string;
  nextAction: string | null;
  nextActionDueAt: Date | null;
  nextActionSetBy: string | null;
  dueDateOverridden: boolean;
  dueDateOverrideReason: string | null;
  overdueNotifiedAt: Date | null;
  awaitedBy: string | null;
  awaitedByPartyId: number | null;
  archivedAt: Date | null;
  workStatusSetAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

async function loadRow(workspaceId: number): Promise<WorkspaceRow | null> {
  const [row] = await db
    .select({
      id: referralWorkspaces.id,
      referralId: referralWorkspaces.referralId,
      workStatus: referralWorkspaces.workStatus,
      nextAction: referralWorkspaces.nextAction,
      nextActionDueAt: referralWorkspaces.nextActionDueAt,
      nextActionSetBy: referralWorkspaces.nextActionSetBy,
      dueDateOverridden: referralWorkspaces.dueDateOverridden,
      dueDateOverrideReason: referralWorkspaces.dueDateOverrideReason,
      overdueNotifiedAt: referralWorkspaces.overdueNotifiedAt,
      awaitedBy: referralWorkspaces.awaitedBy,
      awaitedByPartyId: referralWorkspaces.awaitedByPartyId,
      archivedAt: referralWorkspaces.archivedAt,
      workStatusSetAt: referralWorkspaces.workStatusSetAt,
      createdAt: referralWorkspaces.createdAt,
      updatedAt: referralWorkspaces.updatedAt,
    })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  return row ?? null;
}

function toState(
  row: WorkspaceRow,
  orgName: string | null,
  now: Date,
): NextActionState {
  const due = row.nextActionDueAt;
  const overdue = due !== null && due.getTime() < now.getTime();
  return {
    nextAction: row.nextAction ?? UNMAPPED.action,
    nextActionDueAt: due,
    // The actor half only. The encoded rule action is an implementation detail
    // of AC4's survival rule and has no business reaching a page.
    nextActionSetBy: actorFromSetBy(row.nextActionSetBy),
    dueDateOverridden: row.dueDateOverridden,
    dueDateOverrideReason: row.dueDateOverrideReason,
    awaitedBy: (row.awaitedBy as AwaitedBy | null) ?? 'us',
    awaitedByPartyId: row.awaitedByPartyId,
    awaitedByPartyOrgName: orgName,
    overdue,
    overdueByHours:
      overdue && due !== null
        ? Math.round((now.getTime() - due.getTime()) / (60 * 60 * 1000))
        : null,
  };
}

async function orgNameOf(partyId: number | null): Promise<string | null> {
  if (partyId === null) return null;
  const [p] = await db
    .select({ orgName: workspaceParties.orgName })
    .from(workspaceParties)
    .where(eq(workspaceParties.id, partyId))
    .limit(1);
  return p?.orgName ?? null;
}

/**
 * Recomputes the next action for a workspace. Called BY every transition.
 *
 * What it preserves, and why each one:
 *
 *   - **an overridden due date** is never recomputed. Without that, the next
 *     transition silently discards a coordinator's judgement, which is the
 *     fastest way to teach people the field is a lie.
 *   - **a manual next action** survives until the state change makes it
 *     meaningless — meaning until the RULE's action changes. Then it is replaced
 *     and the previous value goes in the event metadata (AC4), so the override
 *     is recoverable rather than lost.
 *
 * Never throws for a missing workspace: it is called from protocol transition
 * paths, and a protocol event must not fail because of internal bookkeeping.
 */
export async function recomputeNextAction(
  workspaceId: number,
  enteredAt?: Date,
  actor = 'system',
): Promise<NextActionState | null> {
  const row = await loadRow(workspaceId);
  if (!row) return null;

  const now = new Date();

  const [referral] = await db
    .select({ state: referrals.state, appointmentDate: referrals.appointmentDate })
    .from(referrals)
    .where(eq(referrals.id, row.referralId))
    .limit(1);
  if (!referral) return null;

  const state = referral.state as ReferralState;
  const workStatus = row.workStatus as WorkStatus;
  const rule = resolveRule(state, workStatus);

  // The moment the state was entered.
  //
  // Callers inside a transition pass it explicitly, where it is exact. Otherwise
  // the work status timestamp is the best available record, falling back to
  // `createdAt`.
  //
  // NOT `updatedAt`, which was the first version and was a real bug: this
  // function WRITES `updatedAt`, so using it as the entry proxy made every
  // recompute move the due date forward by however long had passed. A backfill
  // over an existing database silently reset every deadline to the moment of the
  // backfill and un-overdued the lot — while looking exactly like the feature
  // working. `createdAt` never changes, so the fallback is stable and a repeated
  // backfill is a genuine no-op.
  const entered = enteredAt ?? row.workStatusSetAt ?? row.createdAt;

  const awaited = await resolveAwaited(row.id, row.referralId, rule, state);

  // A manual action is kept unless the rule's own action has moved on.
  const previousAction = row.nextAction;
  const manualStillValid = manualActionSurvives(row, rule);
  const nextAction = manualStillValid ? previousAction! : rule.action;

  const computedDue = dueDateFor(rule, entered, referral.appointmentDate);
  const nextDue = row.dueDateOverridden ? row.nextActionDueAt : computedDue;

  // Only clear the overdue mark when the due date actually MOVED, so a
  // recompute that lands on the same instant does not re-notify.
  const dueChanged = (row.nextActionDueAt?.getTime() ?? null) !== (nextDue?.getTime() ?? null);

  const changed =
    nextAction !== previousAction ||
    dueChanged ||
    awaited.awaitedBy !== row.awaitedBy ||
    awaited.partyId !== row.awaitedByPartyId;

  if (!changed) return toState(row, awaited.orgName, now);

  const [updated] = await db
    .update(referralWorkspaces)
    .set({
      nextAction,
      nextActionDueAt: nextDue,
      nextActionSetBy: manualStillValid ? row.nextActionSetBy : null,
      awaitedBy: awaited.awaitedBy,
      awaitedByPartyId: awaited.partyId,
      ...(dueChanged ? { overdueNotifiedAt: null } : {}),
      updatedAt: now,
    })
    .where(eq(referralWorkspaces.id, workspaceId))
    .returning();

  void emitEvent({
    eventType: WorkspaceEvents.NEXT_ACTION_CHANGED,
    entityType: 'referral',
    entityId: row.referralId,
    actor,
    metadata: {
      workspaceId,
      nextAction,
      ...(previousAction !== null && previousAction !== nextAction
        ? { previousAction }
        : {}),
      // Recorded when a coordinator's manual action was replaced, which is the
      // case AC4 cares about — the value is otherwise unrecoverable.
      ...(row.nextActionSetBy !== null && !manualStillValid
        ? { replacedManualAction: previousAction, manualSetBy: row.nextActionSetBy }
        : {}),
      dueAt: nextDue ? nextDue.toISOString() : null,
      awaitedBy: awaited.awaitedBy,
      ...(awaited.orgName ? { awaitedByOrgName: awaited.orgName } : {}),
      protocolState: state,
      workStatus,
    },
  }).catch((err) => console.error('[NextActionService]', err));

  return toState(
    { ...row, ...updated, dueDateOverridden: updated.dueDateOverridden },
    awaited.orgName,
    now,
  );
}

/** The `||` delimiter that separates the actor from the rule action it overrode. */
const SET_BY_DELIM = '||';

/** Encodes who overrode the action, and which rule action they overrode. */
export function encodeSetBy(actor: string, ruleActionAtOverride: string): string {
  return `${actor}${SET_BY_DELIM}${ruleActionAtOverride}`;
}

/** The actor half, for display. Tolerates a legacy value with no delimiter. */
export function actorFromSetBy(setBy: string | null): string | null {
  if (setBy === null) return null;
  return setBy.split(SET_BY_DELIM)[0];
}

/**
 * Whether a coordinator's manual next action survives this recompute (AC4).
 *
 * "Until that status change makes it meaningless" needs a definition, and the
 * only honest one available is: **until the rule's own action changes.** So an
 * override records the rule action in force when it was made, and survives
 * exactly as long as the rule still says the same thing.
 *
 * Worked example. A coordinator in `Accepted|In-Progress` replaces "Schedule the
 * patient and notify the referring office" with "Call Dr. Ofori's office about
 * the echo report". The referral moves to `Scheduled`, whose rule action is
 * "Awaiting the appointment" — different, so the manual note is replaced and the
 * old value goes into the event metadata. Had the work status merely moved
 * between two states sharing one rule action, the note would have stayed.
 *
 * Storing the rule action alongside the actor avoids a second column that could
 * drift out of sync with the one that matters.
 */
function manualActionSurvives(row: WorkspaceRow, rule: NextActionRule): boolean {
  if (row.nextActionSetBy === null || row.nextAction === null) return false;
  const parts = row.nextActionSetBy.split(SET_BY_DELIM);
  // No recorded rule action (a legacy row): do not cling to it. Replacing is the
  // safe direction — a stale instruction is worse than a re-derived one.
  if (parts.length < 2) return false;
  return parts.slice(1).join(SET_BY_DELIM) === rule.action;
}

/** AC7 — a due date a person chose, audited, and never recomputed away. */
export async function overrideDueDate(
  workspaceId: number,
  dueAt: Date,
  reason: string,
  actor: ActingUser,
): Promise<NextActionState> {
  const row = await loadRow(workspaceId);
  if (!row) throw new NextActionWorkspaceNotFoundError(workspaceId);
  if (!reason.trim()) throw new OverrideReasonRequiredError();

  const now = new Date();
  const dueChanged = (row.nextActionDueAt?.getTime() ?? null) !== dueAt.getTime();

  const [updated] = await db
    .update(referralWorkspaces)
    .set({
      nextActionDueAt: dueAt,
      dueDateOverridden: true,
      dueDateOverrideReason: reason.trim(),
      // A new deadline is a new breach, so the old notification must not
      // suppress it.
      ...(dueChanged ? { overdueNotifiedAt: null } : {}),
      updatedAt: now,
    })
    .where(eq(referralWorkspaces.id, workspaceId))
    .returning();

  await emitEvent({
    eventType: WorkspaceEvents.DUE_DATE_OVERRIDDEN,
    entityType: 'referral',
    entityId: row.referralId,
    actor: formatActor(actor),
    metadata: {
      workspaceId,
      previousDueAt: row.nextActionDueAt ? row.nextActionDueAt.toISOString() : null,
      dueAt: dueAt.toISOString(),
      reason: reason.trim(),
    },
  });

  return toState({ ...row, ...updated }, await orgNameOf(updated.awaitedByPartyId), now);
}

/** AC4 — a coordinator's own instruction, which survives recomputation. */
export async function overrideNextAction(
  workspaceId: number,
  action: string,
  actor: ActingUser,
): Promise<NextActionState> {
  const row = await loadRow(workspaceId);
  if (!row) throw new NextActionWorkspaceNotFoundError(workspaceId);

  const trimmed = action.trim();
  if (!trimmed) throw new NextActionEmptyError();
  if (trimmed.length > MAX_NEXT_ACTION_LENGTH) {
    throw new NextActionTooLongError(trimmed.length);
  }

  const [referral] = await db
    .select({ state: referrals.state })
    .from(referrals)
    .where(eq(referrals.id, row.referralId))
    .limit(1);
  const rule = resolveRule(
    (referral?.state ?? ReferralState.RECEIVED) as ReferralState,
    row.workStatus as WorkStatus,
  );

  const now = new Date();
  const [updated] = await db
    .update(referralWorkspaces)
    .set({
      nextAction: trimmed,
      // Actor AND the rule action in force at override time, so a later
      // recompute can tell "the rule moved on" from "the rule is unchanged"
      // without a second column.
      nextActionSetBy: encodeSetBy(formatActor(actor), rule.action),
      updatedAt: now,
    })
    .where(eq(referralWorkspaces.id, workspaceId))
    .returning();

  await emitEvent({
    eventType: WorkspaceEvents.NEXT_ACTION_CHANGED,
    entityType: 'referral',
    entityId: row.referralId,
    actor: formatActor(actor),
    metadata: {
      workspaceId,
      nextAction: trimmed,
      ...(row.nextAction ? { previousAction: row.nextAction } : {}),
      manual: true,
    },
  });

  return toState({ ...row, ...updated }, await orgNameOf(updated.awaitedByPartyId), now);
}

/** Clears a manual next action and a due-date override, restoring the rule. */
export async function clearOverrides(
  workspaceId: number,
  actor: ActingUser,
): Promise<NextActionState | null> {
  const row = await loadRow(workspaceId);
  if (!row) throw new NextActionWorkspaceNotFoundError(workspaceId);

  await db
    .update(referralWorkspaces)
    .set({
      nextActionSetBy: null,
      dueDateOverridden: false,
      dueDateOverrideReason: null,
      updatedAt: new Date(),
    })
    .where(eq(referralWorkspaces.id, workspaceId));

  return recomputeNextAction(workspaceId, undefined, formatActor(actor));
}

/**
 * Boundary: overdue means STRICTLY past the due instant.
 *
 * Exactly at the due timestamp is not overdue — a deadline of 17:00 is met at
 * 17:00. Pinned in a test because the off-by-one here shows up as a workspace
 * that reads overdue for a second before it is.
 */
export function isOverdue(
  workspace: { nextActionDueAt: Date | null; archivedAt?: Date | null },
  now: Date = new Date(),
): boolean {
  if (workspace.archivedAt) return false;
  if (!workspace.nextActionDueAt) return false;
  return workspace.nextActionDueAt.getTime() < now.getTime();
}

/**
 * The current state, for the workspace payload. NO WRITES.
 *
 * When nothing has been computed yet — a workspace that has not transitioned
 * since this feature shipped and has not been backfilled — this reports the
 * RULE's action for the current state rather than a blank or a generic
 * placeholder. AC1 and AC3 both require that a coordinator never sees an empty
 * Next Action, and reporting what a recompute WOULD write is both the honest
 * answer and the useful one. The backfill then merely persists it.
 */
export async function getNextActionState(workspaceId: number): Promise<NextActionState | null> {
  const row = await loadRow(workspaceId);
  if (!row) return null;

  if (row.nextAction === null) {
    const [referral] = await db
      .select({ state: referrals.state })
      .from(referrals)
      .where(eq(referrals.id, row.referralId))
      .limit(1);
    if (referral) {
      const rule = resolveRule(referral.state as ReferralState, row.workStatus as WorkStatus);
      return toState({ ...row, nextAction: rule.action }, null, new Date());
    }
  }

  return toState(row, await orgNameOf(row.awaitedByPartyId), new Date());
}

// ── Backfill ─────────────────────────────────────────────────────────────────

/**
 * Computes the next action for every workspace that has none.
 *
 * Uses each workspace's OWN recorded timestamp as the state entry moment rather
 * than now, so existing overdue work stays overdue instead of every deadline in
 * the database resetting to the moment of the backfill.
 */
export async function backfillNextActions(): Promise<{ computed: number; skipped: number }> {
  const rows = await db
    .select({ id: referralWorkspaces.id, archivedAt: referralWorkspaces.archivedAt })
    .from(referralWorkspaces);

  let computed = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.archivedAt !== null) {
      skipped += 1;
      continue;
    }
    const result = await recomputeNextAction(row.id, undefined, 'system');
    if (result) computed += 1;
    else skipped += 1;
  }
  return { computed, skipped };
}

// ── Overdue listing, scoped ──────────────────────────────────────────────────

export interface OverdueItem {
  workspaceId: number;
  referralId: number;
  patientName: string;
  nextAction: string;
  nextActionDueAt: string;
  hoursOverdue: number;
  ownerUserId: number | null;
  queueId: number | null;
  awaitedBy: AwaitedBy;
}

/**
 * Overdue workspaces, optionally narrowed to a set of queue ids.
 *
 * The caller resolves scope (queueService owns that), so this takes ids rather
 * than a user — keeping the queue-scope predicate in one module instead of
 * reimplementing it here where it could drift.
 */
export async function listOverdue(
  queueIds: number[] | 'all',
  now: Date = new Date(),
): Promise<OverdueItem[]> {
  if (queueIds !== 'all' && queueIds.length === 0) return [];

  const rows = await db
    .select({
      workspaceId: referralWorkspaces.id,
      referralId: referralWorkspaces.referralId,
      nextAction: referralWorkspaces.nextAction,
      nextActionDueAt: referralWorkspaces.nextActionDueAt,
      ownerUserId: referralWorkspaces.ownerUserId,
      queueId: referralWorkspaces.queueId,
      awaitedBy: referralWorkspaces.awaitedBy,
      firstName: patients.firstName,
      lastName: patients.lastName,
    })
    .from(referralWorkspaces)
    .innerJoin(referrals, eq(referrals.id, referralWorkspaces.referralId))
    .innerJoin(patients, eq(patients.id, referrals.patientId))
    .where(
      and(
        isNull(referralWorkspaces.archivedAt),
        isNotNull(referralWorkspaces.nextActionDueAt),
        lte(referralWorkspaces.nextActionDueAt, now),
      ),
    );

  return rows
    .filter((r) => (queueIds === 'all' ? true : r.queueId !== null && queueIds.includes(r.queueId)))
    // `lte` includes the exact due instant; isOverdue() is strict, so filter
    // again through it rather than letting the two disagree by a second.
    .filter((r) => isOverdue({ nextActionDueAt: r.nextActionDueAt }, now))
    .map((r) => ({
      workspaceId: r.workspaceId,
      referralId: r.referralId,
      patientName: `${r.firstName} ${r.lastName}`.trim(),
      nextAction: r.nextAction ?? UNMAPPED.action,
      nextActionDueAt: r.nextActionDueAt!.toISOString(),
      hoursOverdue: Math.round(
        (now.getTime() - r.nextActionDueAt!.getTime()) / (60 * 60 * 1000),
      ),
      ownerUserId: r.ownerUserId,
      queueId: r.queueId,
      awaitedBy: (r.awaitedBy as AwaitedBy | null) ?? 'us',
    }))
    .sort((a, b) => b.hoursOverdue - a.hoursOverdue);
}
