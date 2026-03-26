/**
 * Demo Scenarios
 *
 * Provides four pre-canned demo scenarios, each injecting a specific C-CDA fixture
 * and applying scenario-specific post-processing to illustrate a distinct workflow path.
 *
 * Exported functions are called from the POST /demo/launch server route.
 * buildRawEmail is also used by seed-demo.ts.
 *
 * Scenarios:
 *   full-workflow    — Complete C-CDA; clinician accepts, auto-cascade runs to Closed-Confirmed
 *   incomplete-info  — Sparse CCDA; info request sent, referral enters Pending-Information
 *   fhir-enriched    — Michael Kihn C-CDA with sparse structured data; FHIR enriches clinical sections
 *   payer-rejection  — Complete C-CDA; out-of-network payer injected, skill auto-declines
 */

import * as fs from 'fs';
import * as path from 'path';
import { eq } from 'drizzle-orm';
import { processInboundMessage } from './modules/prd01/messageProcessor';
import { ingestReferral } from './modules/prd02/referralService';
import { sendInfoRequest } from './modules/prd09/infoRequestService';
import { evaluateSkills } from './modules/prd09/skillEvaluator';
import { executeSkillAction } from './modules/prd09/skillActions';
import { db } from './db';
import { referrals } from './db/schema';

const FIXTURES_DIR = path.resolve(__dirname, '../tests/fixtures');

// ── Shared helpers ────────────────────────────────────────────────────────────

export interface RawEmailOptions {
  fromName: string;
  fromAddress: string;
  messageIdSuffix: string;
}

export function buildRawEmail(cdaContent: string, opts?: RawEmailOptions): string {
  const boundary = 'DEMO_BOUNDARY_001';
  const CRLF = '\r\n';

  const fromName = opts?.fromName ?? 'Demo Referrer';
  const fromAddress = opts?.fromAddress ?? 'referrer@hospital.direct';
  const messageIdSuffix = opts?.messageIdSuffix ?? String(Date.now());

  const textPart = [
    `--${boundary}`,
    'Content-Type: text/plain',
    '',
    'Please find the referral attached.',
  ].join(CRLF);

  const cdaPart = [
    `--${boundary}`,
    'Content-Type: application/xml',
    'Content-Disposition: attachment; filename="referral.xml"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(cdaContent).toString('base64'),
  ].join(CRLF);

  const parts = [textPart, cdaPart, `--${boundary}--`].join(CRLF);

  const headers = [
    `From: ${fromName} <${fromAddress}>`,
    'To: receiving@specialist.direct',
    'Subject: Referral — Demo Patient',
    `Message-ID: <demo-${messageIdSuffix}@hospital.direct>`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
  ].join(CRLF);

  return headers + parts;
}

function readFixture(filename: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8');
}

async function ingest(cda: string, opts?: RawEmailOptions): Promise<number> {
  const rawEmail = buildRawEmail(cda, opts);
  const processed = await processInboundMessage(rawEmail);
  const referralId = await ingestReferral(processed);
  if (referralId === null) {
    throw new Error('Referral was auto-declined during ingest — unexpected for this scenario');
  }
  return referralId;
}

// ── Scenario 1: Full Non-Stop Workflow ────────────────────────────────────────

/**
 * Injects a complete C-CDA (Sarah Chen). The auto-cascade (accept → schedule →
 * encounter → close) fires automatically when the clinician accepts in the UI.
 */
export async function launchFullWorkflow(): Promise<number> {
  const cda = readFixture('demo-full-workflow.xml');
  const referralId = await ingest(cda, {
    fromName: 'Dr. Robert Wilson',
    fromAddress: 'referrer@hospital.direct',
    messageIdSuffix: `full-workflow-${Date.now()}`,
  });
  console.log(`[Demo] Full workflow scenario launched — Referral #${referralId} (Sarah Chen). Accept in the UI to start the cascade.`);
  return referralId;
}

