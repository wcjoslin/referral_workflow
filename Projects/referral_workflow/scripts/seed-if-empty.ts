/**
 * Seeds the full demo ONCE, on a database that has no referrals yet.
 *
 * Run at start-up on Railway, where the database lives on a persistent volume.
 * Seeding at BUILD time — what railway.json used to do — writes into the build
 * image, never into the volume, so the deployed app started empty. Running
 * `seed:full-demo` on every start would be the opposite mistake: it resets the
 * demo tables, wiping whatever anyone did since the last deploy.
 *
 * So: count referrals, seed only when there are none.
 */

import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import { config } from '../src/config';

function referralCount(): number {
  const sqlite = new Database(config.database.url);
  try {
    const row = sqlite.prepare('SELECT count(*) AS n FROM referrals').get() as { n: number };
    return row.n;
  } finally {
    sqlite.close();
  }
}

const existing = referralCount();
if (existing > 0) {
  console.log(`[SeedIfEmpty] ${existing} referrals already present — not seeding.`);
} else {
  console.log('[SeedIfEmpty] Empty database — seeding the full demo.');
  const result = spawnSync('npm', ['run', 'seed:full-demo'], { stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error('[SeedIfEmpty] Seeding failed; starting anyway with what is there.');
  }
}
