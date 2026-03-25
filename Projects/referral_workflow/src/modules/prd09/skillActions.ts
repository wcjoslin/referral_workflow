/**
 * Skill Actions — PRD-09
 *
 * Executes the winning action from skill evaluation.
 * Each action type maps to a specific workflow operation.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { referrals } from '../../db/schema';
import { SkillEvalResult } from './skillEvaluator';
import { accept, decline } from '../prd02/dispositionService';

// ── Main Dispatcher ──────────────────────────────────────────────────────────

/**
 * Execute the winning skill action on a referral.
 * Test-mode results are skipped (logged only).
 */
export async function executeSkillAction(
  result: SkillEvalResult,
  referralId: number,
): Promise<void> {
  if (result.isTestMode) {
    console.log(
      `[SkillActions] Test mode — would have executed "${result.actionType}" for skill "${result.skillName}" on referral #${referralId}`,
    );
    return;
  }

  console.log(
    `[SkillActions] Executing "${result.actionType}" for skill "${result.skillName}" on referral #${referralId}`,
  );

  switch (result.actionType) {
    case 'auto-decline':
      await handleAutoDecline(result, referralId);
      break;
    case 'request-info':
      await handleRequestInfo(result, referralId);
      break;
    case 'flag-priority':
      await handleFlagPriority(result, referralId);
      break;
    case 'auto-accept':
      await handleAutoAccept(result, referralId);
      break;
    case 'custom-consult-routing':
      await handleCustomConsultRouting(result, referralId);
      break;
    default:
      console.warn(`[SkillActions] Unknown action type: ${result.actionType}`);
  }
}

// ── Action Handlers ──────────────────────────────────────────────────────────

async function handleAutoDecline(result: SkillEvalResult, referralId: number): Promise<void> {
  const clinicianId = `SYSTEM-SKILL-${result.skillName}`;
  await decline(referralId, clinicianId, result.explanation);
  console.log(`[SkillActions] Auto-declined referral #${referralId} via skill "${result.skillName}"`);
}

async function handleRequestInfo(result: SkillEvalResult, referralId: number): Promise<void> {
  // Lazy import to avoid circular dependency
  const { sendInfoRequest } = await import('./infoRequestService');
  await sendInfoRequest(referralId, result.explanation, result.skillName);
  console.log(`[SkillActions] Requested info for referral #${referralId} via skill "${result.skillName}"`);
}

async function handleFlagPriority(result: SkillEvalResult, referralId: number): Promise<void> {
  await db
    .update(referrals)
    .set({
      priorityFlag: true,
      updatedAt: new Date(),
    })
    .where(eq(referrals.id, referralId));
  console.log(`[SkillActions] Flagged referral #${referralId} as priority via skill "${result.skillName}"`);
}

async function handleAutoAccept(result: SkillEvalResult, referralId: number): Promise<void> {
  const clinicianId = `SYSTEM-SKILL-${result.skillName}`;
  await accept(referralId, clinicianId);
  console.log(`[SkillActions] Auto-accepted referral #${referralId} via skill "${result.skillName}"`);
}

async function handleCustomConsultRouting(result: SkillEvalResult, referralId: number): Promise<void> {
  // Store routing instructions in the clinicalData JSON for the consult note pipeline
  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!referral) return;

  const clinicalData = referral.clinicalData ? JSON.parse(referral.clinicalData) : {};
  clinicalData.consultRoutingInstructions = result.explanation;

  await db
    .update(referrals)
    .set({
      clinicalData: JSON.stringify(clinicalData),
      updatedAt: new Date(),
    })
    .where(eq(referrals.id, referralId));
  console.log(`[SkillActions] Stored consult routing instructions for referral #${referralId}`);
}