// ── Scenario 2: Incomplete Info (Pending-Information) ─────────────────────────

/**
 * Injects a sparse C-CDA (James Okafor) with no structured ICD codes.
 * After ingest, directly calls sendInfoRequest to transition to Pending-Information
 * and fire the info-request email to the referrer.
 */
export async function launchIncompleteInfo(): Promise<number> {
  const cda = readFixture('demo-incomplete-info.xml');
  const referralId = await ingest(cda, {
    fromName: 'Dr. Anita Patel',
    fromAddress: 'referrer@hospital.direct',
    messageIdSuffix: `incomplete-info-${Date.now()}`,
  });

  await sendInfoRequest(
    referralId,
    'This referral is missing required ICD-10 diagnosis codes. Please provide specific diagnosis codes that support the reason for referral (e.g., abdominal pain: R10.9, altered bowel habits: K59.9, weight loss: R63.4).',
    'missing-icd-codes',
  );

  console.log(`[Demo] Incomplete info scenario launched — Referral #${referralId} (James Okafor) → Pending-Information`);
  return referralId;
}

// ── Scenario 3: FHIR-Enriched ─────────────────────────────────────────────────

/**
 * Injects a sparse C-CDA for Michael Kihn (FHIR ID 123836453).
 * FHIR enrichment runs automatically during ingestReferral — no extra steps needed.
 * The referral review page will show FHIR enrichment indicators.
 */
export async function launchFhirEnriched(): Promise<number> {
  const cda = readFixture('demo-fhir-enriched.xml');
  const referralId = await ingest(cda, {
    fromName: 'Dr. Robert Wilson',
    fromAddress: 'referrer@hospital.direct',
    messageIdSuffix: `fhir-enriched-${Date.now()}`,
  });
  console.log(`[Demo] FHIR-enriched scenario launched — Referral #${referralId} (Michael Kihn). Check the review page for FHIR enrichment.`);
  return referralId;
}

// ── Scenario 4: Payer Rejection ───────────────────────────────────────────────

/**
 * Injects a complete C-CDA (Marcus Webb). After ingest, injects an out-of-network
 * payer into clinicalData, then re-evaluates post-intake skills. The payer-network-check
 * skill (active, not test-mode) will detect the out-of-network payer and auto-decline.
 */
export async function launchPayerRejection(): Promise<number> {
  const cda = readFixture('demo-payer-rejection.xml');
  const referralId = await ingest(cda, {
    fromName: 'Dr. Linh Nguyen',
    fromAddress: 'referrer@hospital.direct',
    messageIdSuffix: `payer-rejection-${Date.now()}`,
  });

  // Inject out-of-network payer into clinicalData
  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!referral) throw new Error(`Referral #${referralId} not found after ingest`);

  let clinicalData: Record<string, unknown> = {};
  if (referral.clinicalData) {
    try { clinicalData = JSON.parse(referral.clinicalData) as Record<string, unknown>; } catch { /* leave empty */ }
  }
  clinicalData.payer = 'OutOfNetwork Insurance Co';

  await db
    .update(referrals)
    .set({ clinicalData: JSON.stringify(clinicalData), updatedAt: new Date() })
    .where(eq(referrals.id, referralId));

  // Re-evaluate post-intake skills — payer-network-check should now match
  const evalResult = await evaluateSkills('post-intake', referralId);
  if (evalResult.winningAction && !evalResult.winningAction.isTestMode) {
    await executeSkillAction(evalResult.winningAction, referralId);
    console.log(`[Demo] Payer rejection scenario launched — Referral #${referralId} (Marcus Webb) auto-declined by "${evalResult.winningAction.skillName}"`);
  } else {
    console.warn(`[Demo] Payer rejection scenario — no matching skill action fired for referral #${referralId}. Check that payer-network-check skill is active and not in test-mode.`);
  }

  return referralId;
}
