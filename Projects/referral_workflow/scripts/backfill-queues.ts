/**
 * Backfill script — routes every workspace that has no queue.
 *
 * Usage:  npm run backfill:queues
 *
 * WHY THIS IS NEEDED. PRD-20 routes a workspace to a queue inside
 * `createWorkspace()`, so anything created after this feature shipped is already
 * routed. Two populations are not:
 *
 *   - workspaces created before PRD-20 existed, in any long-running or
 *     previously-seeded database
 *   - referrals inserted directly rather than through the ingest pipeline, which
 *     is what `seed-analytics-demo.ts` does — it never calls `createWorkspace()`
 *     at all, so those workspaces come from `backfill:workspaces` unrouted
 *
 * An unrouted workspace has `queue_id IS NULL` and is therefore invisible in
 * every queue view, including to a user with allQueuesAccess, because scope is
 * an `IN (...)` over queue ids. Invisible, not merely unsorted — which is why
 * this is worth running rather than leaving to drift.
 *
 * IDEMPOTENT. `routeWorkspace()` returns early for a workspace that already has
 * a queue and emits no event, so a re-run is a no-op for everything already
 * routed and still picks up whatever is not. Safe to run repeatedly, and safe to
 * run on a database the live path has partially handled.
 *
 * Run it after `npm run backfill:workspaces` — there must be workspaces to
 * route — and after a seed, so the queues themselves exist.
 */

import { backfillQueues, getDefaultQueue, NoDefaultQueueError } from '../src/modules/workspace/queueService';

async function main(): Promise<void> {
  try {
    await getDefaultQueue();
  } catch (err) {
    if (err instanceof NoDefaultQueueError) {
      console.error('No queues are seeded, so there is nothing to route to.');
      console.error('Run `npm run seed` (or seed:full-demo) first, then try again.');
      process.exit(1);
    }
    throw err;
  }

  console.log('Routing workspaces to queues...\n');

  const { routed, alreadyRouted } = await backfillQueues();

  console.log(`✓ Routed:          ${routed}`);
  console.log(`  Already routed:  ${alreadyRouted}`);

  if (routed === 0 && alreadyRouted === 0) {
    console.log('\nNo workspaces found — run `npm run backfill:workspaces` first.');
  } else if (routed === 0) {
    console.log('\nEvery workspace was already routed — nothing to change.');
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
