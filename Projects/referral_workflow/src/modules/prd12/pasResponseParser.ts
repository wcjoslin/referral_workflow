/**
 * PRD-12 PAS Response Parser
 *
 * Parses FHIR ClaimResponse bundles from the payer.
 * Extracts review action codes (approved/denied/pended), auth numbers,
 * denial reasons, and item-level adjudication details.
 */

// ── Result Interfaces ─────────────────────────────────────────────────────────

export type PriorAuthOutcome = 'approved' | 'denied' | 'pended';

export interface ItemAdjudication {
  sequence: number;
  reviewAction: string;
  authNumber?: string;
  denialReason?: string;
}

export interface PriorAuthResult {
  type: 'result';
  outcome: PriorAuthOutcome;
  reviewAction: string;
  authNumber?: string;
  denialReason?: string;
  itemAdjudications: ItemAdjudication[];
  claimResponseId?: string;
  rawResponse: Record<string, unknown>;
}

export interface ParseError {
  type: 'error';
  message: string;
  operationOutcome?: Record<string, unknown>;
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parses a PAS Response Bundle and extracts the authorization decision.
 * Returns a PriorAuthResult on success or a ParseError if the response
 * is an OperationOutcome or otherwise unparseable.
 */
export function parseClaimResponse(
  responseBody: Record<string, unknown>,
): PriorAuthResult | ParseError {
  // Handle direct OperationOutcome (4XX error response)
  if (responseBody.resourceType === 'OperationOutcome') {
    return parseOperationOutcome(responseBody);
  }

  // Handle Bundle containing ClaimResponse
  if (responseBody.resourceType === 'Bundle') {
    const entries = responseBody.entry as Array<{ resource?: Record<string, unknown> }> | undefined;
    if (!entries || entries.length === 0) {
      return { type: 'error', message: 'Empty response bundle' };
    }

    const claimResponse = entries.find((e) => e.resource?.resourceType === 'ClaimResponse')?.resource;
    if (!claimResponse) {
      // Check if it's an OperationOutcome inside the bundle
      const opOutcome = entries.find((e) => e.resource?.resourceType === 'OperationOutcome')?.resource;
      if (opOutcome) return parseOperationOutcome(opOutcome);
      return { type: 'error', message: 'No ClaimResponse found in response bundle' };
    }

    return extractDecision(claimResponse);
  }

  // Handle direct ClaimResponse (not wrapped in Bundle)
  if (responseBody.resourceType === 'ClaimResponse') {
    return extractDecision(responseBody);
  }

  return { type: 'error', message: `Unexpected resource type: ${String(responseBody.resourceType)}` };
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

function parseOperationOutcome(resource: Record<string, unknown>): ParseError {
  const issues = resource.issue as Array<Record<string, unknown>> | undefined;
  const firstIssue = issues?.[0];
  const diagnostics = firstIssue?.diagnostics as string | undefined;
  const severity = firstIssue?.severity as string | undefined;
  const details = firstIssue?.details as Record<string, unknown> | undefined;
  const detailText = details?.text as string | undefined;

  return {
    type: 'error',
    message: diagnostics ?? detailText ?? `OperationOutcome: ${severity ?? 'unknown'} error`,
    operationOutcome: resource,
  };
}

function extractDecision(claimResponse: Record<string, unknown>): PriorAuthResult {
  const id = claimResponse.id as string | undefined;
  const items = claimResponse.item as Array<Record<string, unknown>> | undefined;

  const itemAdjudications: ItemAdjudication[] = [];
  let overallReviewAction = '';
  let overallAuthNumber: string | undefined;
  let overallDenialReason: string | undefined;

  if (items) {
    for (const item of items) {
      const sequence = item.sequence as number ?? 0;
      const adjudication = item.adjudication as Array<Record<string, unknown>> | undefined;

      let itemReviewAction = '';
      let itemAuthNumber: string | undefined;
      let itemDenialReason: string | undefined;

      if (adjudication) {
        for (const adj of adjudication) {
          // Check for reviewAction extension
          const extensions = adj.extension as Array<Record<string, unknown>> | undefined;
          if (extensions) {
            for (const ext of extensions) {
              if (
                typeof ext.url === 'string' &&
                ext.url.includes('reviewAction')
              ) {
                const coding = ext.valueCoding as Record<string, unknown> | undefined;
                const codeableConcept = ext.valueCodeableConcept as Record<string, unknown> | undefined;
                if (coding) {
                  itemReviewAction = String(coding.code ?? '');
                } else if (codeableConcept) {
                  const codings = codeableConcept.coding as Array<Record<string, unknown>> | undefined;
                  itemReviewAction = String(codings?.[0]?.code ?? '');
                }
              }
              if (typeof ext.url === 'string' && ext.url.includes('authorizationNumber')) {
                itemAuthNumber = String(ext.valueString ?? '');
              }
            }
          }

          // Check category for denial reason
          const category = adj.category as Record<string, unknown> | undefined;
          const categoryCoding = (category?.coding as Array<Record<string, unknown>> | undefined)?.[0];
          if (categoryCoding?.code === 'denialreason') {
            const reason = adj.reason as Record<string, unknown> | undefined;
            const reasonCoding = (reason?.coding as Array<Record<string, unknown>> | undefined)?.[0];
            itemDenialReason = String(reasonCoding?.display ?? reasonCoding?.code ?? '');
          }
        }
      }

      // Also check item-level extensions directly
      const itemExtensions = item.extension as Array<Record<string, unknown>> | undefined;
      if (itemExtensions) {
        for (const ext of itemExtensions) {
          if (typeof ext.url === 'string' && ext.url.includes('reviewAction')) {
            const coding = ext.valueCoding as Record<string, unknown> | undefined;
            if (coding && !itemReviewAction) {
              itemReviewAction = String(coding.code ?? '');
            }
          }
          if (typeof ext.url === 'string' && ext.url.includes('authorizationNumber')) {
            if (!itemAuthNumber) {
              itemAuthNumber = String(ext.valueString ?? '');
            }
          }
        }
      }

      itemAdjudications.push({
        sequence,
        reviewAction: itemReviewAction,
        authNumber: itemAuthNumber,
        denialReason: itemDenialReason,
      });

      // Use first item's decision as overall if not set
      if (!overallReviewAction && itemReviewAction) overallReviewAction = itemReviewAction;
      if (!overallAuthNumber && itemAuthNumber) overallAuthNumber = itemAuthNumber;
      if (!overallDenialReason && itemDenialReason) overallDenialReason = itemDenialReason;
    }
  }

  // Also check top-level extensions on the ClaimResponse
  const topExtensions = claimResponse.extension as Array<Record<string, unknown>> | undefined;
  if (topExtensions) {
    for (const ext of topExtensions) {
      if (typeof ext.url === 'string' && ext.url.includes('reviewAction') && !overallReviewAction) {
        const coding = ext.valueCoding as Record<string, unknown> | undefined;
        if (coding) overallReviewAction = String(coding.code ?? '');
      }
      if (typeof ext.url === 'string' && ext.url.includes('authorizationNumber') && !overallAuthNumber) {
        overallAuthNumber = String(ext.valueString ?? '');
      }
    }
  }

  // Fallback: check disposition field
  if (!overallReviewAction) {
    const disposition = claimResponse.disposition as string | undefined;
    if (disposition) {
      const lower = disposition.toLowerCase();
      if (lower.includes('approved') || lower.includes('authorized')) overallReviewAction = 'approved';
      else if (lower.includes('denied') || lower.includes('rejected')) overallReviewAction = 'denied';
      else if (lower.includes('pend')) overallReviewAction = 'pended';
    }
  }

  // Fallback: check outcome field
  if (!overallReviewAction) {
    const outcome = claimResponse.outcome as string | undefined;
    if (outcome === 'complete') overallReviewAction = 'approved';
    else if (outcome === 'error') overallReviewAction = 'denied';
    else if (outcome === 'queued' || outcome === 'partial') overallReviewAction = 'pended';
  }

  const outcome = mapReviewActionToOutcome(overallReviewAction);

  // Extract denial reason from disposition if not found in adjudication
  if (outcome === 'denied' && !overallDenialReason) {
    const disposition = claimResponse.disposition as string | undefined;
    if (disposition) overallDenialReason = disposition;
  }

  return {
    type: 'result',
    outcome,
    reviewAction: overallReviewAction,
    authNumber: overallAuthNumber,
    denialReason: overallDenialReason,
    itemAdjudications,
    claimResponseId: id,
    rawResponse: claimResponse,
  };
}

function mapReviewActionToOutcome(reviewAction: string): PriorAuthOutcome {
  const lower = reviewAction.toLowerCase();
  if (lower.includes('approved') || lower.includes('a1') || lower === 'authorized' || lower === 'complete') {
    return 'approved';
  }
  if (lower.includes('denied') || lower.includes('a2') || lower === 'rejected') {
    return 'denied';
  }
  if (lower.includes('pend') || lower.includes('a3') || lower === 'queued' || lower === 'partial') {
    return 'pended';
  }
  // Default to pended for unrecognized codes
  if (lower) return 'pended';
  return 'pended';
}
