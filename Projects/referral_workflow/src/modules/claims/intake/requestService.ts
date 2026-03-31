/**
 * Claims Attachment Request Service
 *
 * Ingests parsed X12 277 data into the database.
 * Attempts FHIR patient matching and kicks off document build.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { attachmentRequests, patients } from '../../../db/schema';
import { ClaimsAttachmentState, transition } from '../../../state/claimsStateMachine';
import { searchPatient, FhirPatientMatch } from '../../prd08/fhirClient';
import { buildDocumentsForRequest } from '../document/claimsDocumentService';
import { Parsed277Request } from './x12_277Parser';

export class RequestNotFoundError extends Error {
  constructor(id: number) {
    super(`Attachment request not found: ${id}`);
    this.name = 'RequestNotFoundError';
  }
}

/**
 * Ingest a parsed 277 request into the database.
 * Returns the inserted request ID.
 */
export async function ingestRequest(parsed277: Parsed277Request, sourceFilename: string): Promise<number> {
  console.log(`[ClaimsRequestService] Ingesting 277 request from ${sourceFilename}`);

  // Check for duplicate control number
  const existing = await db
    .select()
    .from(attachmentRequests)
    .where(eq(attachmentRequests.controlNumber, parsed277.controlNumber))
    .limit(1);

  if (existing.length > 0) {
    throw new Error(`Duplicate control number: ${parsed277.controlNumber}`);
  }

  // Attempt FHIR patient match
  let patientId: number | null = null;
  try {
    // Parse subscriber name into given and family names
    const nameParts = parsed277.subscriberName.trim().split(/\s+/);
    const givenName = nameParts[0] || '';
    const familyName = nameParts.slice(1).join(' ') || '';
    const birthDate = parsed277.subscriberDob || '';

    const fhirMatch = await searchPatient(givenName, familyName, birthDate);

    if (fhirMatch) {
      // Check if patient exists in our DB; if not, create
      const firstName = givenName;
      const lastName = familyName;

      const [existingPatient] = await db
        .select()
        .from(patients)
        .where(
          sql`LOWER(${patients.firstName}) = ${firstName.toLowerCase()} AND LOWER(${patients.lastName}) = ${lastName.toLowerCase()}`,
        )
        .limit(1);

      if (existingPatient) {
        patientId = existingPatient.id;
        console.log(`[ClaimsRequestService] Matched to existing patient: ${patientId}`);
      } else {
        // Create new patient record
        const dob = fhirMatch.birthDate || '1900-01-01';

        const inserted = await db
          .insert(patients)
          .values({
            firstName,
            lastName,
            dateOfBirth: dob,
          })
          .returning();

        patientId = inserted[0]?.id ?? null;
        console.log(`[ClaimsRequestService] Created new patient: ${patientId}`);
      }
    } else {
      console.warn(
        `[ClaimsRequestService] No FHIR match for ${parsed277.subscriberName} / ${parsed277.subscriberDob}`,
      );
    }
  } catch (err) {
    console.warn(
      `[ClaimsRequestService] FHIR search failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Non-blocking — continue without patient match
  }

  // Insert attachment request
  const inserted = await db
    .insert(attachmentRequests)
    .values({
      patientId: patientId || null,
      controlNumber: parsed277.controlNumber,
      claimNumber: parsed277.claimNumber,
      payerName: parsed277.payerName,
      payerIdentifier: parsed277.payerIdentifier,
      subscriberName: parsed277.subscriberName,
      subscriberId: parsed277.subscriberId,
      subscriberDob: parsed277.subscriberDob,
      requestedLoincCodes: JSON.stringify(parsed277.requestedLoincCodes),
      sourceFile: sourceFilename,
      state: ClaimsAttachmentState.RECEIVED,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: attachmentRequests.id });

  const requestId = inserted[0]?.id;
  if (!requestId) {
    throw new Error('Failed to insert attachment request');
  }

  console.log(`[ClaimsRequestService] Inserted request ${requestId}, transitioning to Processing`);

  // Transition to Processing
  const newState = transition(ClaimsAttachmentState.RECEIVED, ClaimsAttachmentState.PROCESSING);
  await db
    .update(attachmentRequests)
    .set({ state: newState, updatedAt: new Date() })
    .where(eq(attachmentRequests.id, requestId));

  // Kick off document build in the background (fire-and-forget)
  buildDocumentsForRequest(requestId).catch((err) => {
    console.error(`[ClaimsRequestService] Document build failed for request ${requestId}:`, err);
  });

  return requestId;
}

/**
 * Get a request by ID.
 */
export async function getRequest(requestId: number) {
  const [request] = await db
    .select()
    .from(attachmentRequests)
    .where(eq(attachmentRequests.id, requestId));

  if (!request) {
    throw new RequestNotFoundError(requestId);
  }

  return {
    ...request,
    requestedLoincCodes: JSON.parse(request.requestedLoincCodes),
  };
}
