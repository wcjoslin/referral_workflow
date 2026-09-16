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
import { seedUsers } from '../src/modules/workspace/userRoster';
import { seedQueues } from '../src/modules/workspace/queueService';

const FIXTURE = path.resolve(__dirname, '../tests/fixtures/sample-referral.xml');
const cdaXml = fs.readFileSync(FIXTURE, 'utf-8');
const PORT = process.env.PORT ?? '3000';

async function main(): Promise<void> {
  // PRD-17: the staff roster. Idempotent on email, so re-running is safe.
  // This script otherwise performs no direct inserts — it is a wrapper over the
  // real ingest pipeline — so seeding users is a new capability here.
  const { created, skipped } = await seedUsers();
  console.log(`Seeded staff roster: ${created} created, ${skipped} already present.`);

  // PRD-20: queues, BEFORE the referral is ingested. createWorkspace() routes
  // from the department, and routing with no queues seeded leaves queue_id null
  // — recoverable by `npm run backfill:queues`, but the demo would first render
  // an empty queue view, which is exactly the wrong first impression.
  const q = await seedQueues();
  console.log(`Seeded queues: ${q.created} created, ${q.existing} already present.`);

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
