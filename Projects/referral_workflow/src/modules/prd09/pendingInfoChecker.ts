/**
 * Pending Info Checker — PRD-09
 *
 * Background job that checks for Pending-Information referrals past their timeout.
 * Timeout action is determined by the skill that triggered the info request:
 * - auto-decline: decline the referral
 * - escalate: transition back to Acknowledged + flag priority
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { referrals, outboundMessages, skillExecutions } from '../../db/schema';
import { transition, ReferralState } from '../../state/referralStateMachine';
import { decline } from '../prd02/dispositionService';
import { config } from '../../config';
import { getSkillCatalog } from './skillLoader';

/**
 * Check all Pending-Information referrals for timeouts.
 * Returns the count of timed-out referrals processed.
 */
export async function checkPendingInfoTimeouts(): Promise<number> {
  const pending = await db
    .select()
    .from(referrals)
    .where(eq(referrals.state, ReferralState.PENDING_INFORMATION));

  if (pending.length === 0) return 0;

  let timedOutCount = 0;

  for (const referral of pending) {
    try {
      // Find the InfoRequest outbound message
      const [infoRequest] = await db
        .select()
        .from(outboundMessages)
        .where(
          and(
            eq(outboundMessages.referralId, referral.id),
            eq(outboundMessages.messageType, 'InfoRequest'),
          ),
        );

      if (!infoRequest) {
        console.warn(`[PendingInfoChecker] No InfoRequest message found for referral #${referral.id}`);
        continue;
      }

      // Find the skill that triggered the request
      const [execution] = await db
        .select()
        .from(skillExecutions)
        .where(
          and(
            eq(skillExecutions.referralId, referral.id),
            eq(skillExecutions.actionTaken, 'request-info'),
          ),
        );

      // Get timeout config from skill or use defaults
      const skill = execution ? getSkillCatalog().getSkill(execution.skillName) : null;
      const timeoutHours = skill?.timeoutHours ?? config.skills.pendingInfoTimeoutHours;
      const timeoutAction = skill?.timeoutAction ?? 'auto-decline';

      // Calculate elapsed time
      const sentTime = infoRequest.sentAt instanceof Date
        ? infoRequest.sentAt.getTime()
        : Number(infoRequest.sentAt) * 1000;
      const elapsedMs = Date.now() - sentTime;
      const elapsedHours = elapsedMs / (60 * 60 * 1000);

      if (elapsedHours < timeoutHours) continue;

      // Timeout exceeded — apply action
      timedOutCount++;
      console.log(
        `[PendingInfoChecker] Referral #${referral.id} timed out (${Math.round(elapsedHours)}h / ${timeoutHours}h). Action: ${timeoutAction}`,
      );

      if (timeoutAction === 'auto-decline') {
        await decline(
          referral.id,
          'SYSTEM-TIMEOUT',
          `Information request timed out after ${timeoutHours} hours. Skill: ${execution?.skillName ?? 'unknown'}`,
        );
      } else {
        // escalate: transition back to Acknowledged + flag priority
        await db
          .update(referrals)
          .set({
            state: ReferralState.ACKNOWLEDGED,
            priorityFlag: true,
            updatedAt: new Date(),
          })
          .where(eq(referrals.id, referral.id));
        console.log(`[PendingInfoChecker] Escalated referral #${referral.id} back to Acknowledged with priority flag`);
      }
    } catch (err) {
      console.error(`[PendingInfoChecker] Error processing referral #${referral.id}:`, err);
    }
  }

  if (timedOutCount > 0) {
    console.log(`[PendingInfoChecker] Processed ${timedOutCount} timed-out referral(s)`);
  }

  return timedOutCount;
}
