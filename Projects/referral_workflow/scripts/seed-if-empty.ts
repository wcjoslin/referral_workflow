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
import * as path from 'path';
import { config } from '../src/config';
import { PROJECT_ROOT } from '../src/paths';

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
  // Compiled (dist/scripts/seed-if-empty.js): run the compiled seed beside it
  // with plain node, so a cold start never compiles TypeScript. From source
  // under ts-node: the npm script, as before.
  const compiled = __filename.endsWith('.js');
  const result = compiled
    ? spawnSync(
        process.execPath,
        ['-r', path.join(PROJECT_ROOT, 'scripts', 'node-polyfill.js'), path.join(__dirname, 'seed-full-demo.js')],
        { stdio: 'inherit' },
      )
    : spawnSync('npm', ['run', 'seed:full-demo'], { stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error('[SeedIfEmpty] Seeding failed; starting anyway with what is there.');
  }
}
