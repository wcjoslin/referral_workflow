/**
 * PRD-26 — the next-action rule table.
 *
 * WHY THIS IS ITS OWN MODULE rather than inline in config.ts, which is where
 * the PRD said to put it. Two reasons, and the second is the important one:
 *
 *   - it has NO environment dependency, unlike everything else in config.ts,
 *     which calls requireEnv() at import time
 *   - so the tests can import the REAL tables. The first version of the test
 *     suite mocked src/config and restated the whole table inside the mock,
 *     which meant every assertion was against a COPY — the suite would have
 *     stayed green while the shipped table was wrong. A rule table asserted
 *     against a duplicate of itself is not asserted at all.
 *
 * config.ts re-exports these under `config.workspace.nextActions`, so it is
 * still the single import site for configuration and this file is still the
 * single place a deadline is edited.
 */

/**
 * PRD-26 — what to do next, by when, and who owes the move.
 *
 * CONFIGURATION, NOT CODE. Changing a deadline must not require editing a
 * service, which is why this lives here beside `skills.pendingInfoTimeoutHours`
 * and `priorAuth.pendTimeoutMs` rather than inside nextActionService.
 *
 * THESE ARE NOT SLAs. There is no business-hours awareness, no holiday
 * calendar and no contractual basis — an offset of 48 hours means 48 elapsed
 * hours including a weekend. Stated plainly here rather than left for a reader
 * to assume, because "due in 4 hours" on a Friday evening looks like a promise.
 */
export interface NextActionRule {
  /** The plain instruction a coordinator reads. Not a status to decode. */
  action: string;
  /**
   * Hours from the moment the state was entered, or null for no deadline.
   *
   * `'appointment'` means the due date IS the appointment date — the one rule
   * that cannot be expressed as an offset. When the referral has no appointment
   * date, there is no due date: a fabricated one would be worse than none
   * (AC8's principle applied to the case the draft table left as prose).
   */
  dueInHours: number | 'appointment' | null;
  awaitedBy: 'us' | 'party' | 'nobody';
}

/**
 * Keyed `<ReferralState>|<WorkStatus>`, checked before the state-only table.
 * Only combinations whose action differs from the state default belong here.
 */
export const NEXT_ACTION_BY_STATE_AND_WORK_STATUS: Record<string, NextActionRule> = {
  'Acknowledged|Triage': {
    action: 'Review the clinical information and accept or decline the referral',
    dueInHours: 24,
    awaitedBy: 'us',
  },
  'Accepted|In-Progress': {
    action: 'Schedule the patient and notify the referring office',
    dueInHours: 48,
    awaitedBy: 'us',
  },
  'Scheduled|Waiting-External': {
    action: 'Awaiting the appointment — confirm the patient attends',
    dueInHours: 'appointment',
    awaitedBy: 'party',
  },
  'Closed-Confirmed|Follow-up-Required': {
    action: 'Complete the outstanding internal follow-up, then resolve',
    dueInHours: 72,
    awaitedBy: 'us',
  },
  'Closed-Confirmed|Resolved': {
    action: 'No action required',
    dueInHours: null,
    awaitedBy: 'nobody',
  },
  'Declined|Resolved': {
    action: 'No action required',
    dueInHours: null,
    awaitedBy: 'nobody',
  },
};

/** The fallback, one rule per protocol state. Every state is present. */
export const NEXT_ACTION_BY_STATE: Record<string, NextActionRule> = {
  Received: {
    action: 'Acknowledge receipt of the referral',
    dueInHours: 4,
    awaitedBy: 'us',
  },
  Acknowledged: {
    action: 'Review the clinical information and accept or decline the referral',
    dueInHours: 24,
    awaitedBy: 'us',
  },
  'Pending-Information': {
    action: 'Follow up with the referring office for the missing information',
    dueInHours: 48,
    awaitedBy: 'party',
  },
  Accepted: {
    action: 'Schedule the patient and notify the referring office',
    dueInHours: 48,
    awaitedBy: 'us',
  },
  Declined: {
    action: 'No action required — the referral was declined',
    dueInHours: null,
    awaitedBy: 'nobody',
  },
  Scheduled: {
    action: 'Awaiting the appointment — confirm the patient attends',
    dueInHours: 'appointment',
    awaitedBy: 'party',
  },
  'No-Show': {
    action: 'Contact the patient and reschedule',
    dueInHours: 24,
    awaitedBy: 'us',
  },
  Encounter: {
    action: 'Complete the encounter and send the consult note',
    dueInHours: 72,
    awaitedBy: 'us',
  },
  Consult: {
    action: 'Resolve the consultation request',
    dueInHours: 48,
    awaitedBy: 'us',
  },
  Closed: {
    action: 'Awaiting acknowledgement of the consult note',
    dueInHours: 48,
    awaitedBy: 'party',
  },
  'Closed-Confirmed': {
    action: 'Confirm nothing is outstanding, then resolve',
    dueInHours: 24,
    awaitedBy: 'us',
  },
};

/**
 * Work statuses whose action overrides the protocol state entirely, whatever
 * the state is. An exception is the thing to deal with; what the protocol
 * happens to say meanwhile is not the next action.
 */
export const NEXT_ACTION_BY_WORK_STATUS: Record<string, NextActionRule> = {
  Exception: {
    action: 'Review and resolve the exception',
    dueInHours: 8,
    awaitedBy: 'us',
  },
};
