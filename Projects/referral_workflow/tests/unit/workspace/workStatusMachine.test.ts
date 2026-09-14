/**
 * Unit tests for workStatusMachine.ts (PRD-18)
 *
 * The machine is a pure guard, so these need no database. The three rules the
 * table genuinely encodes are asserted explicitly — the rest of the graph is
 * deliberately permissive and the tests say so rather than pretending otherwise.
 */

import {
  InvalidWorkStatusTransitionError,
  WorkStatus,
  allowedTransitions,
  isValidState,
  transition,
} from '../../../src/state/workStatusMachine';

const ALL: WorkStatus[] = Object.values(WorkStatus);

describe('workStatusMachine', () => {
  describe('WorkStatus', () => {
    it('has exactly seven statuses and starts the vocabulary at Triage', () => {
      expect(ALL).toHaveLength(7);
      expect(ALL).toContain(WorkStatus.TRIAGE);
    });

    it('does not include New — an unpicked workspace is an unassigned owner', () => {
      expect(ALL).not.toContain('New' as WorkStatus);
      expect(isValidState('New')).toBe(false);
    });
  });

  describe('isValidState()', () => {
    it('accepts every declared status', () => {
      for (const status of ALL) expect(isValidState(status)).toBe(true);
    });

    it('rejects arbitrary strings, casing variants and empty input', () => {
      for (const bad of ['', 'triage', 'TRIAGE', 'Done', 'Closed', 'In Progress', 'New']) {
        expect(isValidState(bad)).toBe(false);
      }
    });
  });

  describe('transition()', () => {
    it('returns the next status for every allowed transition', () => {
      for (const from of ALL) {
        for (const to of allowedTransitions(from)) {
          expect(transition(from, to)).toBe(to);
        }
      }
    });

    it('throws for every disallowed transition', () => {
      for (const from of ALL) {
        const allowed = allowedTransitions(from);
        for (const to of ALL) {
          if (allowed.includes(to)) continue;
          expect(() => transition(from, to)).toThrow(InvalidWorkStatusTransitionError);
        }
      }
    });

    it('never allows a self-transition', () => {
      for (const status of ALL) {
        expect(allowedTransitions(status)).not.toContain(status);
      }
    });

    it('names both statuses in the error message', () => {
      expect(() => transition(WorkStatus.RESOLVED, WorkStatus.TRIAGE)).toThrow(/Resolved → Triage/);
    });
  });

  // ── The three rules the table actually encodes ───────────────────────────

  describe('rule 1: Exception is reachable from everywhere', () => {
    it('holds for all six non-Exception statuses', () => {
      for (const from of ALL) {
        if (from === WorkStatus.EXCEPTION) continue;
        expect(allowedTransitions(from)).toContain(WorkStatus.EXCEPTION);
      }
    });
  });

  describe('rule 2: a reopen resumes work, it does not re-triage', () => {
    it('forbids Resolved → Triage and Follow-up-Required → Triage', () => {
      expect(allowedTransitions(WorkStatus.RESOLVED)).not.toContain(WorkStatus.TRIAGE);
      expect(allowedTransitions(WorkStatus.FOLLOW_UP_REQUIRED)).not.toContain(WorkStatus.TRIAGE);
    });

    it('offers In-Progress as the way back into active work from both', () => {
      expect(allowedTransitions(WorkStatus.RESOLVED)).toContain(WorkStatus.IN_PROGRESS);
      expect(allowedTransitions(WorkStatus.FOLLOW_UP_REQUIRED)).toContain(WorkStatus.IN_PROGRESS);
    });
  });

  describe('rule 3: no status is terminal', () => {
    it('gives every status at least one outbound transition', () => {
      for (const status of ALL) {
        expect(allowedTransitions(status).length).toBeGreaterThan(0);
      }
    });

    it('lets a Resolved workspace be reopened — archival is the end, not Resolved', () => {
      expect(transition(WorkStatus.RESOLVED, WorkStatus.IN_PROGRESS)).toBe(WorkStatus.IN_PROGRESS);
    });
  });

  describe('the four active statuses are freely interchangeable', () => {
    const ACTIVE = [
      WorkStatus.TRIAGE,
      WorkStatus.IN_PROGRESS,
      WorkStatus.WAITING_EXTERNAL,
      WorkStatus.WAITING_INTERNAL,
    ];

    it('allows every pairing among them', () => {
      for (const from of ACTIVE) {
        for (const to of ACTIVE) {
          if (from === to) continue;
          expect(transition(from, to)).toBe(to);
        }
      }
    });
  });

  describe('allowedTransitions()', () => {
    it('returns a copy, so a caller cannot mutate the table', () => {
      const first = allowedTransitions(WorkStatus.TRIAGE);
      first.push(WorkStatus.TRIAGE);
      expect(allowedTransitions(WorkStatus.TRIAGE)).not.toContain(WorkStatus.TRIAGE);
    });
  });
});
