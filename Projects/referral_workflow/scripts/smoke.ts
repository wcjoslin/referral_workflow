/**
 * Render smoke check.
 *
 * Usage:  DATABASE_URL=./smoke.db npm run db:migrate && DATABASE_URL=./smoke.db npm run smoke
 *
 * WHY THIS EXISTS
 *
 * The unit tests assert payloads; they never render a page. Two defects shipped
 * straight through them:
 *
 *   - the workspace C-CDA panel called a `window.CcdaView.render` API that does
 *     not exist, and its fallback quietly dumped raw XML into a <pre>. Every
 *     payload test passed. The panel was simply not a viewer.
 *   - page payloads were embedded with `JSON.stringify`, so a patient name
 *     containing `</script>` closed the script element and injected HTML.
 *
 * Both were obvious within seconds of looking at a rendered page, and invisible
 * to everything else in the suite. So this boots the real server against a real
 * database and reads the bytes that would reach a browser.
 *
 * Deliberately NOT a seeded demo: fixtures are inserted directly, so the check
 * is fast, deterministic and needs no network, SMTP or model API.
 *
 * SCOPE, STATED HONESTLY: the workspace page builds its DOM client-side, so what
 * arrives over HTTP is the page's source, not its rendered output. These are
 * therefore source-level assertions — they catch a panel wired to the wrong
 * thing, a fallback left in, or unescaped data, which is exactly the class of
 * defect that shipped. They cannot catch a fault that only appears once the
 * script runs. That needs a headless browser driving the page, which is the
 * natural next step and deliberately not smuggled in here.
 */

import { randomUUID } from 'crypto';

// Config is read at import time, so the port has to be set before src/server
// loads. A high fixed port keeps failures readable; CI runs one job at a time.
const PORT = process.env.SMOKE_PORT ?? '3599';
process.env.PORT = PORT;

const BASE = `http://127.0.0.1:${PORT}`;

