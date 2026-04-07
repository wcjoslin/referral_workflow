/**
 * PRD-12 Prior Authorization Service
 *
 * Core orchestrator for submitting PA requests, handling responses,
 * and managing state transitions. Coordinates between the PAS client,
 * bundle builder, response parser, and subscription service.
 */

import { eq, desc, and, lte } from 'drizzle-orm';
import { db } from '../../db';
import { priorAuthRequests, priorAuthResponses, patients, referrals } from '../../db/schema';
import { PriorAuthState, transition } from '../../state/priorAuthStateMachine';
import { buildPasBundle, PriorAuthFormData, PasBundle } from './pasBundleBuilder';
import { config } from '../../config';
import { parseClaimResponse } from './pasResponseParser';
import * as pasClient from './pasClient';
import { registerPendedSubscription } from './subscriptionService';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface SubmitFormData {
  referralId?: number;
  patientId: number;
  insurerName: string;
  insurerId: string;
  subscriberId?: string;
  serviceCode: string;
  serviceDisplay?: string;
  providerNpi: string;
  providerName: string;
  diagnoses?: Array<{ code: string; display: string }>;
}

export interface SubmitResult {
  id: number;
  state: PriorAuthState;
  outcome?: string;
  authNumber?: string;
  denialReason?: string;
  message?: string;
  referralId?: number;
}

export class PriorAuthNotFoundError extends Error {
  constructor(id: number) {
    super(`Prior auth request not found: ${id}`);
    this.name = 'PriorAuthNotFoundError';
  }
}

// ── Submit ────────────────────────────────────────────────────────────────────

