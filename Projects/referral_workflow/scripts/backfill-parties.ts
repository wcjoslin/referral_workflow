/**
 * Backfill script — gives every existing workspace its parties.
 *
 * Usage:  npm run backfill:parties
 *
 * WHY THIS IS NEEDED AT ALL. Party seeding runs inside `createWorkspace()`, and
 * `backfillWorkspaces()` calls that only for workspaces it is CREATING —
 * existing ones take a different path. So every workspace already in the
 * database has no parties and its panel would read "Unknown organization"
 * forever.
 *
 * That is not a hypothetical: PRD-18's first backfill skipped existing
 * workspaces the same way and left all hundred seeded ones stuck in Triage.
 * This script exists so the same mistake does not land twice.
 *
 * It also recovers each party's observed addresses from the stored message
 * history, since `referral_messages.sender_address` has been recording every
 * inbound sender all along — so a backfilled workspace knows what a workspace
 * built up live would know.
 *
 * Idempotent on (workspace, party role). Safe to run repeatedly, and quiet when
 * there is nothing to do. Run it after `npm run seed`.
 */

import { backfillParties } from '../src/modules/workspace/partyService';

async function main(): Promise<void> {
  console.log('Backfilling workspace parties...\n');

  const { created, updated, skipped } = await backfillParties();

  console.log(`\n✓ Workspaces given parties: ${created}`);
  console.log(`  Missing roles filled in:  ${updated}`);
  console.log(`  Already complete:         ${skipped}`);

  if (created === 0 && updated === 0 && skipped === 0) {
    console.log('\nNo workspaces found — run `npm run backfill:workspaces` first.');
  } else if (created === 0 && updated === 0) {
    console.log('\nEvery workspace already had its parties — nothing to change.');
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