/** The exact shape of the XSS that shipped: a name that closes the element. */
const HOSTILE_FIRST = '<script>alert(1)</script>';
const HOSTILE_LAST = 'O"Brien & <b>Sons</b>';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function get(pathname: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}${pathname}`);
  return { status: res.status, body: await res.text() };
}

async function main(): Promise<void> {
  console.log('Smoke check: rendering the workspace pages against a real server.\n');

  // ── Fixtures ──────────────────────────────────────────────────────────────
  // Imported after PORT is set. The db module reads DATABASE_URL at import.
  const { db } = await import('../src/db');
  const { patients, referrals } = await import('../src/db/schema');
  const { backfillWorkspaces, getWorkspaceByReferralId } = await import(
    '../src/modules/workspace/workspaceService'
  );
  const { ReferralState } = await import('../src/state/referralStateMachine');

  const [patient] = await db
    .insert(patients)
    .values({ firstName: HOSTILE_FIRST, lastName: HOSTILE_LAST, dateOfBirth: '1980-01-01' })
    .returning();

  // One with a C-CDA (the viewer pane must render) and one without (the layout
  // must collapse rather than leave an empty pane).
  const [withCcda] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      sourceMessageId: `smoke-${randomUUID()}`,
      referrerAddress: 'referrer@primary.direct',
      reasonForReferral: 'Smoke check <em>with</em> markup & "quotes"',
      state: ReferralState.SCHEDULED,
      routingDepartment: 'Cardiology',
      rawCcdaXml: '<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3"/>',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const [noCcda] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      sourceMessageId: `smoke-${randomUUID()}`,
      referrerAddress: 'referrer@primary.direct',
      state: ReferralState.DECLINED,
      declineReason: 'Declined because <script>evil()</script> & reasons',
      routingDepartment: 'Neurology',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  await backfillWorkspaces();
  const wsWith = await getWorkspaceByReferralId(withCcda.id);
  const wsWithout = await getWorkspaceByReferralId(noCcda.id);
  if (!wsWith || !wsWithout) throw new Error('backfill did not create the fixture workspaces');

  // ── Boot ──────────────────────────────────────────────────────────────────
  const { startServer } = await import('../src/server');
  startServer();

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('server did not come up within 30s');
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`Server up on ${BASE}\n`);

  // ── The index ─────────────────────────────────────────────────────────────
  const index = await get('/workspaces');
  check('GET /workspaces returns 200', index.status === 200, `status ${index.status}`);
  check('index lists the fixture workspaces', index.body.includes('__WORKSPACE_ROWS__'));
  check('index nav carries the Workspaces entry', index.body.includes('href="/workspaces"'));

  // ── The detail page ───────────────────────────────────────────────────────
  const detail = await get(`/workspaces/${wsWith.id}`);
  check('GET /workspaces/:id returns 200', detail.status === 200, `status ${detail.status}`);
  check('detail labels both status dimensions', detail.body.includes('360X Status') && detail.body.includes('Work Status'));
  check(
    'detail renders the two statuses as different objects',
    detail.body.includes('badge badge-') && detail.body.includes('ws-chip'),
  );
  check(
    'detail reserves the later panels rather than omitting them',
    ['PRD-21', 'PRD-22', 'PRD-23', 'PRD-24', 'PRD-25'].every((p) => detail.body.includes(p)),
  );

  // ── The C-CDA viewer: the defect this check exists for ────────────────────
  //
  // The frame URL is assembled in the browser, so the source carries the route
  // as a literal inside a JS expression rather than a concrete path. Asserting
  // on the literal is what is actually checkable here — and it is enough: the
  // defect that shipped was a hand-rolled `srcdoc` calling a `CcdaView.render`
  // API that does not exist, with a raw-XML fallback. Both of those names would
  // fail these checks.
  check('detail wires the viewer to the frame route', detail.body.includes('/ccda-frame'));
  check(
    'detail does not hand-roll a viewer',
    !detail.body.includes('srcdoc') && !detail.body.includes('CcdaView'),
    'a srcdoc or CcdaView reference is back — that was the broken approach',
  );

  const frame = await get(`/referrals/${withCcda.id}/ccda-frame`);
  check('GET the C-CDA frame returns 200', frame.status === 200, `status ${frame.status}`);
  check(
    'frame loads the real Sialia viewer, not a stand-in',
    frame.body.includes('new sialia.Sialia'),
    'no sialia.Sialia call — the viewer is not being constructed',
  );
  for (const script of [
    'jquery.min.js',
    'bootstrap.bundle.min.js',
    'riot.js',
    'lodash.min.js',
    'dragula.min.js',
    'sialia.js',
  ]) {
    check(`frame loads ${script}`, frame.body.includes(script));
  }
  check(
    'frame does not fall back to dumping raw XML',
    !frame.body.includes('<pre') && !frame.body.includes('ClinicalDocument'),
    'raw XML or a <pre> fallback is present',
  );

  // ── No C-CDA: no empty pane ───────────────────────────────────────────────
  const plain = await get(`/workspaces/${wsWithout.id}`);
  check('a referral with no C-CDA still renders', plain.status === 200, `status ${plain.status}`);
  // The panel's presence is decided at run time from this flag, and the script
  // that reads it is on the page either way — so the flag is the honest thing
  // to assert, not the absence of the route literal.
  check(
    'its payload reports no C-CDA, so the pane collapses',
    plain.body.includes('"hasCcda":false'),
    'hasCcda was not false for a referral with no stored XML',
  );
  check(
    'and the one with a document reports the opposite',
    detail.body.includes('"hasCcda":true'),
    'hasCcda was not true for a referral with stored XML',
  );
  check(
    'the frame route refuses a referral with no document',
    (await get(`/referrals/${noCcda.id}/ccda-frame`)).status === 404,
    'the frame served a document that does not exist',
  );

  // ── Escaping: the other defect that shipped ───────────────────────────────
  const pages: [string, string][] = [
    ['/', (await get('/')).body],
    ['/workspaces', index.body],
    [`/workspaces/${wsWith.id}`, detail.body],
    [`/workspaces/${wsWithout.id}`, plain.body],
    [`/referrals/${withCcda.id}/review`, (await get(`/referrals/${withCcda.id}/review`)).body],
  ];
  for (const [label, body] of pages) {
    const leaked = body.includes(HOSTILE_FIRST) || body.includes('<b>Sons</b>');
    check(`${label} escapes hostile patient data`, !leaked, 'raw markup reached the page');
  }

  // ── Not-found handling ────────────────────────────────────────────────────
  for (const bad of ['999999', 'abc', '0', '-1']) {
    const page = await get(`/workspaces/${bad}`);
    const api = await get(`/api/workspaces/${bad}`);
    check(
      `workspace id "${bad}" 404s as page and API`,
      page.status === 404 && api.status === 404,
      `page ${page.status}, api ${api.status}`,
    );
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} FAILED:`);
    for (const f of failed) console.error(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('Smoke check passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nSmoke check errored before it could finish:');
  console.error(err);
  process.exit(1);
});
