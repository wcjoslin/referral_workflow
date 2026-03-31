/**
 * Claims Document Service
 *
 * Orchestrates FHIR queries and C-CDA document building for attachment requests.
 * For each LOINC code in the request, queries FHIR and builds a C-CDA document.
 */

import { db } from '../../../db';
import { attachmentRequests, attachmentResponses, patients } from '../../../db/schema';
import { ClaimsAttachmentState, transition } from '../../../state/claimsStateMachine';
import {
  getConditions,
  getAllergyIntolerances,
  getMedications,
  getObservations,
  getEncounters,
} from '../../prd08/fhirClient';
import { getDocumentTypeForLoinc } from '../intake/loincMapper';
import { buildClaimsCcda } from './claimsCcdaBuilder';
import { eq } from 'drizzle-orm';

/**
 * Build documents for a request.
 * Queries FHIR for each LOINC code and generates C-CDA documents.
 * Transitions request state to Pending-Signature when complete.
 */
export async function buildDocumentsForRequest(requestId: number): Promise<void> {
  console.log(`[ClaimsDocumentService] Building documents for request ${requestId}`);

  try {
    // Get request
    const [request] = await db.select().from(attachmentRequests).where(eq(attachmentRequests.id, requestId));

    if (!request) {
      throw new Error(`Request not found: ${requestId}`);
    }

    // Get patient
    let patient;
    if (request.patientId) {
      const [p] = await db.select().from(patients).where(eq(patients.id, request.patientId));
      patient = p;
    } else {
      console.warn(`[ClaimsDocumentService] No patient ID for request ${requestId}, using subscriber info`);
      // Create minimal patient object from subscriber info
      patient = {
        id: requestId,
        firstName: request.subscriberName.split(' ')[0] || '',
        lastName: request.subscriberName.split(' ').slice(1).join(' ') || '',
        dateOfBirth: request.subscriberDob || '1900-01-01',
      };
    }

    // Parse LOINC codes from request
    const loincCodes = JSON.parse(request.requestedLoincCodes);

    // For each LOINC code, build a document
    for (const loincCode of loincCodes) {
      await buildDocumentForLoinc(requestId, request.patientId, patient, loincCode);
    }

    // Transition to Pending-Signature
    const newState = transition(ClaimsAttachmentState.PROCESSING, ClaimsAttachmentState.PENDING_SIGNATURE);
    await db
      .update(attachmentRequests)
      .set({ state: newState, updatedAt: new Date() })
      .where(eq(attachmentRequests.id, requestId));

    console.log(`[ClaimsDocumentService] Request ${requestId} transitioned to Pending-Signature`);
  } catch (err) {
    console.error(`[ClaimsDocumentService] Error building documents: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/**
 * Build a single C-CDA document for a specific LOINC code.
 */
async function buildDocumentForLoinc(
  requestId: number,
  patientId: number | null,
  patient: any,
  loincCode: string,
): Promise<void> {
  console.log(`[ClaimsDocumentService] Building document for LOINC ${loincCode}`);

  // Get document type mapping
  const mapping = getDocumentTypeForLoinc(loincCode);
  if (!mapping) {
    console.warn(`[ClaimsDocumentService] Unknown LOINC code: ${loincCode}`);
    return;
  }

  // Query FHIR for required data
  const fhirData: any = {};
  if (patientId) {
    const fhirPatientId = `Patient/${patientId}`;

    try {
      const resources = await Promise.all(
        mapping.fhirResources.map(async (resourceType) => {
          switch (resourceType) {
            case 'Condition':
              return { type: 'conditions', data: await getConditions(fhirPatientId) };
            case 'Medication':
              return { type: 'medications', data: await getMedications(fhirPatientId) };
            case 'AllergyIntolerance':
              return { type: 'allergies', data: await getAllergyIntolerances(fhirPatientId) };
            case 'Observation':
              return { type: 'observations', data: await getObservations(fhirPatientId) };
            case 'Encounter':
              return { type: 'encounters', data: await getEncounters(fhirPatientId) };
            default:
              return { type: resourceType.toLowerCase(), data: [] };
          }
        }),
      );

      resources.forEach((r) => {
        if (r.data && r.data.length > 0) {
          fhirData[r.type] = r.data;
        }
      });

      console.log(`[ClaimsDocumentService] FHIR data retrieved for LOINC ${loincCode}`);
    } catch (err) {
      console.warn(
        `[ClaimsDocumentService] FHIR query failed for LOINC ${loincCode}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Continue with empty FHIR data
    }
  }

  // Build C-CDA document
  const documentId = `${requestId}-${loincCode}-${Date.now()}`;
  const ccdaXml = buildClaimsCcda({
    patient: {
      id: String(patientId || requestId),
      firstName: patient.firstName,
      lastName: patient.lastName,
      dateOfBirth: patient.dateOfBirth,
    },
    loincCode,
    documentType: mapping.label,
    fhirData,
    documentId,
    effectiveTime: new Date(),
    organizationName: 'Healthcare Organization',
    authorName: 'Provider Name',
  });

  // Insert attachment response
  await db
    .insert(attachmentResponses)
    .values({
      requestId,
      loincCode,
      ccdaDocumentType: mapping.label,
      ccdaXml,
      fhirData: JSON.stringify(fhirData),
    });

  console.log(`[ClaimsDocumentService] Inserted response for LOINC ${loincCode}`);
}
