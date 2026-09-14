/**
 * Backfill script — creates a referral_workspaces row for every referral that
 * predates PRD-18.
 *
 * Usage:  npm run backfill:workspaces
 *
 * Safe to run multiple times: idempotent on referral_id.
 *
 * Each backfilled workspace derives its work status from the advisory
 * protocol → work status mapping against that referral's CURRENT protocol
 * state, written as mapping-set (workStatusIsManual: false) so the advisory
 * rule behaves correctly from then on. Setting everything to Triage would
 * misrepresent a hundred seeded referrals as untriaged and make the queue views
 * useless on first run.
 */

import { backfillWorkspaces } from '../src/modules/workspace/workspaceService';

async function main(): Promise<void> {
  console.log('Backfilling referral workspaces...\n');

  const { created, skipped } = await backfillWorkspaces();

  console.log(`\n✓ Workspaces created: ${created}`);
  console.log(`  Already present:    ${skipped}`);

  if (created === 0 && skipped === 0) {
    console.log('\nNo referrals found — nothing to backfill.');
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
