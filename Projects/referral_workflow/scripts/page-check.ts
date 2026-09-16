/**
 * Page check — loads every page in a real browser and fails on a JS exception.
 *
 * WHY THIS EXISTS, AND WHY THE SMOKE CHECK IS NOT ENOUGH. `/workspaces/:id`
 * shipped rendering NOTHING: thirteen blank cards. `nextActionBlock()`
 * referenced a `readOnly` declared locally in a sibling function, so a
 * `ReferenceError` escaped `renderHeader()` and aborted the page's render.
 *
 * Every gate was green:
 *
 *   - `npm test` never loads a view
 *   - `npm run smoke` asserts the HTML the SERVER SENDS, which was byte-perfect
 *     — it carries the right payload and the right markup, and the failure
 *     happens in the browser afterwards
 *   - `tsc` does not typecheck inline `<script>` in .html, and eslint
 *     (`eslint src --ext .ts`) does not lint it, so `no-undef` never saw it
 *
 * These pages render client-side from an embedded payload, so "the bytes are
 * right" and "the page works" are different claims. This script makes the
 * second one. It is the third gate in the same lineage as the other two: unit
 * tests, then a byte-level smoke check after two defects shipped through a
 * green suite, and now an execution-level check after a blank page shipped
 * through a green smoke check.
 *
 * WHAT COUNTS AS A FAILURE: an uncaught exception, a console error, a failed
 * same-origin request, or a page whose every card is empty (a silent render
 * abort that throws nothing).
 *
 * WHAT DOES NOT: an external script that could not be fetched. `/analytics`
 * and `/overview` load Chart.js and mermaid from a CDN, and a sandboxed or
 * offline runner cannot reach it — `Chart is not defined` there is the network,
 * not the code. Those two are reported as `cdn-unavailable` and do not fail the
 * run, but ONLY when the exception names a global whose own script is known to
 * have failed to load. Every other error on those pages still fails, so they
 * stay covered for everything except the thing the environment broke.
 *
 * KNOWN LIMITATION, stated rather than left to be discovered: the fixtures are
 * deliberately minimal, so `/analytics` has nothing to plot and never reaches
 * its charting code — it passes without exercising the path that would need
 * `Chart` at all. Its coverage here is therefore shallow: enough to catch a
 * page that throws on load, not enough to catch one that throws while drawing.
 * Seeding an analytics dataset would deepen it, at the cost of making this gate
 * slow and its fixtures a second seed to maintain.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { randomUUID } from 'crypto';

// Config is read at import time, so the port must be set before src/server
// loads. Distinct from the smoke check's port so the two can run together.
const PORT = process.env.PAGECHECK_PORT ?? '3601';
process.env.PORT = PORT;

// Asserted by the smoke check, irrelevant here, and pinned so a developer's
// demo .env cannot change what this script exercises.
process.env.WORKSPACE_REVEAL_INVITE_LINK = 'false';

const BASE = `http://127.0.0.1:${PORT}`;
const DEVTOOLS_PORT = process.env.PAGECHECK_DEVTOOLS_PORT ?? '9333';

/** Globals supplied by an external script, for the CDN carve-out above. */
const EXTERNAL_GLOBALS: ReadonlyArray<{ scriptMatch: RegExp; global: string }> = [
  { scriptMatch: /chart\.js/i, global: 'Chart' },
  { scriptMatch: /mermaid/i, global: 'mermaid' },
];

interface PageSpec {
  path: string;
  /** Cards are expected, so "every card empty" is a render abort. */
  expectCards?: boolean;
}

type Verdict = 'ok' | 'fail' | 'cdn-unavailable';

interface Result {
  path: string;
  verdict: Verdict;
  problems: string[];
  cards: number;
  emptyCards: number;
  textChars: number;
}

// ── Browser discovery ────────────────────────────────────────────────────────

/**
 * Finds a Chrome or Chromium binary.
 *
 * Ordered so an explicit choice wins: CI sets `CHROME_PATH`, the GitHub runner
 * images set `CHROME_BIN`, a developer box has one on PATH, and this repo's own
 * container has the Playwright download. Nothing is installed by this script —
 * a missing browser is a clear error, not a silent skip, because a check that
 * quietly does nothing is worse than no check.
 */
function findBrowser(): string {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // A glob-free look through the Playwright download directory, whose version
  // suffix changes with the dependency.
  const pwRoot = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (fs.existsSync(pwRoot)) {
    for (const entry of fs.readdirSync(pwRoot)) {
      const p = `${pwRoot}/${entry}/chrome-linux/chrome`;
      if (entry.startsWith('chromium') && fs.existsSync(p)) return p;
    }
  }

  throw new Error(
    'No Chrome or Chromium binary found. Set CHROME_PATH to one, or install ' +
      'Chrome on the runner. Tried: ' +
      candidates.join(', '),
  );
}

