/**
 * Lint regression budget.
 *
 * Usage:  npm run lint:budget
 *
 * WHY NOT JUST `npm run lint`
 *
 * `src/` carries 107 pre-existing ESLint errors and 4 warnings. A CI job that
 * simply runs `npm run lint` would be red from the first commit and stay red,
 * which teaches everyone to ignore it — worse than having no lint job at all.
 * Cleaning all 111 up is a real piece of work and not this change's job.
 *
 * So the budget: the build fails when the problem count RISES above the
 * committed baseline in .lint-baseline.json. New code cannot add lint debt, and
 * the existing debt stays visible with a number attached.
 *
 * When the count drops, this says so and fails nothing — lower the baseline in
 * the same commit that fixed the problems, so the ratchet only turns one way.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(projectRoot, '.lint-baseline.json');

function readBaseline() {
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    if (typeof parsed.maxProblems !== 'number') {
      throw new Error('.lint-baseline.json must set a numeric "maxProblems"');
    }
    return parsed.maxProblems;
  } catch (err) {
    console.error(`Could not read ${baselinePath}: ${err.message}`);
    process.exit(1);
  }
}

function runEslint() {
  // ESLint exits non-zero whenever there are errors, which is the normal case
  // here — so a non-zero status is not itself a failure. Only unparseable
  // output is.
  let stdout;
  try {
    stdout = execFileSync(
      'npx',
      ['eslint', 'src', '--ext', '.ts', '-f', 'json'],
      { cwd: projectRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
    );
  } catch (err) {
    stdout = err.stdout;
    if (!stdout) {
      console.error('ESLint produced no output; it failed to run rather than finding problems.');
      process.exit(1);
    }
  }

  try {
    return JSON.parse(stdout);
  } catch {
    console.error('Could not parse ESLint JSON output.');
    process.exit(1);
  }
}

const baseline = readBaseline();
const results = runEslint();

let errors = 0;
let warnings = 0;
for (const file of results) {
  errors += file.errorCount;
  warnings += file.warningCount;
}
const total = errors + warnings;

console.log(`ESLint: ${total} problems (${errors} errors, ${warnings} warnings)`);
console.log(`Budget: ${baseline}`);

if (total > baseline) {
  console.error(
    `\nFAIL: lint problems rose by ${total - baseline} above the baseline of ${baseline}.\n` +
      `This change added lint debt. Fix the new problems rather than raising the baseline.\n` +
      `Run \`npm run lint\` to see them, or \`npm run lint:fix\` for the mechanical ones.`,
  );
  process.exit(1);
}

if (total < baseline) {
  console.log(
    `\n${baseline - total} fewer than the baseline. Lower "maxProblems" in ` +
      `.lint-baseline.json to ${total} in this same commit, so the ratchet only turns one way.`,
  );
}

console.log('\nWithin budget.');