export async function submitPriorAuth(formData: SubmitFormData): Promise<SubmitResult> {
  // Fetch patient info for bundle building
  const [patient] = await db.select().from(patients).where(eq(patients.id, formData.patientId));
  if (!patient) throw new Error(`Patient not found: ${formData.patientId}`);

  // Build the PAS Bundle
  const bundleData: PriorAuthFormData = {
    patientFirstName: patient.firstName,
    patientLastName: patient.lastName,
    patientDob: patient.dateOfBirth,
    insurerName: formData.insurerName,
    insurerId: formData.insurerId,
    subscriberId: formData.subscriberId,
    serviceCode: formData.serviceCode,
    serviceDisplay: formData.serviceDisplay,
    providerNpi: formData.providerNpi,
    providerName: formData.providerName,
    diagnoses: formData.diagnoses,
  };

  const bundle = buildPasBundle(bundleData);
  const claimEntry = bundle.entry[0];
  const now = new Date();

  // Insert request in Draft state
  const [inserted] = await db
    .insert(priorAuthRequests)
    .values({
      referralId: formData.referralId ?? null,
      patientId: formData.patientId,
      state: PriorAuthState.DRAFT,
      claimJson: JSON.stringify(claimEntry.resource),
      bundleJson: JSON.stringify(bundle),
      insurerName: formData.insurerName,
      insurerId: formData.insurerId,
      serviceCode: formData.serviceCode,
      serviceDisplay: formData.serviceDisplay ?? null,
      providerNpi: formData.providerNpi,
      providerName: formData.providerName,
      subscriberId: formData.subscriberId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  // Transition to Submitted
  const submittedState = transition(PriorAuthState.DRAFT, PriorAuthState.SUBMITTED);
  await db
    .update(priorAuthRequests)
    .set({ state: submittedState, submittedAt: now, updatedAt: now })
    .where(eq(priorAuthRequests.id, inserted.id));

  // Call $submit
  const responseBody = await pasClient.submit(bundle);

  if (!responseBody) {
    // Network error — transition to Error
    const errorState = transition(PriorAuthState.SUBMITTED, PriorAuthState.ERROR);
    await db
      .update(priorAuthRequests)
      .set({ state: errorState, updatedAt: new Date() })
      .where(eq(priorAuthRequests.id, inserted.id));
    return {
      id: inserted.id,
      state: PriorAuthState.ERROR,
      message: 'Failed to connect to payer. Please try again.',
      referralId: formData.referralId,
    };
  }

  // Parse response
  const parsed = parseClaimResponse(responseBody);

  if (parsed.type === 'error') {
    const errorState = transition(PriorAuthState.SUBMITTED, PriorAuthState.ERROR);
    await db
      .update(priorAuthRequests)
      .set({ state: errorState, updatedAt: new Date() })
      .where(eq(priorAuthRequests.id, inserted.id));

    await db.insert(priorAuthResponses).values({
      requestId: inserted.id,
      responseJson: JSON.stringify(responseBody),
      outcome: 'error',
      reviewAction: null,
      receivedVia: 'sync',
      receivedAt: new Date(),
    });

    return {
      id: inserted.id,
      state: PriorAuthState.ERROR,
      message: parsed.message,
      referralId: formData.referralId,
    };
  }

  // Store response
  const result = parsed;
  await db.insert(priorAuthResponses).values({
    requestId: inserted.id,
    responseJson: JSON.stringify(result.rawResponse),
    outcome: result.outcome,
    reviewAction: result.reviewAction ?? null,
    authNumber: result.authNumber ?? null,
    denialReason: result.denialReason ?? null,
    itemAdjudications: result.itemAdjudications.length > 0 ? JSON.stringify(result.itemAdjudications) : null,
    receivedVia: 'sync',
    receivedAt: new Date(),
  });

  // Transition state based on outcome
  let nextState: PriorAuthState;
  if (result.outcome === 'approved') {
    nextState = transition(PriorAuthState.SUBMITTED, PriorAuthState.APPROVED);
  } else if (result.outcome === 'denied') {
    nextState = transition(PriorAuthState.SUBMITTED, PriorAuthState.DENIED);
  } else {
    nextState = transition(PriorAuthState.SUBMITTED, PriorAuthState.PENDED);
  }

  await db
    .update(priorAuthRequests)
    .set({ state: nextState, updatedAt: new Date() })
    .where(eq(priorAuthRequests.id, inserted.id));

  // If pended, register subscription for async notification
  if (nextState === PriorAuthState.PENDED) {
    const claimId = String(claimEntry.resource.id);
    const patientUuid = bundle.entry[1]?.resource.id ?? '';
    await registerPendedSubscription(inserted.id, claimId, patientUuid);
  }

  return {
    id: inserted.id,
    state: nextState,
    outcome: result.outcome,
    authNumber: result.authNumber,
    denialReason: result.denialReason,
    message:
      nextState === PriorAuthState.PENDED
        ? 'Request pended for review. You will be notified when a decision is made.'
        : undefined,
    referralId: formData.referralId,
  };
}

// ── Status Check ──────────────────────────────────────────────────────────────

export interface PriorAuthStatus {
  state: PriorAuthState;
  outcome?: string;
  authNumber?: string;
  denialReason?: string;
}

export async function getStatus(requestId: number): Promise<PriorAuthStatus> {
  const [request] = await db
    .select()
    .from(priorAuthRequests)
    .where(eq(priorAuthRequests.id, requestId));

  if (!request) throw new PriorAuthNotFoundError(requestId);

  // Get the latest response
  const [latestResponse] = await db
    .select()
    .from(priorAuthResponses)
    .where(eq(priorAuthResponses.requestId, requestId))
    .orderBy(desc(priorAuthResponses.receivedAt))
    .limit(1);

  return {
    state: request.state as PriorAuthState,
    outcome: latestResponse?.outcome,
    authNumber: latestResponse?.authNumber ?? undefined,
    denialReason: latestResponse?.denialReason ?? undefined,
  };
}

// ── Webhook Handler ───────────────────────────────────────────────────────────

export async function handlePayerNotification(
  body: Record<string, unknown>,
): Promise<{ requestId: number; outcome: string } | null> {
  const parsed = parseClaimResponse(body);

  if (parsed.type === 'error') {
    console.warn('[PriorAuth] Failed to parse payer notification:', parsed.message);
    return null;
  }

  const result = parsed;

  // Find the matching request by looking at the ClaimResponse.request reference
  const claimResponseRaw = result.rawResponse;
  const requestRef = claimResponseRaw.request as Record<string, unknown> | undefined;
  const claimId = requestRef?.identifier as Record<string, unknown> | undefined;
  const claimIdValue = claimId?.value as string | undefined;

  // Also look for the x-request-id header-style field the mock payer sets
  const requestIdFromExtension = claimResponseRaw._requestId as number | undefined;

  let requestId: number | undefined;

  if (requestIdFromExtension) {
    requestId = requestIdFromExtension;
  } else if (claimIdValue) {
    // Try to find by matching bundleJson containing this claim ID
    const allRequests = await db.select().from(priorAuthRequests);
    for (const req of allRequests) {
      if (req.state === PriorAuthState.PENDED && req.bundleJson?.includes(claimIdValue)) {
        requestId = req.id;
        break;
      }
    }
  }

  if (!requestId) {
    console.warn('[PriorAuth] Could not match payer notification to a request');
    return null;
  }

  const [request] = await db
    .select()
    .from(priorAuthRequests)
    .where(eq(priorAuthRequests.id, requestId));

  if (!request || request.state !== PriorAuthState.PENDED) {
    console.warn(`[PriorAuth] Request ${requestId} not in Pended state (${request?.state})`);
    return null;
  }

  // Store the notification response
  await db.insert(priorAuthResponses).values({
    requestId,
    responseJson: JSON.stringify(result.rawResponse),
    outcome: result.outcome,
    reviewAction: result.reviewAction ?? null,
    authNumber: result.authNumber ?? null,
    denialReason: result.denialReason ?? null,
    itemAdjudications: result.itemAdjudications.length > 0 ? JSON.stringify(result.itemAdjudications) : null,
    receivedVia: 'subscription',
    receivedAt: new Date(),
  });

  // Transition from Pended to final state
  let nextState: PriorAuthState;
  if (result.outcome === 'approved') {
    nextState = transition(PriorAuthState.PENDED, PriorAuthState.APPROVED);
  } else {
    nextState = transition(PriorAuthState.PENDED, PriorAuthState.DENIED);
  }

  await db
    .update(priorAuthRequests)
    .set({ state: nextState, updatedAt: new Date() })
    .where(eq(priorAuthRequests.id, requestId));

  console.log(`[PriorAuth] Subscription notification: request ${requestId} → ${nextState}`);
  return { requestId, outcome: result.outcome };
}

// ── Inquire (Manual Poll) ─────────────────────────────────────────────────────

export async function inquirePriorAuth(requestId: number): Promise<PriorAuthStatus> {
  const [request] = await db
    .select()
    .from(priorAuthRequests)
    .where(eq(priorAuthRequests.id, requestId));

  if (!request) throw new PriorAuthNotFoundError(requestId);
  if (request.state !== PriorAuthState.PENDED) {
    return getStatus(requestId);
  }

  // Build inquiry bundle from stored bundle
  const storedBundle = request.bundleJson ? (JSON.parse(request.bundleJson) as PasBundle) : null;
  if (!storedBundle) {
    return getStatus(requestId);
  }

  const responseBody = await pasClient.inquire(storedBundle);
  if (!responseBody) {
    return getStatus(requestId);
  }

  const parsed = parseClaimResponse(responseBody);
  if (parsed.type === 'error') {
    return getStatus(requestId);
  }

  const result = parsed;

  // If still pended, no state change
  if (result.outcome === 'pended') {
    return getStatus(requestId);
  }

  // Store the inquiry response
  await db.insert(priorAuthResponses).values({
    requestId,
    responseJson: JSON.stringify(result.rawResponse),
    outcome: result.outcome,
    reviewAction: result.reviewAction ?? null,
    authNumber: result.authNumber ?? null,
    denialReason: result.denialReason ?? null,
    itemAdjudications: result.itemAdjudications.length > 0 ? JSON.stringify(result.itemAdjudications) : null,
    receivedVia: 'inquire',
    receivedAt: new Date(),
  });

  // Transition from Pended
  let nextState: PriorAuthState;
  if (result.outcome === 'approved') {
    nextState = transition(PriorAuthState.PENDED, PriorAuthState.APPROVED);
  } else {
    nextState = transition(PriorAuthState.PENDED, PriorAuthState.DENIED);
  }

  await db
    .update(priorAuthRequests)
    .set({ state: nextState, updatedAt: new Date() })
    .where(eq(priorAuthRequests.id, requestId));

  return {
    state: nextState,
    outcome: result.outcome,
    authNumber: result.authNumber,
    denialReason: result.denialReason,
  };
}

// ── List / Detail Queries ─────────────────────────────────────────────────────

export async function listPriorAuthRequests(): Promise<
  Array<{
    request: typeof priorAuthRequests.$inferSelect;
    patient: typeof patients.$inferSelect;
  }>
> {
  const allRequests = await db
    .select()
    .from(priorAuthRequests)
    .orderBy(desc(priorAuthRequests.createdAt));

  return Promise.all(
    allRequests.map(async (req) => {
      const [patient] = await db.select().from(patients).where(eq(patients.id, req.patientId));
      return {
        request: req,
        patient: patient ?? { id: 0, firstName: 'Unknown', lastName: '', dateOfBirth: '' },
      };
    }),
  );
}

export async function getPriorAuthDetail(requestId: number): Promise<{
  request: typeof priorAuthRequests.$inferSelect;
  patient: typeof patients.$inferSelect;
  responses: Array<typeof priorAuthResponses.$inferSelect>;
  referral?: typeof referrals.$inferSelect;
}> {
  const [request] = await db
    .select()
    .from(priorAuthRequests)
    .where(eq(priorAuthRequests.id, requestId));

  if (!request) throw new PriorAuthNotFoundError(requestId);

  const [patient] = await db.select().from(patients).where(eq(patients.id, request.patientId));

  const responses = await db
    .select()
    .from(priorAuthResponses)
    .where(eq(priorAuthResponses.requestId, requestId))
    .orderBy(desc(priorAuthResponses.receivedAt));

  let referral;
  if (request.referralId) {
    const [ref] = await db.select().from(referrals).where(eq(referrals.id, request.referralId));
    referral = ref;
  }

  return {
    request,
    patient: patient ?? { id: 0, firstName: 'Unknown', lastName: '', dateOfBirth: '' },
    responses,
    referral,
  };
}

/**
 * Load referral data for pre-populating the PA form.
 */
export async function getReferralFormData(referralId: number): Promise<{
  patient: typeof patients.$inferSelect;
  referral: typeof referrals.$inferSelect;
  diagnoses: Array<{ code: string; display: string }>;
} | null> {
  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!referral) return null;

  const [patient] = await db.select().from(patients).where(eq(patients.id, referral.patientId));
  if (!patient) return null;

  // Extract diagnoses from clinicalData JSON
  const diagnoses: Array<{ code: string; display: string }> = [];
  if (referral.clinicalData) {
    try {
      const clinical = JSON.parse(referral.clinicalData) as Record<string, unknown>;
      const problems = clinical.problems as Array<Record<string, unknown>> | undefined;
      if (problems) {
        for (const p of problems) {
          const name = (p.name as string) ?? (p.display as string) ?? '';
          const code = (p.code as string) ?? '';
          if (name) diagnoses.push({ code: code || 'unknown', display: name });
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  return { patient, referral, diagnoses };
}

// ── Pend Timeout Checker ──────────────────────────────────────────────────────

/**
 * Transitions any Pended PA requests that have exceeded the configured pend
 * timeout to the Expired state. Called periodically from index.ts.
 * Returns the number of requests expired.
 */
export async function expirePendedRequests(): Promise<number> {
  const cutoff = new Date(Date.now() - config.priorAuth.pendTimeoutMs);

  const pendedRequests = await db
    .select()
    .from(priorAuthRequests)
    .where(
      and(
        eq(priorAuthRequests.state, PriorAuthState.PENDED),
        lte(priorAuthRequests.submittedAt, cutoff),
      ),
    );

  let count = 0;
  for (const request of pendedRequests) {
    try {
      const expiredState = transition(PriorAuthState.PENDED, PriorAuthState.EXPIRED);
      await db
        .update(priorAuthRequests)
        .set({ state: expiredState, updatedAt: new Date() })
        .where(eq(priorAuthRequests.id, request.id));

      await db.insert(priorAuthResponses).values({
        requestId: request.id,
        responseJson: JSON.stringify({ reason: 'Pend timeout exceeded', timeoutMs: config.priorAuth.pendTimeoutMs }),
        outcome: 'expired',
        reviewAction: null,
        receivedVia: 'timeout',
        receivedAt: new Date(),
      });

      console.log(
        `[PriorAuth] Request ${request.id} expired after pend timeout (${config.priorAuth.pendTimeoutMs}ms)`,
      );
      count++;
    } catch (err) {
      console.error(`[PriorAuth] Failed to expire request ${request.id}:`, err);
    }
  }

  return count;
}