// ── Minimal CDP client ───────────────────────────────────────────────────────

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (r: Record<string, unknown>) => void>();
  private handlers: Array<(method: string, params: Record<string, unknown>) => void> = [];
  /** Any protocol traffic at all, used as the network-idle signal. */
  public eventCount = 0;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.onmessage = (e: MessageEvent): void => {
      const m = JSON.parse(String(e.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: Record<string, unknown>;
      };
      if (typeof m.id === 'number') {
        const res = this.pending.get(m.id);
        if (res) {
          res(m.result ?? {});
          this.pending.delete(m.id);
        }
        return;
      }
      if (m.method) {
        this.eventCount += 1;
        for (const h of this.handlers) h(m.method, m.params ?? {});
      }
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = (): void => resolve();
      ws.onerror = (): void => reject(new Error(`could not open a CDP socket at ${url}`));
    });
    return new Cdp(ws);
  }

  on(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.handlers.push(handler);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── The check ────────────────────────────────────────────────────────────────

async function checkPage(cdp: Cdp, spec: PageSpec): Promise<Result> {
  const problems: string[] = [];
  const failedScripts: string[] = [];
  const requestUrls = new Map<string, string>();

  const off = (method: string, params: Record<string, unknown>): void => {
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails as
        | { text?: string; exception?: { description?: string } }
        | undefined;
      const desc = d?.exception?.description ?? d?.text ?? 'unknown exception';
      problems.push(`EXCEPTION ${String(desc).split('\n')[0]}`);
    }
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      const args = (params.args as Array<{ value?: unknown; description?: string }>) ?? [];
      problems.push(
        `CONSOLE.ERROR ${args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160)}`,
      );
    }
    if (method === 'Network.requestWillBeSent') {
      const id = params.requestId as string;
      const req = params.request as { url?: string } | undefined;
      if (id && req?.url) requestUrls.set(id, req.url);
    }
    if (method === 'Network.loadingFailed') {
      const url = requestUrls.get(params.requestId as string) ?? '';
      if (url) failedScripts.push(url);
    }
    if (method === 'Network.responseReceived') {
      const res = params.response as { status?: number; url?: string } | undefined;
      const status = res?.status ?? 0;
      const url = res?.url ?? '';
      // Only same-origin: a CDN returning 403 to a sandbox is the environment.
      //
      // `/favicon.ico` is excluded because the BROWSER requests it unprompted
      // on every navigation and this app does not serve one. No page depends on
      // it, so counting it would fail every page for a reason unrelated to
      // whether the page works.
      if (status >= 400 && url.startsWith(BASE) && !url.endsWith('/favicon.ico')) {
        problems.push(`HTTP ${status} ${url.replace(BASE, '')}`);
      }
    }
  };
  cdp.on(off);

  await cdp.send('Page.navigate', { url: `${BASE}${spec.path}` });

  // Network idle: no protocol traffic for 1.5s, with a hard ceiling so a page
  // that never settles fails the run rather than hanging it.
  let last = -1;
  let quiet = 0;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (cdp.eventCount === last) quiet += 250;
    else {
      quiet = 0;
      last = cdp.eventCount;
    }
    if (quiet >= 1500) break;
  }

  const probe = (await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const cards = Array.from(document.querySelectorAll('.card,.path-card'));
      return JSON.stringify({
        cards: cards.length,
        empty: cards.filter((c) => c.innerText.trim().length === 0).length,
        chars: document.body.innerText.trim().length,
      });
    })()`,
    returnByValue: true,
  })) as { result?: { value?: string } };

  const stats = JSON.parse(probe.result?.value ?? '{"cards":0,"empty":0,"chars":0}') as {
    cards: number;
    empty: number;
    chars: number;
  };

  // A render that aborted without throwing still leaves every card empty.
  if (spec.expectCards && stats.cards > 0 && stats.empty === stats.cards) {
    problems.push(`every one of ${stats.cards} cards is empty — the render aborted silently`);
  }

  const unique = [...new Set(problems)];

  // The CDN carve-out: every problem must be a missing global whose own script
  // failed to load. One unrelated error and the page fails as normal.
  const cdnOnly =
    unique.length > 0 &&
    unique.every((p) =>
      EXTERNAL_GLOBALS.some(
        (g) =>
          p.includes(`${g.global} is not defined`) &&
          failedScripts.some((s) => g.scriptMatch.test(s)),
      ),
    );

  return {
    path: spec.path,
    verdict: unique.length === 0 ? 'ok' : cdnOnly ? 'cdn-unavailable' : 'fail',
    problems: unique,
    cards: stats.cards,
    emptyCards: stats.empty,
    textChars: stats.chars,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Enough data that every page renders its populated path rather than its empty
 * state — an empty state renders fine and would prove nothing.
 *
 * Mirrors the smoke check's fixture order, which matters: queues must exist
 * before `backfillWorkspaces()` runs, because that goes through
 * `createWorkspace()`, which routes.
 */
async function seedFixtures(): Promise<{ workspaceId: number; queueSlug: string; referralId: number }> {
  const { db } = await import('../src/db');
  const { patients, referrals } = await import('../src/db/schema');
  const { ReferralState } = await import('../src/state/referralStateMachine');

  const [patient] = await db
    .insert(patients)
    .values({ firstName: 'Page', lastName: 'Check', dateOfBirth: '1980-01-01' })
    .returning();

  const [referral] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      sourceMessageId: `pagecheck-${randomUUID()}`,
      referrerAddress: 'referrer@primary.direct',
      reasonForReferral: 'Page check fixture',
      state: ReferralState.SCHEDULED,
      routingDepartment: 'Cardiology',
      rawCcdaXml: '<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3"/>',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const { seedQueues, seedQueueMemberships } = await import('../src/modules/workspace/queueService');
  await seedQueues();

  const { seedUsers } = await import('../src/modules/workspace/userRoster');
  await seedUsers();

  // Without memberships the default acting user resolves an EMPTY queue scope,
  // so /queues renders its empty state and /queues/:slug refuses with 403 —
  // both correct, and neither exercises the populated render.
  await seedQueueMemberships();

  const { backfillWorkspaces, getWorkspaceByReferralId } = await import(
    '../src/modules/workspace/workspaceService'
  );
  await backfillWorkspaces();

  const ws = await getWorkspaceByReferralId(referral.id);
  if (!ws) throw new Error('the fixture workspace was not created');

  return { workspaceId: ws.id, queueSlug: 'cardiology', referralId: referral.id };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Page check — every page in a real browser ===\n');

  const fixtures = await seedFixtures();

  const { startServer } = await import('../src/server');
  startServer();

  const serverDeadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > serverDeadline) throw new Error('the server did not come up within 30s');
    await sleep(250);
  }
  console.log(`Server up on ${BASE}`);

  const binary = findBrowser();
  console.log(`Browser: ${binary}\n`);

  let browser: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    browser = spawn(
      binary,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--remote-debugging-port=${DEVTOOLS_PORT}`,
        `--user-data-dir=${fs.mkdtempSync('/tmp/pagecheck-')}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    const cdpDeadline = Date.now() + 30_000;
    let pageWs = '';
    for (;;) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json`)).json()) as Array<{
          type: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) {
          pageWs = page.webSocketDebuggerUrl;
          break;
        }
      } catch {
        // devtools not listening yet
      }
      if (Date.now() > cdpDeadline) throw new Error('the browser did not expose a CDP target');
      await sleep(250);
    }

    cdp = await Cdp.connect(pageWs);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    // Views are read from disk per request, so a cached page can hide a fix.
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    const pages: PageSpec[] = [
      { path: '/' },
      { path: '/queues' },
      { path: `/queues/${fixtures.queueSlug}` },
      { path: '/workspaces' },
      { path: `/workspaces/${fixtures.workspaceId}`, expectCards: true },
      { path: '/exceptions' },
      { path: '/walkthrough', expectCards: true },
      { path: '/demo' },
      { path: '/analytics' },
      { path: '/overview' },
      { path: '/claims' },
      { path: '/prior-auth' },
      { path: '/rules/admin' },
      { path: '/messages' },
      { path: `/referrals/${fixtures.referralId}/review`, expectCards: true },
    ];

    const results: Result[] = [];
    for (const spec of pages) {
      const r = await checkPage(cdp, spec);
      results.push(r);
      const label = r.verdict === 'ok' ? '  ✓' : r.verdict === 'cdn-unavailable' ? '  ~' : '  ✗';
      console.log(
        `${label} ${r.path.padEnd(26)} text=${String(r.textChars).padStart(6)} ` +
          `cards=${r.cards}${r.cards ? ` empty=${r.emptyCards}` : ''}` +
          (r.verdict === 'cdn-unavailable' ? '  (external script unreachable)' : ''),
      );
      for (const p of r.problems) console.log(`      ${p}`);
    }

    const failed = results.filter((r) => r.verdict === 'fail');
    const skipped = results.filter((r) => r.verdict === 'cdn-unavailable');

    console.log(
      `\n${results.length - failed.length - skipped.length}/${results.length} pages render clean` +
        (skipped.length ? `, ${skipped.length} skipped (no CDN)` : ''),
    );

    if (failed.length > 0) {
      console.error(`\n${failed.length} page(s) FAILED:`);
      for (const f of failed) console.error(`  ${f.path}: ${f.problems.join('; ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('Page check passed.');
  } finally {
    cdp?.close();
    browser?.kill();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('Page check failed to run:', err);
    process.exit(1);
  });
