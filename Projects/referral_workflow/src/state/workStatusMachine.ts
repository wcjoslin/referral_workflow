/**
 * Concord-local Work Status machine (PRD-18)
 *
 * The SECOND status dimension, structurally incapable of touching the first.
 * `referrals.state` is the externally authoritative 360X status — what the
 * counterparty has been told — and it is governed by referralStateMachine.ts.
 * This governs `referral_workspaces.work_status`: internal processing only.
 * Neither ever silently overwrites the other.
 *
 * WHAT THIS MACHINE ACTUALLY BUYS. The four active statuses are freely
 * interchangeable, so the transition graph below is nearly complete and the
 * table is not where the value is. What it provides is a single guarded write
 * path and valid-value enforcement — the same properties the other three
 * machines give their domains. Only three rules are genuinely encoded:
 *
 *   1. `Exception` is reachable from every status — PRD-28 must always be able
 *      to raise one.
 *   2. A reopen never returns to `Triage`. From `Resolved` or
 *      `Follow-up-Required` the only way back into active work is
 *      `In-Progress`: you resume work, you do not re-triage it.
 *   3. No status is terminal. A late inbound message can reopen internal work
 *      without touching the protocol state. Archival, not `Resolved`, is the
 *      end of the line.
 *
 * Do not pad the table with invented restrictions to make the machine look
 * busier than it is.
 *
 * There is no `New`: a workspace starts at `Triage`, and "nobody has picked
 * this up yet" is `owner_user_id IS NULL`, which PRD-21 surfaces explicitly
 * wherever workspaces are listed.
 *
 * NOTE this module exports a function named `transition`, as the other three
 * state machines do. Callers alias it on import:
 *   import { transition as workStatusTransition } from '../../state/workStatusMachine';
 */

export const WorkStatus = {
  TRIAGE: 'Triage',
  IN_PROGRESS: 'In-Progress',
  WAITING_EXTERNAL: 'Waiting-External',
  WAITING_INTERNAL: 'Waiting-Internal',
  FOLLOW_UP_REQUIRED: 'Follow-up-Required',
  EXCEPTION: 'Exception',
  RESOLVED: 'Resolved',
} as const;

export type WorkStatus = (typeof WorkStatus)[keyof typeof WorkStatus];

// Defines which transitions are valid from each status
const VALID_TRANSITIONS: Record<WorkStatus, WorkStatus[]> = {
  [WorkStatus.TRIAGE]: [
    WorkStatus.IN_PROGRESS,
    WorkStatus.WAITING_EXTERNAL,
    WorkStatus.WAITING_INTERNAL,
    WorkStatus.FOLLOW_UP_REQUIRED,
    WorkStatus.EXCEPTION,
    WorkStatus.RESOLVED,
  ],
  [WorkStatus.IN_PROGRESS]: [
    WorkStatus.TRIAGE,
    WorkStatus.WAITING_EXTERNAL,
    WorkStatus.WAITING_INTERNAL,
    WorkStatus.FOLLOW_UP_REQUIRED,
    WorkStatus.EXCEPTION,
    WorkStatus.RESOLVED,
  ],
  [WorkStatus.WAITING_EXTERNAL]: [
    WorkStatus.TRIAGE,
    WorkStatus.IN_PROGRESS,
    WorkStatus.WAITING_INTERNAL,
    WorkStatus.FOLLOW_UP_REQUIRED,
    WorkStatus.EXCEPTION,
    WorkStatus.RESOLVED,
  ],
  [WorkStatus.WAITING_INTERNAL]: [
    WorkStatus.TRIAGE,
    WorkStatus.IN_PROGRESS,
    WorkStatus.WAITING_EXTERNAL,
    WorkStatus.FOLLOW_UP_REQUIRED,
    WorkStatus.EXCEPTION,
    WorkStatus.RESOLVED,
  ],
  // Rule 2: resume into In-Progress, never back to Triage.
  [WorkStatus.FOLLOW_UP_REQUIRED]: [
    WorkStatus.IN_PROGRESS,
    WorkStatus.EXCEPTION,
    WorkStatus.RESOLVED,
  ],
  [WorkStatus.EXCEPTION]: [
    WorkStatus.TRIAGE,
    WorkStatus.IN_PROGRESS,
    WorkStatus.WAITING_EXTERNAL,
    WorkStatus.WAITING_INTERNAL,
    WorkStatus.RESOLVED,
  ],
  // Rule 2 again, and rule 3: not terminal.
  [WorkStatus.RESOLVED]: [
    WorkStatus.IN_PROGRESS,
    WorkStatus.FOLLOW_UP_REQUIRED,
    WorkStatus.EXCEPTION,
  ],
};

export class InvalidWorkStatusTransitionError extends Error {
  constructor(from: WorkStatus, to: WorkStatus) {
    super(`Invalid work status transition: ${from} → ${to}`);
    this.name = 'InvalidWorkStatusTransitionError';
  }
}

/**
 * Pure guard — does not touch the database. Callers load, guard, update, then
 * emit, matching the convention of the other three machines.
 */
export function transition(current: WorkStatus, next: WorkStatus): WorkStatus {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new InvalidWorkStatusTransitionError(current, next);
  }
  return next;
}

export function isValidState(value: string): value is WorkStatus {
  return Object.values(WorkStatus).includes(value as WorkStatus);
}

/** The statuses reachable from `current`, for building a UI control. */
export function allowedTransitions(current: WorkStatus): WorkStatus[] {
  return [...VALID_TRANSITIONS[current]];
}
