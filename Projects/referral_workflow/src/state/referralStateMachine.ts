/**
 * Referral State Machine
 *
 * Manages all valid state transitions for the 360X referral lifecycle.
 * All state changes must go through this module — no ad-hoc state updates.
 *
 * Valid lifecycle:
 * Received → Acknowledged → Accepted | Declined | Pending-Information → Scheduled → Encounter → Closed → Closed-Confirmed
 * Pending-Information → Acknowledged (info received) | Declined (timeout)
 */

export const ReferralState = {
  RECEIVED: 'Received',
  ACKNOWLEDGED: 'Acknowledged',
  PENDING_INFORMATION: 'Pending-Information',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  SCHEDULED: 'Scheduled',
  ENCOUNTER: 'Encounter',
  CLOSED: 'Closed',
  CLOSED_CONFIRMED: 'Closed-Confirmed',
} as const;

export type ReferralState = (typeof ReferralState)[keyof typeof ReferralState];

// Defines which transitions are valid from each state
const VALID_TRANSITIONS: Record<ReferralState, ReferralState[]> = {
  [ReferralState.RECEIVED]: [ReferralState.ACKNOWLEDGED],
  [ReferralState.ACKNOWLEDGED]: [ReferralState.ACCEPTED, ReferralState.DECLINED, ReferralState.PENDING_INFORMATION],
  [ReferralState.PENDING_INFORMATION]: [ReferralState.ACKNOWLEDGED, ReferralState.DECLINED],
  [ReferralState.ACCEPTED]: [ReferralState.SCHEDULED],
  [ReferralState.DECLINED]: [], // terminal
  [ReferralState.SCHEDULED]: [ReferralState.ENCOUNTER],
  [ReferralState.ENCOUNTER]: [ReferralState.CLOSED],
  [ReferralState.CLOSED]: [ReferralState.CLOSED_CONFIRMED],
  [ReferralState.CLOSED_CONFIRMED]: [], // terminal
};

export class InvalidStateTransitionError extends Error {
  constructor(from: ReferralState, to: ReferralState) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Validates and returns the next state.
 * Throws InvalidStateTransitionError if the transition is not allowed.
 */
export function transition(current: ReferralState, next: ReferralState): ReferralState {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new InvalidStateTransitionError(current, next);
  }
  return next;
}

/**
 * Returns true if the given string is a valid ReferralState.
 */
export function isValidState(value: string): value is ReferralState {
  return Object.values(ReferralState).includes(value as ReferralState);
}
