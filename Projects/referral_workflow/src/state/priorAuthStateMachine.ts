/**
 * Prior Authorization State Machine
 *
 * Manages all valid state transitions for the Da Vinci PAS prior authorization lifecycle.
 * All state changes must go through this module — no ad-hoc state updates.
 *
 * Valid lifecycle:
 * Draft → Submitted → Approved (terminal)
 *                   → Denied (terminal)
 *                   → Pended → Approved (terminal)
 *                            → Denied (terminal)
 *                            → Expired (terminal)
 * Submitted → Error (terminal)
 */

export const PriorAuthState = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  APPROVED: 'Approved',
  DENIED: 'Denied',
  PENDED: 'Pended',
  EXPIRED: 'Expired',
  ERROR: 'Error',
} as const;

export type PriorAuthState = (typeof PriorAuthState)[keyof typeof PriorAuthState];

const VALID_TRANSITIONS: Record<PriorAuthState, PriorAuthState[]> = {
  [PriorAuthState.DRAFT]: [PriorAuthState.SUBMITTED],
  [PriorAuthState.SUBMITTED]: [PriorAuthState.APPROVED, PriorAuthState.DENIED, PriorAuthState.PENDED, PriorAuthState.ERROR],
  [PriorAuthState.PENDED]: [PriorAuthState.APPROVED, PriorAuthState.DENIED, PriorAuthState.EXPIRED],
  [PriorAuthState.APPROVED]: [],
  [PriorAuthState.DENIED]: [],
  [PriorAuthState.EXPIRED]: [],
  [PriorAuthState.ERROR]: [],
};

export class InvalidPriorAuthStateTransitionError extends Error {
  constructor(from: PriorAuthState, to: PriorAuthState) {
    super(`Invalid prior auth state transition: ${from} → ${to}`);
    this.name = 'InvalidPriorAuthStateTransitionError';
  }
}

/**
 * Validates and returns the next state.
 * Throws InvalidPriorAuthStateTransitionError if the transition is not allowed.
 */
export function transition(current: PriorAuthState, next: PriorAuthState): PriorAuthState {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new InvalidPriorAuthStateTransitionError(current, next);
  }
  return next;
}

/**
 * Returns true if the given string is a valid PriorAuthState.
 */
export function isValidState(value: string): value is PriorAuthState {
  return Object.values(PriorAuthState).includes(value as PriorAuthState);
}
