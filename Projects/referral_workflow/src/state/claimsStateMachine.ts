/**
 * Claims Attachment Request State Machine
 *
 * Manages all valid state transitions for the X12N 277/275 claims attachment lifecycle.
 * All state changes must go through this module — no ad-hoc state updates.
 *
 * Valid lifecycle:
 * Received → Processing → Pending-Signature → Sent
 */

export const ClaimsAttachmentState = {
  RECEIVED: 'Received',
  PROCESSING: 'Processing',
  PENDING_SIGNATURE: 'Pending-Signature',
  SENT: 'Sent',
} as const;

export type ClaimsAttachmentState = (typeof ClaimsAttachmentState)[keyof typeof ClaimsAttachmentState];

// Defines which transitions are valid from each state
const VALID_TRANSITIONS: Record<ClaimsAttachmentState, ClaimsAttachmentState[]> = {
  [ClaimsAttachmentState.RECEIVED]: [ClaimsAttachmentState.PROCESSING],
  [ClaimsAttachmentState.PROCESSING]: [ClaimsAttachmentState.PENDING_SIGNATURE],
  [ClaimsAttachmentState.PENDING_SIGNATURE]: [ClaimsAttachmentState.SENT],
  [ClaimsAttachmentState.SENT]: [], // terminal
};

export class InvalidClaimsStateTransitionError extends Error {
  constructor(from: ClaimsAttachmentState, to: ClaimsAttachmentState) {
    super(`Invalid claims state transition: ${from} → ${to}`);
    this.name = 'InvalidClaimsStateTransitionError';
  }
}

/**
 * Validates and returns the next state.
 * Throws InvalidClaimsStateTransitionError if the transition is not allowed.
 */
export function transition(current: ClaimsAttachmentState, next: ClaimsAttachmentState): ClaimsAttachmentState {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new InvalidClaimsStateTransitionError(current, next);
  }
  return next;
}

/**
 * Returns true if the given string is a valid ClaimsAttachmentState.
 */
export function isValidState(value: string): value is ClaimsAttachmentState {
  return Object.values(ClaimsAttachmentState).includes(value as ClaimsAttachmentState);
}
