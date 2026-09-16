/**
 * Backfill script — indexes every document already in the database.
 *
 * Usage:  npm run backfill:documents
 *
 * WHY THIS IS NEEDED AT ALL. PRD-23 indexes documents as they are created,
 * through one hook in `recordThreadMessage()`. Everything that arrived before
 * that hook existed — every referral in a seeded or long-running database — has
 * no index entry and would be invisible in the collection forever.
 *
 * It also reaches the three sources the live hook does not cover, because they
 * are not thread messages: claims attachment responses, prior-auth bundles and
 * payer decisions.
 *
 * IDEMPOTENT PER ROW, unlike `backfill-thread.ts`. That script short-circuits if
 * `referral_messages` has any rows at all, which means a database half-populated
 * by the live path can never be completed by running it. This one relies on the
 * unique index over (workspace, content source, content ref), so a re-run is a
 * no-op for what is already indexed and still picks up what is not.
 *
 * Run it after `npm run seed` and after `npm run backfill:parties` — parties
 * first, so each document can be attributed to the organization that sent it.
 */

import { backfillDocuments } from '../src/modules/workspace/documentService';

async function main(): Promise<void> {
  console.log('Indexing existing referral documents...\n');

  const { messages, legacyCcda, attachments, priorAuth, alreadyIndexed, empty } =
    await backfillDocuments();
  const indexed = messages + legacyCcda + attachments + priorAuth;

  console.log(`\n✓ Protocol messages indexed:   ${messages}`);
  console.log(`  Legacy referral C-CDAs:       ${legacyCcda}`);
  console.log(`  Claims attachments:           ${attachments}`);
  console.log(`  Prior-auth documents:         ${priorAuth}`);
  console.log(`  Already indexed:              ${alreadyIndexed}`);
  console.log(`  Thread entries w/o content:   ${empty}`);

  if (indexed === 0 && alreadyIndexed === 0 && empty === 0) {
    console.log('\nNo workspaces found — run `npm run backfill:workspaces` first.');
  } else if (indexed === 0) {
    console.log('\nEvery document was already indexed — nothing to change.');
  }

  if (legacyCcda > 0) {
    console.log(
      `\nNote: ${legacyCcda} referral C-CDA(s) were indexed from referrals.raw_ccda_xml because\n` +
        'they had no ReferralCCDA thread row. On a healthy database that number is zero;\n' +
        'a non-zero count means this database predates the thread backfill or skipped it.',
    );
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
