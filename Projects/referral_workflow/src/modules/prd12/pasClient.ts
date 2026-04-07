/**
 * PRD-12 PAS FHIR Client
 *
 * Handles $submit and $inquire operations against the payer FHIR endpoint.
 * Follows the same fetch + AbortController + timeout pattern as prd08/fhirClient.ts.
 */

import { config } from '../../config';
import { PasBundle } from './pasBundleBuilder';

const TIMEOUT_MS = 15_000; // PAS IG specifies 15-second SLA

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseUrl(): string {
  return config.priorAuth.mockPayerBaseUrl;
}

async function pasFetch(
  path: string,
  body: unknown,
): Promise<Record<string, unknown> | null> {
  const url = `${baseUrl()}/${path}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/fhir+json',
        Accept: 'application/fhir+json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const json = (await res.json()) as Record<string, unknown>;

    // For 4XX errors, still return the body (likely OperationOutcome)
    if (!res.ok && res.status < 500) {
      return json;
    }
    if (!res.ok) {
      console.warn(`[PasClient] ${res.status} from ${url}`);
      return null;
    }
    return json;
  } catch (err) {
    console.warn(
      `[PasClient] Fetch failed for ${url}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ── Operations ────────────────────────────────────────────────────────────────

/**
 * Submit a prior authorization request via $submit.
 * POST [base]/Claim/$submit with a PAS Bundle.
 */
export async function submit(
  bundle: PasBundle,
): Promise<Record<string, unknown> | null> {
  return pasFetch('Claim/$submit', bundle);
}

/**
 * Inquire about a prior authorization request via $inquire.
 * POST [base]/Claim/$inquiry with a query-by-example Claim bundle.
 */
export async function inquire(
  queryBundle: PasBundle,
): Promise<Record<string, unknown> | null> {
  return pasFetch('Claim/$inquiry', queryBundle);
}

/**
 * Register a rest-hook subscription with the payer.
 * POST [base]/Subscription with FHIR Subscription resource.
 */
export async function registerSubscription(
  webhookUrl: string,
  claimId: string,
  patientId: string,
): Promise<string | null> {
  const subscription = {
    resourceType: 'Subscription',
    status: 'requested',
    reason: 'Monitor prior authorization decision',
    criteria: `ClaimResponse?patient=${patientId}&request=${claimId}`,
    channel: {
      type: 'rest-hook',
      endpoint: webhookUrl,
      payload: 'application/fhir+json',
    },
  };

  const result = await pasFetch('Subscription', subscription);
  if (!result) return null;
  return String(result.id ?? '');
}
