/**
 * PRD-02 referral ingestion service.
 *
 * Receives a ProcessedMessage from PRD-01 and:
 *   1. Runs extended C-CDA parsing (payer, problems, allergies, medications, diagnostics)
 *   2. Auto-declines if required sections are missing — no DB write, RRI sent
 *   3. Writes patient + referral records to SQLite (state: Received → Acknowledged)
 *   4. Fires Claude sufficiency assessment as a non-blocking background call
 *   5. Returns the new referralId for routing to the clinician review UI
 */

import { db } from '../../db';
import { patients, referrals } from '../../db/schema';
import { config } from '../../config';
import { ProcessedMessage } from '../prd01/messageProcessor';
import { parseExtendedCda, ExtendedReferralData } from '../prd01/cdaParser';
import { transition, ReferralState } from '../../state/referralStateMachine';
import { assessSufficiency, SufficiencyAssessment } from './claudeService';
import { buildRri } from './rriBuilder';
import { sendRriMessage } from './dispositionService';
import { enrichWithFhir } from '../prd08/fhirEnrichment';
import { evaluateSkills } from '../prd09/skillEvaluator';
import { executeSkillAction } from '../prd09/skillActions';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

// In-memory store for Claude assessments, keyed by referralId.
// Cleared on process restart — acceptable for PoC.
const assessmentCache = new Map<number, SufficiencyAssessment>();

export function getCachedAssessment(referralId: number): SufficiencyAssessment | undefined {
  return assessmentCache.get(referralId);
}

/**
 * Ingests a processed inbound message into PRD-02.
 *
 * Returns the new referralId on success, or null if the referral was auto-declined.
 */
export async function ingestReferral(processed: ProcessedMessage): Promise<number | null> {
  const { referralData, rawCdaXml } = processed;

  // Gate 1: base parse failed (no attachment or BlueButton threw)
  if (!referralData.isCdaValid) {
    console.warn('[ReferralService] Auto-declining — base CDA invalid:', referralData.validationErrors);
    await autoDecline(referralData.sourceMessageId, processed.referrerAddress, referralData.validationErrors);
    return null;
  }

  if (!rawCdaXml) {
    console.warn('[ReferralService] Auto-declining — no raw CDA XML available');
    await autoDecline(referralData.sourceMessageId, '', ['No C-CDA attachment found']);
    return null;
  }

  // Gate 2: extended parse — checks payer and required sections
  const extended = parseExtendedCda(rawCdaXml, referralData.sourceMessageId);

  if (!extended.isCdaValid) {
    console.warn('[ReferralService] Auto-declining — required sections missing:', extended.validationErrors);
    await autoDecline(
      extended.sourceMessageId,
      processed.referrerAddress,
      extended.validationErrors,
    );
    return null;
  }

  // FHIR enrichment — fills missing optional sections with live FHIR data
  const enriched = await enrichWithFhir(extended);

  // Write patient record
  const [patient] = await db
    .insert(patients)
    .values({
      firstName: extended.patient.firstName,
      lastName: extended.patient.lastName,
      dateOfBirth: extended.patient.dateOfBirth,
    })
    .returning({ id: patients.id });

  // Write referral record in Received state
  const now = new Date();
  const [referral] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      sourceMessageId: extended.sourceMessageId,
      referrerAddress: processed.referrerAddress,
      reasonForReferral: extended.reasonForReferral,
      clinicalData: JSON.stringify(enriched),
      rawCcdaXml: rawCdaXml,
      state: ReferralState.RECEIVED,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: referrals.id });

  // Immediately transition Received → Acknowledged (MDN was already sent by PRD-01)
  const nextState = transition(ReferralState.RECEIVED, ReferralState.ACKNOWLEDGED);
  await db
    .update(referrals)
    .set({ state: nextState, updatedAt: new Date() })
    .where(eq(referrals.id, referral.id));

  console.log(`[ReferralService] Referral #${referral.id} created and acknowledged for patient ${extended.patient.firstName} ${extended.patient.lastName}`);

  // Fire Gemini assessment in background — do not await
  assessSufficiency(extended)
    .then(async (assessment) => {
      assessmentCache.set(referral.id, assessment);
      await db
        .update(referrals)
        .set({ aiAssessment: JSON.stringify(assessment) })
        .where(eq(referrals.id, referral.id));
      console.log(`[ReferralService] Claude assessment complete for referral #${referral.id}: sufficient=${assessment.sufficient}`);
    })
    .catch((err) => {
      console.error(`[ReferralService] Claude assessment failed for referral #${referral.id}:`, err);
      const fallback = { sufficient: true, summary: 'AI assessment unavailable.', concerns: [] };
      assessmentCache.set(referral.id, fallback);
    });

  // PRD-09: fire skill evaluation in background (non-blocking)
  void evaluateSkills('post-intake', referral.id)
    .then(async (evalResult) => {
      if (evalResult.winningAction && !evalResult.winningAction.isTestMode) {
        await executeSkillAction(evalResult.winningAction, referral.id);
      }
    })
    .catch((err) => {
      console.error(`[SkillEvaluator] Post-intake evaluation failed for referral #${referral.id}:`, err);
    });

  return referral.id;
}

/**
 * Sends an auto-decline RRI and logs the event.
 * No DB record is created for auto-declined referrals.
 */
async function autoDecline(sourceMessageId: string, referrerAddress: string, reasons: string[]): Promise<void> {
  const messageControlId = randomUUID();
  const declineReason = `Incomplete C-CDA: ${reasons.join('; ')}`;

  const rriMessage = buildRri({
    messageControlId,
    sourceMessageId,
    referrerAddress,
    sendingFacility: config.receiving.directAddress,
    acceptCode: 'AR',
    declineReason,
  });

  try {
    await sendRriMessage(rriMessage, referrerAddress, messageControlId, null, 'AR');
    console.log(`[ReferralService] Auto-decline RRI sent for ${sourceMessageId}`);
  } catch (err) {
    console.error(`[ReferralService] Failed to send auto-decline RRI for ${sourceMessageId}:`, err);
  }
}
