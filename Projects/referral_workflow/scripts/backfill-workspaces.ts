/**
 * Backfill script — brings every referral's workspace into line with its
 * protocol state.
 *
 * Usage:  npm run backfill:workspaces
 *
 * Creates the workspace for any referral that has none, and re-derives the work
 * status of any existing workspace that has gone stale. A workspace goes stale
 * whenever referrals.state is written without a proposal reaching it, which is
 * what the demo seed does for all 100 referrals — so run this after seeding.
 *
 * Re-deriving cannot overwrite a status a person set, an Exception or
 * Follow-up-Required, or an archived workspace; those are reported as skipped.
 *
 * Safe to run multiple times, and quiet when there is nothing to do.
 */

import { backfillWorkspaces } from '../src/modules/workspace/workspaceService';

async function main(): Promise<void> {
  console.log('Backfilling referral workspaces...\n');

  const { created, updated, skipped } = await backfillWorkspaces();

  console.log(`\n✓ Workspaces created:     ${created}`);
  console.log(`  Stale statuses updated: ${updated}`);
  console.log(`  Left untouched:         ${skipped}`);

  if (created === 0 && updated === 0 && skipped === 0) {
    console.log('\nNo referrals found — nothing to backfill.');
  } else if (created === 0 && updated === 0) {
    console.log('\nEverything was already in line — nothing to change.');
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
