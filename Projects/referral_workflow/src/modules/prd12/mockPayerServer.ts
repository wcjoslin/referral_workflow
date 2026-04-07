/**
 * PRD-12 Mock Payer Server
 *
 * Exports individual Express handler functions mounted directly on the main app
 * to avoid Express 5 path-to-regexp issues with $ in route strings.
 *
 * Decision logic is deterministic by last digit of service code:
 *   0-5 → immediate approve
 *   6-7 → immediate deny
 *   8-9 → pend, then fire subscription notification after delay
 */

import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { config } from '../../config';

// ── In-memory stores ──────────────────────────────────────────────────────────

interface PendingClaim {
  claimId: string;
  patientRef: string;
  serviceCode: string;
  requestId?: number;
  bundle: Record<string, unknown>;
  resolvedAt?: Date;
  outcome?: string;
}

interface Subscription {
  id: string;
  endpoint: string;
  criteria: string;
}

const pendingClaims = new Map<string, PendingClaim>();
const subscriptions = new Map<string, Subscription>();
const resolvedClaims = new Map<string, Record<string, unknown>>();

// ── $submit handler ───────────────────────────────────────────────────────────

export function handleMockSubmit(req: Request, res: Response): void {
  const bundle = req.body as Record<string, unknown>;
  const entries = bundle.entry as Array<{ resource?: Record<string, unknown> }> | undefined;

  if (!entries || entries.length === 0) {
    res.status(400).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'invalid', diagnostics: 'Empty bundle' }],
    });
    return;
  }

  const claim = entries.find((e) => e.resource?.resourceType === 'Claim')?.resource;
  if (!claim) {
    res.status(400).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'invalid', diagnostics: 'No Claim resource in bundle' }],
    });
    return;
  }

  const items = claim.item as Array<Record<string, unknown>> | undefined;
  const productOrService = items?.[0]?.productOrService as Record<string, unknown> | undefined;
  const codings = productOrService?.coding as Array<Record<string, unknown>> | undefined;
  const serviceCode = String(codings?.[0]?.code ?? '0');

  const claimId = String(claim.id ?? randomUUID());
  const patientRef = (claim.patient as Record<string, unknown>)?.reference as string ?? '';
  const requestIdFromMeta = claim._requestId as number | undefined;

  const decision = getDecision(serviceCode);
  const claimResponseId = randomUUID();
  const authNumber = `AUTH-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;

  if (decision === 'approve') {
    const claimResponse = buildClaimResponse(claimResponseId, claimId, 'approved', authNumber, undefined, requestIdFromMeta);
    res.json(wrapInBundle(claimResponse));
    return;
  }

  if (decision === 'deny') {
    const reason = getDenialReason(serviceCode);
    const claimResponse = buildClaimResponse(claimResponseId, claimId, 'denied', undefined, reason, requestIdFromMeta);
    res.json(wrapInBundle(claimResponse));
    return;
  }

  // Pend — store for async resolution
  pendingClaims.set(claimId, {
    claimId,
    patientRef,
    serviceCode,
    requestId: requestIdFromMeta,
    bundle,
  });

  const delayMs = config.priorAuth.mockPayerDelayMs;
  setTimeout(() => {
    void resolvePendedClaim(claimId, claimResponseId, authNumber, requestIdFromMeta);
  }, delayMs);

  const pendedResponse = buildClaimResponse(claimResponseId, claimId, 'pended', undefined, undefined, requestIdFromMeta);
  res.json(wrapInBundle(pendedResponse));
}

// ── $inquiry handler ──────────────────────────────────────────────────────────

export function handleMockInquiry(req: Request, res: Response): void {
  const bundle = req.body as Record<string, unknown>;
  const entries = bundle.entry as Array<{ resource?: Record<string, unknown> }> | undefined;
  const claim = entries?.find((e) => e.resource?.resourceType === 'Claim')?.resource;

  if (!claim) {
    res.status(400).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'invalid', diagnostics: 'No Claim resource in inquiry bundle' }],
    });
    return;
  }

  const claimId = String(claim.id ?? '');

  const resolved = resolvedClaims.get(claimId);
  if (resolved) {
    res.json(wrapInBundle(resolved));
    return;
  }

  const pending = pendingClaims.get(claimId);
  if (pending) {
    res.json(wrapInBundle(buildClaimResponse(randomUUID(), claimId, 'pended')));
    return;
  }

  res.json({ resourceType: 'Bundle', type: 'searchset', total: 0, entry: [] });
}

// ── Subscription handler ──────────────────────────────────────────────────────

export function handleMockSubscription(req: Request, res: Response): void {
  const sub = req.body as Record<string, unknown>;
  const channel = sub.channel as Record<string, unknown> | undefined;
  const endpoint = channel?.endpoint as string | undefined;
  const criteria = sub.criteria as string | undefined;

  if (!endpoint) {
    res.status(400).json({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'invalid', diagnostics: 'Subscription requires channel.endpoint' }],
    });
    return;
  }

  const id = randomUUID();
  subscriptions.set(id, { id, endpoint, criteria: criteria ?? '' });
  console.log(`[MockPayer] Registered subscription ${id} → ${endpoint}`);

  res.status(201).json({
    resourceType: 'Subscription',
    id,
    status: 'active',
    channel: { type: 'rest-hook', endpoint },
    criteria,
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function getDecision(serviceCode: string): 'approve' | 'deny' | 'pend' {
  const lastDigit = parseInt(serviceCode.slice(-1), 10);
  if (isNaN(lastDigit)) return 'approve';
  if (lastDigit <= 5) return 'approve';
  if (lastDigit <= 7) return 'deny';
  return 'pend';
}

function getDenialReason(serviceCode: string): string {
  const lastDigit = parseInt(serviceCode.slice(-1), 10);
  if (lastDigit === 6) return 'Not medically necessary';
  return 'Out of network';
}

function buildClaimResponse(
  responseId: string,
  claimId: string,
  decision: 'approved' | 'denied' | 'pended',
  authNumber?: string,
  denialReason?: string,
  requestId?: number,
): Record<string, unknown> {
  const reviewActionCode =
    decision === 'approved' ? 'approved' : decision === 'denied' ? 'denied' : 'pended';
  const outcome =
    decision === 'approved' ? 'complete' : decision === 'denied' ? 'error' : 'queued';
  const disposition =
    decision === 'approved'
      ? 'Approved'
      : decision === 'denied'
        ? `Denied: ${denialReason ?? 'Not specified'}`
        : 'Pended for review';

  const response: Record<string, unknown> = {
    resourceType: 'ClaimResponse',
    id: responseId,
    status: 'active',
    use: 'preauthorization',
    outcome,
    disposition,
    request: { identifier: { value: claimId } },
    item: [
      {
        sequence: 1,
        adjudication: [
          {
            category: {
              coding: [{ system: 'http://terminology.hl7.org/CodeSystem/adjudication', code: 'submitted' }],
            },
            extension: [
              {
                url: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-reviewAction',
                valueCoding: {
                  system: 'http://hl7.org/fhir/us/davinci-pas/CodeSystem/PASSupportingInfoType',
                  code: reviewActionCode,
                  display: decision === 'approved' ? 'Approved' : decision === 'denied' ? 'Denied' : 'Pended',
                },
              },
              ...(authNumber
                ? [{ url: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-authorizationNumber', valueString: authNumber }]
                : []),
            ],
            ...(denialReason ? { reason: { coding: [{ code: 'denial', display: denialReason }] } } : {}),
          },
        ],
      },
    ],
    created: new Date().toISOString(),
  };

  if (requestId !== undefined) {
    response._requestId = requestId;
  }

  return response;
}

function wrapInBundle(claimResponse: Record<string, unknown>): Record<string, unknown> {
  return {
    resourceType: 'Bundle',
    id: randomUUID(),
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: [{ fullUrl: `urn:uuid:${String(claimResponse.id)}`, resource: claimResponse }],
  };
}

async function resolvePendedClaim(
  pendKey: string,
  claimResponseId: string,
  authNumber: string,
  requestId?: number,
): Promise<void> {
  const pending = pendingClaims.get(pendKey);
  if (!pending) return;

  pending.resolvedAt = new Date();
  pending.outcome = 'approved';

  const resolvedResponse = buildClaimResponse(claimResponseId, pending.claimId, 'approved', authNumber, undefined, requestId);
  resolvedClaims.set(pending.claimId, resolvedResponse);

  const responseBundle = wrapInBundle(resolvedResponse);
  for (const [, sub] of subscriptions) {
    try {
      console.log(`[MockPayer] Firing subscription notification to ${sub.endpoint}`);
      await fetch(sub.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/fhir+json' },
        body: JSON.stringify(responseBundle),
      });
    } catch (err) {
      console.warn(`[MockPayer] Failed to notify ${sub.endpoint}:`, err instanceof Error ? err.message : err);
    }
  }

  pendingClaims.delete(pendKey);
}

/**
 * Reset mock payer state (for testing).
 */
export function resetMockPayer(): void {
  pendingClaims.clear();
  subscriptions.clear();
  resolvedClaims.clear();
}
