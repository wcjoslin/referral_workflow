import {
  transition,
  isValidState,
  ReferralState,
  InvalidStateTransitionError,
} from '../../src/state/referralStateMachine';

describe('referralStateMachine', () => {
  describe('valid transitions', () => {
    it('Received → Acknowledged', () => {
      expect(transition(ReferralState.RECEIVED, ReferralState.ACKNOWLEDGED)).toBe(
        ReferralState.ACKNOWLEDGED,
      );
    });

    it('Acknowledged → Accepted', () => {
      expect(transition(ReferralState.ACKNOWLEDGED, ReferralState.ACCEPTED)).toBe(
        ReferralState.ACCEPTED,
      );
    });

    it('Acknowledged → Declined', () => {
      expect(transition(ReferralState.ACKNOWLEDGED, ReferralState.DECLINED)).toBe(
        ReferralState.DECLINED,
      );
    });

    it('Accepted → Scheduled', () => {
      expect(transition(ReferralState.ACCEPTED, ReferralState.SCHEDULED)).toBe(
        ReferralState.SCHEDULED,
      );
    });

    it('Scheduled → Encounter', () => {
      expect(transition(ReferralState.SCHEDULED, ReferralState.ENCOUNTER)).toBe(
        ReferralState.ENCOUNTER,
      );
    });

    it('Scheduled → No-Show', () => {
      expect(transition(ReferralState.SCHEDULED, ReferralState.NO_SHOW)).toBe(
        ReferralState.NO_SHOW,
      );
    });

    it('No-Show → Scheduled', () => {
      expect(transition(ReferralState.NO_SHOW, ReferralState.SCHEDULED)).toBe(
        ReferralState.SCHEDULED,
      );
    });

    it('Encounter → Closed', () => {
      expect(transition(ReferralState.ENCOUNTER, ReferralState.CLOSED)).toBe(ReferralState.CLOSED);
    });

    it('Encounter → Consult', () => {
      expect(transition(ReferralState.ENCOUNTER, ReferralState.CONSULT)).toBe(
        ReferralState.CONSULT,
      );
    });

    it('Consult → Closed', () => {
      expect(transition(ReferralState.CONSULT, ReferralState.CLOSED)).toBe(ReferralState.CLOSED);
    });

    it('Closed → Closed-Confirmed', () => {
      expect(transition(ReferralState.CLOSED, ReferralState.CLOSED_CONFIRMED)).toBe(
        ReferralState.CLOSED_CONFIRMED,
      );
    });
  });

  describe('invalid transitions', () => {
    it('throws InvalidStateTransitionError for Received → Accepted (skipping Acknowledged)', () => {
      expect(() => transition(ReferralState.RECEIVED, ReferralState.ACCEPTED)).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('throws for Declined → Scheduled (Declined is terminal)', () => {
      expect(() => transition(ReferralState.DECLINED, ReferralState.SCHEDULED)).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('throws for Closed-Confirmed → anything (terminal state)', () => {
      expect(() =>
        transition(ReferralState.CLOSED_CONFIRMED, ReferralState.RECEIVED),
      ).toThrow(InvalidStateTransitionError);
    });

    it('error message names both states', () => {
      expect(() =>
        transition(ReferralState.RECEIVED, ReferralState.CLOSED),
      ).toThrow(/Received.*Closed/);
    });
  });

  describe('isValidState', () => {
    it('returns true for all valid states', () => {
      Object.values(ReferralState).forEach((state) => {
        expect(isValidState(state)).toBe(true);
      });
    });

    it('returns false for an unknown string', () => {
      expect(isValidState('WaitingRoom')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isValidState('')).toBe(false);
    });
  });
});
