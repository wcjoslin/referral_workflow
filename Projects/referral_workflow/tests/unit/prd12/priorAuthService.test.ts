/**
 * Unit tests for priorAuthService.ts
 *
 * Uses in-memory SQLite. pasClient and subscriptionService are mocked.
 */

jest.mock('../../../src/modules/prd12/pasClient');
jest.mock('../../../src/modules/prd12/subscriptionService');
jest.mock('../../../src/config', () => ({
  config: {
    priorAuth: {
      mockPayerBaseUrl: 'http://localhost:3000/mock-payer',
      pendTimeoutMs: 300000,
      inquirePollIntervalMs: 30000,
      mockPayerDelayMs: 5000,
    },
  },
}));

jest.mock('../../../src/db', () => {
  const Database = require('better-sqlite3');
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const schema = require('../../../src/db/schema');

  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      date_of_birth TEXT NOT NULL
    );
    CREATE TABLE referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      source_message_id TEXT NOT NULL UNIQUE,
      referrer_address TEXT NOT NULL,
      reason_for_referral TEXT,
      state TEXT NOT NULL DEFAULT 'Received',
      decline_reason TEXT,
      clinician_id TEXT,
      appointment_date TEXT,
      appointment_location TEXT,
      scheduled_provider TEXT,
      ai_assessment TEXT,
      routing_department TEXT NOT NULL DEFAULT 'Unassigned',
      routing_equipment TEXT,
      clinical_data TEXT,
      raw_ccda_xml TEXT,
      priority_flag INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE prior_auth_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referral_id INTEGER,
      patient_id INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'Draft',
      claim_json TEXT NOT NULL,
      bundle_json TEXT,
      insurer_name TEXT NOT NULL,
      insurer_id TEXT NOT NULL,
      service_code TEXT NOT NULL,
      service_display TEXT,
      provider_npi TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      subscriber_id TEXT,
      subscription_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      submitted_at INTEGER
    );
    CREATE TABLE prior_auth_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      outcome TEXT NOT NULL,
      review_action TEXT,
      auth_number TEXT,
      denial_reason TEXT,
      item_adjudications TEXT,
      received_via TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );
  `);

  return { db: drizzle(sqlite, { schema }) };
});

import * as pasClient from '../../../src/modules/prd12/pasClient';
import * as subscriptionService from '../../../src/modules/prd12/subscriptionService';
import {
  submitPriorAuth,
  handlePayerNotification,
  inquirePriorAuth,
  expirePendedRequests,
  PriorAuthNotFoundError,
  SubmitFormData,
} from '../../../src/modules/prd12/priorAuthService';
import { PriorAuthState } from '../../../src/state/priorAuthStateMachine';
import { db } from '../../../src/db';
import { patients, priorAuthRequests, priorAuthResponses } from '../../../src/db/schema';
import { eq } from 'drizzle-orm';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeClaimResponseBundle(
  decision: 'approved' | 'denied' | 'pended',
  opts?: { authNumber?: string; denialReason?: string; requestId?: number },
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

  // _requestId goes on the ClaimResponse resource because parseClaimResponse
  // sets rawResponse = claimResponse (the extracted resource, not the bundle wrapper).
  const claimResponse: Record<string, unknown> = {
    resourceType: 'ClaimResponse',
    id: 'cr-test',
    status: 'active',
    use: 'preauthorization',
    outcome,
    disposition:
      decision === 'denied'
        ? `Denied: ${opts?.denialReason ?? 'Not specified'}`
        : decision === 'approved'
          ? 'Approved'
          : 'Pended for review',
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
  };

  if (opts?.requestId !== undefined) {
    claimResponse._requestId = opts.requestId;
  }

  return {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [{ resource: claimResponse }],
  };
}

async function seedPatient(): Promise<number> {
  const [row] = await db
    .insert(patients)
    .values({ firstName: 'John', lastName: 'Smith', dateOfBirth: '1970-06-15' })
    .returning({ id: patients.id });
  return row.id;
}

function baseFormData(patientId: number): SubmitFormData {
  return {
    patientId,
    insurerName: 'BlueCross',
    insurerId: 'BC-001',
    subscriberId: 'SUB-123',
    serviceCode: '99213',
    serviceDisplay: 'Office visit',
    providerNpi: '1234567890',
    providerName: 'Dr. Test',
  };
}

// ── submitPriorAuth ────────────────────────────────────────────────────────────

describe('submitPriorAuth()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (subscriptionService.registerPendedSubscription as jest.Mock).mockResolvedValue(undefined);
  });

  it('returns Approved state and stores an approved response', async () => {
    const patientId = await seedPatient();
    (pasClient.submit as jest.Mock).mockResolvedValue(
      makeClaimResponseBundle('approved', { authNumber: 'AUTH-001' }),
    );

    const result = await submitPriorAuth(baseFormData(patientId));

    expect(result.state).toBe(PriorAuthState.APPROVED);
    expect(result.authNumber).toBe('AUTH-001');

    const [req] = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.id, result.id));
    expect(req.state).toBe('Approved');

    const responses = await db
      .select()
      .from(priorAuthResponses)
      .where(eq(priorAuthResponses.requestId, result.id));
    expect(responses).toHaveLength(1);
    expect(responses[0].outcome).toBe('approved');
    expect(responses[0].authNumber).toBe('AUTH-001');
    expect(responses[0].receivedVia).toBe('sync');
  });

  it('returns Denied state and stores denial reason', async () => {
    const patientId = await seedPatient();
    (pasClient.submit as jest.Mock).mockResolvedValue(
      makeClaimResponseBundle('denied', { denialReason: 'Out of network' }),
    );

    const result = await submitPriorAuth(baseFormData(patientId));

    expect(result.state).toBe(PriorAuthState.DENIED);
    expect(result.denialReason).toContain('Out of network');

    const [req] = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.id, result.id));
    expect(req.state).toBe('Denied');
  });

  it('returns Pended state and registers a subscription', async () => {
    const patientId = await seedPatient();
    (pasClient.submit as jest.Mock).mockResolvedValue(makeClaimResponseBundle('pended'));

    const result = await submitPriorAuth(baseFormData(patientId));

    expect(result.state).toBe(PriorAuthState.PENDED);
    expect(subscriptionService.registerPendedSubscription).toHaveBeenCalledTimes(1);
    expect(subscriptionService.registerPendedSubscription).toHaveBeenCalledWith(
      result.id,
      expect.any(String), // claimId UUID
      expect.any(String), // patientUuid
    );

    const [req] = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.id, result.id));
    expect(req.state).toBe('Pended');
  });

  it('returns Error state when pasClient returns null (network failure)', async () => {
    const patientId = await seedPatient();
    (pasClient.submit as jest.Mock).mockResolvedValue(null);

    const result = await submitPriorAuth(baseFormData(patientId));

    expect(result.state).toBe(PriorAuthState.ERROR);
    expect(result.message).toContain('Failed to connect');

    const [req] = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.id, result.id));
    expect(req.state).toBe('Error');
  });

  it('returns Error state on OperationOutcome FHIR error response', async () => {
    const patientId = await seedPatient();
    (pasClient.submit as jest.Mock).mockResolvedValue({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'invalid', diagnostics: 'Bad request' }],
    });

    const result = await submitPriorAuth(baseFormData(patientId));

    expect(result.state).toBe(PriorAuthState.ERROR);
  });

  it('propagates referralId in result', async () => {
    const patientId = await seedPatient();
    (pasClient.submit as jest.Mock).mockResolvedValue(
      makeClaimResponseBundle('approved', { authNumber: 'AUTH-REF' }),
    );

    const result = await submitPriorAuth({ ...baseFormData(patientId), referralId: 42 });

    expect(result.referralId).toBe(42);
  });

  it('throws if patient not found', async () => {
    (pasClient.submit as jest.Mock).mockResolvedValue(makeClaimResponseBundle('approved'));

    await expect(submitPriorAuth(baseFormData(99999))).rejects.toThrow('Patient not found');
  });

  it('does not call registerPendedSubscription for non-pended outcomes', async () => {
    const patientId = await seedPatient();
    (pasClient.submit as jest.Mock).mockResolvedValue(makeClaimResponseBundle('approved'));

    await submitPriorAuth(baseFormData(patientId));

    expect(subscriptionService.registerPendedSubscription).not.toHaveBeenCalled();
  });
});

// ── handlePayerNotification ───────────────────────────────────────────────────

describe('handlePayerNotification()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (subscriptionService.registerPendedSubscription as jest.Mock).mockResolvedValue(undefined);
    (pasClient.submit as jest.Mock).mockResolvedValue(makeClaimResponseBundle('pended'));
  });

  async function seedPendedRequest(): Promise<number> {
    const patientId = await seedPatient();
    const result = await submitPriorAuth(baseFormData(patientId));
    return result.id;
  }

  it('transitions Pended → Approved on approved notification', async () => {
    const requestId = await seedPendedRequest();
    const notification = makeClaimResponseBundle('approved', {
      authNumber: 'AUTH-NOTIFY',
      requestId,
    });

    const outcome = await handlePayerNotification(notification);

    expect(outcome).not.toBeNull();
    expect(outcome!.requestId).toBe(requestId);
    expect(outcome!.outcome).toBe('approved');

    const [req] = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.id, requestId));
    expect(req.state).toBe('Approved');

    const responses = await db
      .select()
      .from(priorAuthResponses)
      .where(eq(priorAuthResponses.requestId, requestId));
    const notification_resp = responses.find((r) => r.receivedVia === 'subscription');
    expect(notification_resp).toBeDefined();
    expect(notification_resp!.authNumber).toBe('AUTH-NOTIFY');
  });

  it('transitions Pended → Denied on denied notification', async () => {
    const requestId = await seedPendedRequest();
    const notification = makeClaimResponseBundle('denied', {
      denialReason: 'Not covered',
      requestId,
    });

    await handlePayerNotification(notification);

    const [req] = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.id, requestId));
    expect(req.state).toBe('Denied');
  });

  it('returns null if _requestId does not match any pended request', async () => {
    const notification = makeClaimResponseBundle('approved', { requestId: 99999 });

    const outcome = await handlePayerNotification(notification);

    expect(outcome).toBeNull();
  });

  it('returns null if the matched request is not in Pended state', async () => {
    // First submit and approve to move past Pended
    const patientId = await seedPatient();
    (pasClient.submit as jest.Mock).mockResolvedValueOnce(
      makeClaimResponseBundle('approved', { authNumber: 'AUTH-X' }),
    );
    const result = await submitPriorAuth(baseFormData(patientId));

    // Now try to send a notification for an Approved request
    const notification = makeClaimResponseBundle('approved', { requestId: result.id });
    const outcome = await handlePayerNotification(notification);

    expect(outcome).toBeNull();
  });

  it('returns null if body cannot be parsed as ClaimResponse', async () => {
    const outcome = await handlePayerNotification({ not: 'a claim response' });
    expect(outcome).toBeNull();
  });
});

// ── inquirePriorAuth ──────────────────────────────────────────────────────────

describe('inquirePriorAuth()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (subscriptionService.registerPendedSubscription as jest.Mock).mockResolvedValue(undefined);
    (pasClient.submit as jest.Mock).mockResolvedValue(makeClaimResponseBundle('pended'));
  });

  async function seedPendedRequest(): Promise<number> {
    const patientId = await seedPatient();
    const result = await submitPriorAuth(baseFormData(patientId));
    return result.id;
  }

  it('transitions Pended → Approved when inquire returns approved', async () => {
    const requestId = await seedPendedRequest();
    (pasClient.inquire as jest.Mock).mockResolvedValue(
      makeClaimResponseBundle('approved', { authNumber: 'AUTH-INQ' }),
    );

    const status = await inquirePriorAuth(requestId);

    expect(status.state).toBe(PriorAuthState.APPROVED);
    expect(status.authNumber).toBe('AUTH-INQ');

    const [req] = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.id, requestId));
    expect(req.state).toBe('Approved');

    const responses = await db
      .select()
      .from(priorAuthResponses)
      .where(eq(priorAuthResponses.requestId, requestId));
    const inquireResp = responses.find((r) => r.receivedVia === 'inquire');
    expect(inquireResp).toBeDefined();
  });

  it('transitions Pended → Denied when inquire returns denied', async () => {
    const requestId = await seedPendedRequest();
    (pasClient.inquire as jest.Mock).mockResolvedValue(
      makeClaimResponseBundle('denied', { denialReason: 'Experimental' }),
    );

    const status = await inquirePriorAuth(requestId);

    expect(status.state).toBe(PriorAuthState.DENIED);
  });

  it('returns current status without state change when still pended', async () => {
    const requestId = await seedPendedRequest();
    (pasClient.inquire as jest.Mock).mockResolvedValue(makeClaimResponseBundle('pended'));

    const status = await inquirePriorAuth(requestId);

    expect(status.state).toBe(PriorAuthState.PENDED);

    const [req] = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.id, requestId));
    expect(req.state).toBe('Pended');
  });

  it('returns current status without calling pasClient when state is not Pended', async () => {
    const patientId = await seedPatient();
    (pasClient.submit as jest.Mock).mockResolvedValueOnce(
      makeClaimResponseBundle('approved', { authNumber: 'AUTH-Y' }),
    );
    const result = await submitPriorAuth(baseFormData(patientId));

    const status = await inquirePriorAuth(result.id);

    expect(status.state).toBe(PriorAuthState.APPROVED);
    expect(pasClient.inquire).not.toHaveBeenCalled();
  });

  it('throws PriorAuthNotFoundError for non-existent request', async () => {
    await expect(inquirePriorAuth(99999)).rejects.toThrow(PriorAuthNotFoundError);
  });
});

// ── expirePendedRequests ──────────────────────────────────────────────────────

describe('expirePendedRequests()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (subscriptionService.registerPendedSubscription as jest.Mock).mockResolvedValue(undefined);
    (pasClient.submit as jest.Mock).mockResolvedValue(makeClaimResponseBundle('pended'));
  });

  async function seedPendedRequestWithSubmittedAt(submittedAt: Date): Promise<number> {
    const patientId = await seedPatient();
    const result = await submitPriorAuth(baseFormData(patientId));
    // Backdate submittedAt to simulate age
    await db
      .update(priorAuthRequests)
      .set({ submittedAt })
      .where(eq(priorAuthRequests.id, result.id));
    return result.id;
  }

  it('expires a Pended request that exceeded the timeout', async () => {
    const pastTime = new Date(Date.now() - 600000); // 10 minutes ago (> 5 min default)
    const requestId = await seedPendedRequestWithSubmittedAt(pastTime);

    const count = await expirePendedRequests();

    expect(count).toBeGreaterThanOrEqual(1);

    const [req] = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.id, requestId));
    expect(req.state).toBe('Expired');
  });

  it('records a timeout response entry', async () => {
    const pastTime = new Date(Date.now() - 600000);
    const requestId = await seedPendedRequestWithSubmittedAt(pastTime);

    await expirePendedRequests();

    const responses = await db
      .select()
      .from(priorAuthResponses)
      .where(eq(priorAuthResponses.requestId, requestId));
    const timeoutResp = responses.find((r) => r.receivedVia === 'timeout');
    expect(timeoutResp).toBeDefined();
    expect(timeoutResp!.outcome).toBe('expired');
  });

  it('does not expire a recently Pended request', async () => {
    const recentTime = new Date(Date.now() - 60000); // 1 minute ago (< 5 min default)
    const requestId = await seedPendedRequestWithSubmittedAt(recentTime);

    await expirePendedRequests();

    const [req] = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.id, requestId));
    expect(req.state).toBe('Pended');
  });

  it('does not affect already-terminal requests', async () => {
    const patientId = await seedPatient();
    (pasClient.submit as jest.Mock).mockResolvedValueOnce(
      makeClaimResponseBundle('approved', { authNumber: 'AUTH-Z' }),
    );
    const result = await submitPriorAuth(baseFormData(patientId));

    // Backdate to before cutoff — should still be ignored since state is Approved
    await db
      .update(priorAuthRequests)
      .set({ submittedAt: new Date(Date.now() - 600000) })
      .where(eq(priorAuthRequests.id, result.id));

    await expirePendedRequests();

    const [req] = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.id, result.id));
    expect(req.state).toBe('Approved');
  });

  it('returns 0 when no requests are eligible', async () => {
    const recentTime = new Date(Date.now() - 60000);
    await seedPendedRequestWithSubmittedAt(recentTime);

    const count = await expirePendedRequests();

    expect(count).toBe(0);
  });
});
