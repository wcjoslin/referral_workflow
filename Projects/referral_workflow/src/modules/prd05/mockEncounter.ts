/**
 * Mock encounter trigger for the PRD-05 happy-path demo.
 *
 * Fires non-blocking after a referral is scheduled (from schedulingService).
 * Immediately marks the encounter as complete and sends an interim update.
 *
 * In production this would be replaced by an inbound ADT^A04 listener
 * connected to the EHR.
 */

import { markEncounterComplete } from './encounterService';

/**
 * Called (non-blocking) after a referral is scheduled.
 */
export async function onReferralScheduled(referralId: number): Promise<void> {
  await markEncounterComplete({
    referralId,
    sendInterimUpdate: true,
  });

  console.log(`[MockEncounter] Auto-marked encounter complete for referral #${referralId}`);
}
