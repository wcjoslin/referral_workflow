/**
 * Filesystem locations that must not depend on where the running code lives.
 *
 * The same modules run from `src/` under ts-node and from `dist/src/` once
 * compiled, so `path.join(__dirname, '..')` means the project root in one and
 * `dist/` in the other. Everything here is resolved from the project root
 * instead, found by walking up to the nearest package.json.
 *
 * The HTML views and test fixtures are read from the SOURCE tree in both cases:
 * the compiler does not copy them, and keeping one copy means a compiled build
 * can never serve a stale view.
 */

import * as fs from 'fs';
import * as path from 'path';

function findProjectRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No package.json above ${start}`);
    dir = parent;
  }
}

export const PROJECT_ROOT = findProjectRoot(__dirname);
export const VIEWS_DIR = path.join(PROJECT_ROOT, 'src', 'views');
export const FIXTURES_DIR = path.join(PROJECT_ROOT, 'tests', 'fixtures');
export const NODE_MODULES_DIR = path.join(PROJECT_ROOT, 'node_modules');
