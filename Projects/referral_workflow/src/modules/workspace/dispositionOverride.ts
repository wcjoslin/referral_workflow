/**
 * PRD-25 — the ONE place a referral may leave a terminal state.
 *
 * `POST /referrals/:id/override` lets a coordinator reverse a skill's
 * disposition. Two of the three reversals it performs are ordinary legal
 * transitions; one is not, and the difference matters:
 *
 *   Pending-Information → Acknowledged   LEGAL. Goes through transition().
 *   Declined            → Acknowledged   ILLEGAL. `Declined` is terminal:
 *                                        VALID_TRANSITIONS[DECLINED] is [].
 *
 * The draft of PRD-25 treated both as one bypass to be "routed through
 * transition()". That is not possible for the second without widening the
 * transition table, and widening it would mean every caller everywhere could
 * un-decline a referral — including the automated paths that decline them.
 *
 * SO THIS IS AN AUDITED EXCEPTION, deliberately chosen over a wider machine.
 * The rules it keeps:
 *
 *   - It is the only function in the codebase that writes a state the machine
 *     forbids. Every other state change goes through transition().
 *   - It records that it did so, in the event's metadata, as
 *     `bypassedStateMachine: true`. An auditor can find every one of them with
 *     a single query rather than by reading code.
 *   - It refuses anything other than the one transition it exists for. A reopen
 *     from any other state is an error, not a silent write.
 *
 * WHAT IT IS NOT: a fix. Reopening a declined referral is arguably a new
 * referral in 360X terms, and the protocol-correct answer is to create one. That
 * is a larger change than this PRD, and it is recorded in PRD-25 as the open
 * question rather than hidden behind a function that looks tidy.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { referrals } from '../../db/schema';
import { ReferralState, transition } from '../../state/referralStateMachine';
import { emitEvent } from '../analytics/eventService';
import { ReferralEvents } from './eventCatalog';

export class NotReopenableError extends Error {
  constructor(state: string) {
    super(
      `A referral in ${state} is not reopenable. Only Declined and ` +
        `Pending-Information can be returned to Acknowledged.`,
    );
    this.name = 'NotReopenableError';
  }
}

export interface ReopenResult {
  fromState: ReferralState;
  toState: ReferralState;
  /** True only for the Declined case — the one that the machine forbids. */
  bypassedStateMachine: boolean;
}

/**
 * Returns a declined or pending-information referral to Acknowledged.
 *
 * Uses `transition()` where the transition is legal and the audited exception
 * only where it is not, so the exception stays as small as the problem.
 */
export async function reopenReferral(
  referralId: number,
  actor: string,
  reason?: string,
): Promise<ReopenResult> {
  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId)).limit(1);
  if (!referral) throw new NotReopenableError('an unknown state');

  const fromState = referral.state as ReferralState;
  let bypassedStateMachine: boolean;

  if (fromState === ReferralState.PENDING_INFORMATION) {
    // LEGAL. Let the machine validate it, exactly like every other transition.
    transition(fromState, ReferralState.ACKNOWLEDGED);
    bypassedStateMachine = false;
    await db
      .update(referrals)
      .set({ state: ReferralState.ACKNOWLEDGED, updatedAt: new Date() })
      .where(eq(referrals.id, referralId));
  } else if (fromState === ReferralState.DECLINED) {
    // ILLEGAL, and this is the only place it happens. The decline reason and the
    // clinician who was recorded against the decline are cleared, because
    // leaving them would attribute a decline to somebody on a live referral.
    bypassedStateMachine = true;
    await db
      .update(referrals)
      .set({
        state: ReferralState.ACKNOWLEDGED,
        declineReason: null,
        clinicianId: null,
        updatedAt: new Date(),
      })
      .where(eq(referrals.id, referralId));
  } else {
    throw new NotReopenableError(fromState);
  }

  await emitEvent({
    eventType: ReferralEvents.DISPOSITION_OVERRIDDEN,
    entityType: 'referral',
    entityId: referralId,
    fromState,
    toState: ReferralState.ACKNOWLEDGED,
    actor,
    metadata: {
      // The fact an auditor needs, recorded rather than inferable from code.
      bypassedStateMachine,
      ...(reason ? { reason } : {}),
    },
  });

  return { fromState, toState: ReferralState.ACKNOWLEDGED, bypassedStateMachine };
}
