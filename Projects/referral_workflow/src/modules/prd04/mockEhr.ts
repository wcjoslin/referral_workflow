/**
 * Mock EHR trigger for the PRD-04 happy-path demo.
 *
 * Fires non-blocking after a referral encounter is marked complete (from encounterService).
 * Loads the referral's FHIR patient ID (set during PRD-08 intake enrichment) and
 * fetches live clinical data from FHIR to build the consult note text.
 * Falls back to a hardcoded sample note if FHIR data is unavailable.
 *
 * In production this would be replaced by an inbound ORU^R01 listener
 * connected to the EHR system.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { referrals, patients } from '../../db/schema';
import { generateAndSend } from './consultNoteService';
import { getPatientSummaryById, getPatientSummary } from '../prd08/fhirClient';
import { formatConsultNoteFromFhir } from '../prd08/fhirConsultNote';

const FALLBACK_NOTE = `
Patient was referred for specialist evaluation.

Chief Complaint: Specialist consultation as per referral.

History of Present Illness:
The patient was referred for further evaluation. Please refer to the original referral documentation for clinical context.

Assessment:
Evaluation completed per referral request.

Plan:
1. Follow-up as clinically indicated.
2. Results communicated to referring provider.
`.trim();

/**
 * Called (non-blocking) after a referral encounter is marked complete.
 */
export async function onEncounterComplete(referralId: number): Promise<void> {
  let noteText = FALLBACK_NOTE;

  try {
    // Load referral + patient to get FHIR patient ID and reason
    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    if (!referral) throw new Error(`Referral #${referralId} not found`);

    const [patient] = await db.select().from(patients).where(eq(patients.id, referral.patientId));
    const reasonForReferral = referral.reasonForReferral ?? '';

    // Try to get FHIR patient ID from enriched clinical data
    let fhirPatientId: string | null = null;
    if (referral.clinicalData) {
      try {
        const clinical = JSON.parse(referral.clinicalData);
        fhirPatientId = clinical.fhirPatientId ?? null;
      } catch { /* ignore parse errors */ }
    }

    // Fetch FHIR summary — by ID if available, otherwise by demographics
    let summary = null;
    if (fhirPatientId) {
      summary = await getPatientSummaryById(fhirPatientId);
    } else if (patient) {
      summary = await getPatientSummary(patient.firstName, patient.lastName, patient.dateOfBirth);
    }

    if (summary) {
      noteText = formatConsultNoteFromFhir(summary, reasonForReferral);
      console.log(`[MockEHR] Built consult note from FHIR Patient/${summary.patient.id} for referral #${referralId}`);
    } else {
      console.warn(`[MockEHR] No FHIR data available for referral #${referralId} — using fallback note`);
    }
  } catch (err) {
    console.warn(`[MockEHR] FHIR lookup failed for referral #${referralId}, using fallback:`, err instanceof Error ? err.message : err);
  }

  await generateAndSend({ referralId, noteText });
  console.log(`[MockEHR] Auto-generated and sent consult note for referral #${referralId}`);
}
