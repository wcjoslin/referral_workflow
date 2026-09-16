/**
 * Backfill script — computes the next action and due date for every workspace.
 *
 * Usage:  npm run backfill:next-actions
 *
 * WHY THIS IS NEEDED. PRD-26 writes `next_action` and `next_action_due_at`
 * synchronously with each transition, so anything that has moved since this
 * feature shipped already has them. Workspaces that have not transitioned since
 * — every referral in a seeded or long-running database — have a null next
 * action and are therefore invisible to the overdue sweep and blank in the queue
 * view's Next Action column.
 *
 * DUE DATES ARE COMPUTED FROM EACH WORKSPACE'S OWN TIMESTAMP, not from now.
 * That distinction is the whole reason this script is safe to run on a live
 * database: computing from `now` would reset every deadline to the moment of the
 * backfill and un-overdue the lot, which looks exactly like the feature working.
 * The first implementation had that bug — it used `updated_at`, which the
 * recompute itself writes — and it is pinned by a test now.
 *
 * IDEMPOTENT. A repeated run recomputes the same values from the same stable
 * timestamps and emits no events, because `recomputeNextAction()` writes only
 * when something actually changed.
 *
 * Archived workspaces are skipped: they are out of the working set, and giving
 * them deadlines would put permanent noise in the overdue sweep.
 *
 * Run it after `npm run backfill:workspaces`.
 */

import { backfillNextActions } from '../src/modules/workspace/nextActionService';
import { getOverdueWorkspaces } from '../src/modules/prd07/overdueChecker';

async function main(): Promise<void> {
  console.log('Computing next actions and due dates...\n');

  const { computed, skipped } = await backfillNextActions();

  console.log(`✓ Computed:  ${computed}`);
  console.log(`  Skipped:   ${skipped}  (archived, or no referral row)`);

  if (computed === 0 && skipped === 0) {
    console.log('\nNo workspaces found — run `npm run backfill:workspaces` first.');
    return;
  }

  // Reported, not notified. The sweep in src/index.ts emits workspace.overdue;
  // this script deliberately does not, so a backfill cannot flood the audit log
  // with breaches that are historical rather than new.
  const overdue = await getOverdueWorkspaces();
  console.log(`\n  Already overdue: ${overdue.length}`);
  for (const w of overdue.slice(0, 10)) {
    console.log(
      `    #${w.workspaceId} referral ${w.referralId} | ${w.hoursOverdue}h | ${w.nextAction}`,
    );
  }
  if (overdue.length > 10) console.log(`    ... and ${overdue.length - 10} more`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
