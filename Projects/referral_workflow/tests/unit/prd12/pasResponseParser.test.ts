/**
 * Unit tests for pasResponseParser.ts
 */

import { parseClaimResponse, PriorAuthResult, ParseError } from '../../../src/modules/prd12/pasResponseParser';

function makeClaimResponseBundle(
  decision: 'approved' | 'denied' | 'pended',
  opts?: { authNumber?: string; denialReason?: string },
): Record<string, unknown> {
  const reviewActionCode = decision;
  const outcome = decision === 'approved' ? 'complete' : decision === 'denied' ? 'error' : 'queued';

  const extensions: Array<Record<string, unknown>> = [
    {
      url: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-reviewAction',
      valueCoding: { code: reviewActionCode, display: decision },
    },
  ];

  if (opts?.authNumber) {
    extensions.push({
      url: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/extension-authorizationNumber',
      valueString: opts.authNumber,
    });
  }

  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'ClaimResponse',
          id: 'cr-123',
          status: 'active',
          use: 'preauthorization',
          outcome,
          disposition: decision === 'denied' ? `Denied: ${opts?.denialReason ?? 'Not specified'}` : decision === 'approved' ? 'Approved' : 'Pended for review',
          item: [
            {
              sequence: 1,
              adjudication: [
                {
                  category: { coding: [{ code: 'submitted' }] },
                  extension: extensions,
                  ...(opts?.denialReason
                    ? { reason: { coding: [{ code: 'denial', display: opts.denialReason }] } }
                    : {}),
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

describe('pasResponseParser', () => {
  describe('parseClaimResponse()', () => {
    it('parses approved ClaimResponse from bundle', () => {
      const bundle = makeClaimResponseBundle('approved', { authNumber: 'AUTH-2026-001' });
      const result = parseClaimResponse(bundle);
      expect(result.type).toBe('result');
      const r = result as PriorAuthResult;
      expect(r.outcome).toBe('approved');
      expect(r.authNumber).toBe('AUTH-2026-001');
      expect(r.claimResponseId).toBe('cr-123');
      expect(r.itemAdjudications).toHaveLength(1);
      expect(r.itemAdjudications[0].reviewAction).toBe('approved');
    });

    it('parses denied ClaimResponse', () => {
      const bundle = makeClaimResponseBundle('denied', { denialReason: 'Out of network' });
      const result = parseClaimResponse(bundle) as PriorAuthResult;
      expect(result.outcome).toBe('denied');
      expect(result.denialReason).toContain('Out of network');
    });

    it('parses pended ClaimResponse', () => {
      const bundle = makeClaimResponseBundle('pended');
      const result = parseClaimResponse(bundle) as PriorAuthResult;
      expect(result.outcome).toBe('pended');
    });

    it('handles direct OperationOutcome (error)', () => {
      const opOutcome = {
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'invalid',
            diagnostics: 'Invalid bundle structure',
          },
        ],
      };
      const result = parseClaimResponse(opOutcome) as ParseError;
      expect(result.type).toBe('error');
      expect(result.message).toBe('Invalid bundle structure');
    });

    it('handles OperationOutcome inside bundle', () => {
      const bundle = {
        resourceType: 'Bundle',
        entry: [
          {
            resource: {
              resourceType: 'OperationOutcome',
              issue: [{ severity: 'error', code: 'invalid', diagnostics: 'Missing required field' }],
            },
          },
        ],
      };
      const result = parseClaimResponse(bundle) as ParseError;
      expect(result.type).toBe('error');
      expect(result.message).toBe('Missing required field');
    });

    it('handles empty bundle', () => {
      const bundle = { resourceType: 'Bundle', entry: [] };
      const result = parseClaimResponse(bundle) as ParseError;
      expect(result.type).toBe('error');
      expect(result.message).toContain('Empty');
    });

    it('handles direct ClaimResponse (not wrapped in bundle)', () => {
      const claimResponse = {
        resourceType: 'ClaimResponse',
        id: 'cr-direct',
        outcome: 'complete',
        disposition: 'Approved',
        item: [],
      };
      const result = parseClaimResponse(claimResponse) as PriorAuthResult;
      expect(result.outcome).toBe('approved');
      expect(result.claimResponseId).toBe('cr-direct');
    });

    it('handles unknown resource type', () => {
      const unknown = { resourceType: 'Patient', id: '123' };
      const result = parseClaimResponse(unknown) as ParseError;
      expect(result.type).toBe('error');
      expect(result.message).toContain('Unexpected resource type');
    });

    it('falls back to disposition field when no reviewAction extension', () => {
      const bundle = {
        resourceType: 'Bundle',
        entry: [
          {
            resource: {
              resourceType: 'ClaimResponse',
              id: 'cr-fallback',
              disposition: 'Denied: service not covered',
              item: [{ sequence: 1, adjudication: [] }],
            },
          },
        ],
      };
      const result = parseClaimResponse(bundle) as PriorAuthResult;
      expect(result.outcome).toBe('denied');
      expect(result.denialReason).toBe('Denied: service not covered');
    });

    it('falls back to outcome field when no reviewAction or disposition', () => {
      const bundle = {
        resourceType: 'Bundle',
        entry: [
          {
            resource: {
              resourceType: 'ClaimResponse',
              id: 'cr-outcome',
              outcome: 'queued',
              item: [],
            },
          },
        ],
      };
      const result = parseClaimResponse(bundle) as PriorAuthResult;
      expect(result.outcome).toBe('pended');
    });
  });
});
