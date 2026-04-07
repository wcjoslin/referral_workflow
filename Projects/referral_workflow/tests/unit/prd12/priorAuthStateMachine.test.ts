/**
 * Unit tests for priorAuthStateMachine.ts
 */

import {
  PriorAuthState,
  transition,
  isValidState,
  InvalidPriorAuthStateTransitionError,
} from '../../../src/state/priorAuthStateMachine';

describe('PriorAuthStateMachine', () => {
  describe('transition()', () => {
    // Valid transitions
    it('Draft → Submitted', () => {
      expect(transition(PriorAuthState.DRAFT, PriorAuthState.SUBMITTED)).toBe(PriorAuthState.SUBMITTED);
    });

    it('Submitted → Approved', () => {
      expect(transition(PriorAuthState.SUBMITTED, PriorAuthState.APPROVED)).toBe(PriorAuthState.APPROVED);
    });

    it('Submitted → Denied', () => {
      expect(transition(PriorAuthState.SUBMITTED, PriorAuthState.DENIED)).toBe(PriorAuthState.DENIED);
    });

    it('Submitted → Pended', () => {
      expect(transition(PriorAuthState.SUBMITTED, PriorAuthState.PENDED)).toBe(PriorAuthState.PENDED);
    });

    it('Submitted → Error', () => {
      expect(transition(PriorAuthState.SUBMITTED, PriorAuthState.ERROR)).toBe(PriorAuthState.ERROR);
    });

    it('Pended → Approved', () => {
      expect(transition(PriorAuthState.PENDED, PriorAuthState.APPROVED)).toBe(PriorAuthState.APPROVED);
    });

    it('Pended → Denied', () => {
      expect(transition(PriorAuthState.PENDED, PriorAuthState.DENIED)).toBe(PriorAuthState.DENIED);
    });

    it('Pended → Expired', () => {
      expect(transition(PriorAuthState.PENDED, PriorAuthState.EXPIRED)).toBe(PriorAuthState.EXPIRED);
    });

    // Invalid transitions from terminal states
    it.each([
      [PriorAuthState.APPROVED, PriorAuthState.DENIED],
      [PriorAuthState.APPROVED, PriorAuthState.SUBMITTED],
      [PriorAuthState.DENIED, PriorAuthState.APPROVED],
      [PriorAuthState.DENIED, PriorAuthState.SUBMITTED],
      [PriorAuthState.EXPIRED, PriorAuthState.APPROVED],
      [PriorAuthState.EXPIRED, PriorAuthState.PENDED],
      [PriorAuthState.ERROR, PriorAuthState.SUBMITTED],
      [PriorAuthState.ERROR, PriorAuthState.APPROVED],
    ])('throws for terminal state %s → %s', (from, to) => {
      expect(() => transition(from, to)).toThrow(InvalidPriorAuthStateTransitionError);
    });

    // Invalid transitions — skip states
    it('throws for Draft → Approved (skipping Submitted)', () => {
      expect(() => transition(PriorAuthState.DRAFT, PriorAuthState.APPROVED)).toThrow(
        InvalidPriorAuthStateTransitionError,
      );
    });

    it('throws for Draft → Pended (skipping Submitted)', () => {
      expect(() => transition(PriorAuthState.DRAFT, PriorAuthState.PENDED)).toThrow(
        InvalidPriorAuthStateTransitionError,
      );
    });

    it('throws for Pended → Submitted (backward)', () => {
      expect(() => transition(PriorAuthState.PENDED, PriorAuthState.SUBMITTED)).toThrow(
        InvalidPriorAuthStateTransitionError,
      );
    });
  });

  describe('isValidState()', () => {
    it('returns true for all valid states', () => {
      const allStates = Object.values(PriorAuthState);
      allStates.forEach((state) => {
        expect(isValidState(state)).toBe(true);
      });
    });

    it('returns false for invalid strings', () => {
      expect(isValidState('InvalidState')).toBe(false);
      expect(isValidState('')).toBe(false);
      expect(isValidState('Pending')).toBe(false);
    });
  });

  describe('PriorAuthState constants', () => {
    it('has expected state values', () => {
      expect(PriorAuthState.DRAFT).toBe('Draft');
      expect(PriorAuthState.SUBMITTED).toBe('Submitted');
      expect(PriorAuthState.APPROVED).toBe('Approved');
      expect(PriorAuthState.DENIED).toBe('Denied');
      expect(PriorAuthState.PENDED).toBe('Pended');
      expect(PriorAuthState.EXPIRED).toBe('Expired');
      expect(PriorAuthState.ERROR).toBe('Error');
    });

    it('has 7 total states', () => {
      expect(Object.keys(PriorAuthState)).toHaveLength(7);
    });
  });

  describe('InvalidPriorAuthStateTransitionError', () => {
    it('has descriptive message', () => {
      const err = new InvalidPriorAuthStateTransitionError(PriorAuthState.DRAFT, PriorAuthState.APPROVED);
      expect(err.message).toBe('Invalid prior auth state transition: Draft → Approved');
      expect(err.name).toBe('InvalidPriorAuthStateTransitionError');
    });
  });
});
