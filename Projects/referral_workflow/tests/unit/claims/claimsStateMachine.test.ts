/**
 * Claims State Machine Tests
 */

import { transition, isValidState, InvalidClaimsStateTransitionError, ClaimsAttachmentState } from '../../../src/state/claimsStateMachine';

describe('ClaimsStateMachine', () => {
  describe('transition', () => {
    it('should transition Received → Processing', () => {
      const result = transition(ClaimsAttachmentState.RECEIVED, ClaimsAttachmentState.PROCESSING);
      expect(result).toBe(ClaimsAttachmentState.PROCESSING);
    });

    it('should transition Processing → Pending-Signature', () => {
      const result = transition(ClaimsAttachmentState.PROCESSING, ClaimsAttachmentState.PENDING_SIGNATURE);
      expect(result).toBe(ClaimsAttachmentState.PENDING_SIGNATURE);
    });

    it('should transition Pending-Signature → Sent', () => {
      const result = transition(ClaimsAttachmentState.PENDING_SIGNATURE, ClaimsAttachmentState.SENT);
      expect(result).toBe(ClaimsAttachmentState.SENT);
    });

    it('should throw for invalid transition Received → Sent', () => {
      expect(() => transition(ClaimsAttachmentState.RECEIVED, ClaimsAttachmentState.SENT)).toThrow(
        InvalidClaimsStateTransitionError,
      );
    });

    it('should throw for invalid transition Sent → Processing', () => {
      expect(() => transition(ClaimsAttachmentState.SENT, ClaimsAttachmentState.PROCESSING)).toThrow(
        InvalidClaimsStateTransitionError,
      );
    });

    it('should throw for invalid transition Processing → Received', () => {
      expect(() => transition(ClaimsAttachmentState.PROCESSING, ClaimsAttachmentState.RECEIVED)).toThrow(
        InvalidClaimsStateTransitionError,
      );
    });

    it('should throw for Sent (terminal state)', () => {
      expect(() => transition(ClaimsAttachmentState.SENT, ClaimsAttachmentState.PROCESSING)).toThrow(
        InvalidClaimsStateTransitionError,
      );
    });
  });

  describe('isValidState', () => {
    it('should return true for Received', () => {
      expect(isValidState('Received')).toBe(true);
    });

    it('should return true for Processing', () => {
      expect(isValidState('Processing')).toBe(true);
    });

    it('should return true for Pending-Signature', () => {
      expect(isValidState('Pending-Signature')).toBe(true);
    });

    it('should return true for Sent', () => {
      expect(isValidState('Sent')).toBe(true);
    });

    it('should return false for invalid state', () => {
      expect(isValidState('InvalidState')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidState('')).toBe(false);
    });
  });
});
