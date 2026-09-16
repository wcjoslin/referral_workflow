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
import { parseExtendedCda } from '../prd01/cdaParser';
import { transition, ReferralState } from '../../state/referralStateMachine';
import { assessRouting, RoutingAssessment } from './claudeService';
import { buildRri } from './rriBuilder';
import { sendRriMessage } from './dispositionService';
import { enrichWithFhir } from '../prd08/fhirEnrichment';
import { evaluateSkills } from '../prd09/skillEvaluator';
import { executeSkillAction } from '../prd09/skillActions';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { emitEvent } from '../analytics/eventService';
import { createWorkspace } from '../workspace/workspaceService';
import { recordThreadMessage } from '../messaging/threadService';

// In-memory store for routing assessments, keyed by referralId.
// Cleared on process restart — acceptable for PoC.
const assessmentCache = new Map<number, RoutingAssessment>();

export function getCachedAssessment(referralId: number): RoutingAssessment | undefined {
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
    await autoDecline(
      referralData.sourceMessageId,
      processed.referrerAddress,
      referralData.validationErrors,
      { rawCcdaXml: rawCdaXml ?? null },
    );
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
    await autoDecline(extended.sourceMessageId, processed.referrerAddress, extended.validationErrors, {
      rawCcdaXml: rawCdaXml,
      // The extended parse reached far enough to name the patient even though it
      // failed validation, so the record can say who it was about.
      patientName: extended.patient
        ? `${extended.patient.firstName} ${extended.patient.lastName}`.trim()
        : null,
      patientDob: extended.patient?.dateOfBirth ?? null,
    });
    return null;
  }

  // FHIR enrichment — fills missing optional sections with live FHIR data
  const enriched = await enrichWithFhir(extended);

  // PRD-28 AC18: look for an existing patient BEFORE inserting.
  //
  // There is no MRN, no FHIR id and no dedupe key on `patients`, so every
  // inbound referral has always created a new row — the same person referred
  // twice is two patients. Detection is deterministic on surname plus date of
  // birth, and it FLAGS rather than merges.
  //
  // The insert still happens. Automatic merging in a clinical system is a
  // patient-safety risk — merging two people's records wrongly is materially
  // worse than carrying two records for one person — so the referral proceeds
  // normally and a human decides.
  const { findPotentialDuplicatePatients } = await import('../workspace/correlationService');
  const duplicateIds = await findPotentialDuplicatePatients(
    extended.patient.lastName,
    extended.patient.dateOfBirth,
  ).catch((err) => {
    console.error('[ReferralService] duplicate patient check failed', err);
    return [] as number[];
  });

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

  // Analytics: referral received + acknowledged
  void emitEvent({
    eventType: 'referral.received',
    entityType: 'referral',
    entityId: referral.id,
    toState: ReferralState.RECEIVED,
    actor: 'system',
    metadata: { sourceMessageId: extended.sourceMessageId, referrerAddress: processed.referrerAddress },
  }).catch((err) => console.error('[EventService]', err));

  void emitEvent({
    eventType: 'referral.acknowledged',
    entityType: 'referral',
    entityId: referral.id,
    fromState: ReferralState.RECEIVED,
    toState: ReferralState.ACKNOWLEDGED,
    actor: 'system',
    metadata: { sourceMessageId: extended.sourceMessageId },
  }).catch((err) => console.error('[EventService]', err));

  // PRD-18: every referral gets a workspace, created in the same operation that
  // created the referral, so "a referral without a workspace" is not reachable.
  // Starts at Triage with no owner.
  //
  // The auto-decline path deliberately does NOT reach here: autoDecline() writes
  // no referral row at all, so there is nothing to attach a workspace to.
  // PRD-28's auto_declined_referrals is what makes those decisions reviewable.
  const workspace = await createWorkspace(referral.id);

  // PRD-28 AC19: raised after the workspace exists, so the exception attaches
  // to something a coordinator can open. Fire-and-forget through the safe
  // wrapper: a duplicate flag must never fail an ingest.
  if (duplicateIds.length > 0) {
    const { flagDuplicatePatient } = await import('../workspace/exceptionService');
    await flagDuplicatePatient({
      newPatientId: patient.id,
      existingPatientIds: duplicateIds,
      patientName: `${extended.patient.firstName} ${extended.patient.lastName}`.trim(),
      patientDob: extended.patient.dateOfBirth,
      workspaceId: workspace.id,
    }).catch((err) => console.error('[ReferralService] duplicate patient flag failed', err));
  }

  // Record inbound referral in message thread
  await recordThreadMessage({
    referralId: referral.id,
    direction: 'inbound',
    messageType: 'ReferralCCDA',
    subject: `Inbound Referral — ${extended.patient.lastName}, ${extended.patient.firstName}`,
    summary: `Inbound referral received from ${processed.referrerAddress}`,
    senderAddress: processed.referrerAddress,
    recipientAddress: config.receiving.directAddress,
    contentXml: rawCdaXml,
    relatedStateTransition: 'Received->Acknowledged',
  });

  console.log(`[ReferralService] Referral #${referral.id} created and acknowledged for patient ${extended.patient.firstName} ${extended.patient.lastName}`);

  // Fire Gemini routing assessment in background — do not await
  assessRouting(extended)
    .then(async (assessment) => {
      assessmentCache.set(referral.id, assessment);
      await db
        .update(referrals)
        .set({
          aiAssessment: JSON.stringify(assessment),
          routingDepartment: assessment.department,
          routingEquipment: JSON.stringify(
            assessment.requiredEquipment.filter((e) => e.supported).map((e) => e.resourceId),
          ),
        })
        .where(eq(referrals.id, referral.id));
      void emitEvent({
        eventType: 'referral.routing_assessed',
        entityType: 'referral',
        entityId: referral.id,
        actor: 'system',
        metadata: { department: assessment.department, departmentConfidence: assessment.departmentConfidence, warnings: assessment.warnings },
      }).catch((err) => console.error('[EventService]', err));

      console.log(`[ReferralService] Routing assessment complete for referral #${referral.id}: department=${assessment.department}`);
    })
    .catch((err) => {
      console.error(`[ReferralService] Routing assessment failed for referral #${referral.id}:`, err);
      const fallback: RoutingAssessment = {
        department: 'Unassigned',
        departmentConfidence: 0,
        requiredEquipment: [],
        summary: 'Routing suggestion unavailable.',
        warnings: [],
      };
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
 * Sends an auto-decline RRI and records the decision durably.
 *
 * PRD-28 AC15–AC17. This used to send the RRI and DISCARD everything: no
 * referral row, no patient row, no retained document, and
 * `referral.auto_declined` emitted with `entityId: 0`. The decision most worth
 * reviewing — did our validation gates reject a legitimate referral? — was the
 * least visible thing the system did.
 *
 * `auto_declined_referrals` now retains the inbound C-CDA and the reasons, and
 * an `auto-declined` exception puts it in front of a human who can convert it
 * into a real referral when the decline was wrong.
 *
 * Still NO referral row, deliberately: creating one would put a referral into
 * the protocol that the counterparty has already been told was rejected.
 */
async function autoDecline(
  sourceMessageId: string,
  referrerAddress: string,
  reasons: string[],
  detail: { rawCcdaXml?: string | null; patientName?: string | null; patientDob?: string | null } = {},
): Promise<void> {
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

  // PRD-28: recorded BEFORE the send, and awaited.
  //
  // Ordering matters. A send failure must not lose the artifact — that is the
  // exact combination that makes an auto-decline unreviewable, because the
  // counterparty may not even have been told. Recording first means the worst
  // case is a retained record whose RRI never went out, which a human can see
  // and act on.
  let autoDeclinedId: number | null = null;
  try {
    const { recordAutoDeclined } = await import('../workspace/exceptionService');
    const recorded = await recordAutoDeclined({
      sourceMessageId,
      referrerAddress: referrerAddress || '(unknown sender)',
      patientName: detail.patientName ?? null,
      patientDob: detail.patientDob ?? null,
      declineReasons: reasons,
      rawCcdaXml: detail.rawCcdaXml ?? null,
    });
    autoDeclinedId = recorded.autoDeclinedId;
  } catch (err) {
    // Loudly: this is the data-loss path the whole change exists to close.
    console.error(
      `[ReferralService] FAILED to record auto-decline for ${sourceMessageId} — the inbound document is not retained:`,
      err,
    );
  }

  try {
    await sendRriMessage(rriMessage, referrerAddress, messageControlId, null, 'AR');

    void emitEvent({
      eventType: 'referral.auto_declined',
      entityType: 'referral',
      // AC16: associated with the durable record rather than 0. Negative,
      // because the auto-decline table is a different keyspace from referrals
      // and a consumer that ignores entityType must not read it as a referral
      // id. 0 remains the fallback when recording itself failed.
      entityId: autoDeclinedId === null ? 0 : -autoDeclinedId,
      actor: 'system',
      metadata: { sourceMessageId, reasons, referrerAddress, autoDeclinedId },
    }).catch((err) => console.error('[EventService]', err));

    console.log(`[ReferralService] Auto-decline RRI sent for ${sourceMessageId}`);
  } catch (err) {
    console.error(`[ReferralService] Failed to send auto-decline RRI for ${sourceMessageId}:`, err);
  }
}
