/**
 * Demo seed script — bypasses IMAP and injects the fixture C-CDA directly.
 *
 * Usage:  ts-node -r ./scripts/node-polyfill.js scripts/seed-demo.ts
 *
 * Creates a referral record in the DB and prints the review URL.
 */

import * as fs from 'fs';
import * as path from 'path';
import { processInboundMessage } from '../src/modules/prd01/messageProcessor';
import { ingestReferral } from '../src/modules/prd02/referralService';

const FIXTURE = path.resolve(__dirname, '../tests/fixtures/sample-referral.xml');
const cdaXml = fs.readFileSync(FIXTURE, 'utf-8');
const PORT = process.env.PORT ?? '3000';

// Build a minimal raw RFC 2822 email with the C-CDA attached
function buildRawEmail(cdaContent: string): string {
  const boundary = 'DEMO_BOUNDARY_001';
  const CRLF = '\r\n';

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
    'From: referrer@hospital.direct',
    'To: receiving@specialist.direct',
    'Subject: Referral — Demo Patient',
    `Message-ID: <demo-seed-${Date.now()}@hospital.direct>`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
  ].join(CRLF);

  return headers + parts;
}

async function main(): Promise<void> {
  console.log('Seeding demo referral...\n');

  const rawEmail = buildRawEmail(cdaXml);
  const processed = await processInboundMessage(rawEmail);

  if (!processed.referralData.isCdaValid) {
    console.warn('C-CDA validation errors:', processed.referralData.validationErrors);
  }

  const referralId = await ingestReferral(processed);

  if (referralId === null) {
    console.error('Auto-declined — referral did not pass validation gates.');
    console.error('Errors:', processed.referralData.validationErrors);
    process.exit(1);
  }

  console.log(`\n✓ Referral #${referralId} created successfully.`);
  console.log(`\nOpen the review UI:\n`);
  console.log(`  http://localhost:${PORT}/referrals/${referralId}/review\n`);
  console.log('Make sure the server is running (npm run dev) before opening the URL.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
