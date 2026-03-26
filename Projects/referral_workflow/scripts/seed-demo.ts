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
import { buildRawEmail } from '../src/demoScenarios';

const FIXTURE = path.resolve(__dirname, '../tests/fixtures/sample-referral.xml');
const cdaXml = fs.readFileSync(FIXTURE, 'utf-8');
const PORT = process.env.PORT ?? '3000';

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
