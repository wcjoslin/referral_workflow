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

async function get(pathname: string, actingUserId?: number): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: actingUserId === undefined ? {} : { cookie: `actingUserId=${actingUserId}` },
  });
  return { status: res.status, body: await res.text() };
}

async function post(
  pathname: string,
  body: unknown,
  actingUserId?: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(actingUserId === undefined ? {} : { cookie: `actingUserId=${actingUserId}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { _unparseable: text.slice(0, 200) };
  }
  return { status: res.status, json: parsed };
}

/**
 * How many workspaces the index would list. The rows are embedded as JSON and
 * rendered client-side, so counting the one key that only appears in that array
 * is the honest way to assert a server-side filter from the page source.
 */
function rowCount(body: string): number {
  return body.split('"workspaceId":').length - 1;
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

  // PRD-21 needs real people to own things. Two are enough: `me` is the default
  // acting user (first active id, which is what an absent cookie resolves to)
  // and `other` is somebody else, so "mine" can be shown to be per-user rather
  // than just non-empty.
  const { seedUsers } = await import('../src/modules/workspace/userRoster');
  const { listUsers } = await import('../src/modules/workspace/identityService');
  await seedUsers();
  const roster = await listUsers();
  if (roster.length < 2) throw new Error('seedUsers did not produce a usable roster');
  const me = roster[0];
  const other = roster[1];

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
    'detail reserves the still-unbuilt panels rather than omitting them',
    ['PRD-22', 'PRD-23', 'PRD-24', 'PRD-25'].every((p) => detail.body.includes(p)),
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

  // ── Ownership (PRD-21) ────────────────────────────────────────────────────
  //
  // This section MUTATES the fixtures, in this order, and the row counts below
  // depend on the end state: wsWith ends up owned by `other`, wsWithout stays
  // unassigned. Any check inserted here has to keep that true.
  check(
    'the owner slot is live, not a PRD-21 placeholder',
    detail.body.includes('"owner":true'),
    'slots.owner was not true — the page would render the coming-soon card',
  );
  check(
    'the owner panel posts to the ownership endpoint',
    detail.body.includes('/owner') && detail.body.includes('renderOwner'),
  );

  // The body is a three-way discrimination because the PRD's first draft encoded
  // release as `ownerUserId: null`, which made a request that forgot its payload
  // silently unassign the workspace. These two checks are that defect's guard.
  const emptyBody = await post(`/api/workspaces/${wsWith.id}/owner`, {});
  check(
    'an empty owner body is refused rather than read as a release',
    emptyBody.status === 400,
    `status ${emptyBody.status}`,
  );
  const twoIntents = await post(`/api/workspaces/${wsWith.id}/owner`, { self: true, release: true });
  check('two intents at once are refused', twoIntents.status === 400, `status ${twoIntents.status}`);
  const unknownOwner = await post(`/api/workspaces/${wsWith.id}/owner`, { ownerUserId: 999999 });
  check('an unknown assignee is refused', unknownOwner.status === 400, `status ${unknownOwner.status}`);

  const claimed = await post(`/api/workspaces/${wsWith.id}/owner`, { self: true });
  check(
    'a claim assigns the acting user',
    claimed.status === 200 && claimed.json.ownerUserId === me.id,
    `status ${claimed.status}, owner ${String(claimed.json.ownerUserId)}`,
  );
  const stolen = await post(`/api/workspaces/${wsWith.id}/owner`, { self: true }, other.id);
  check(
    'a second claim 409s instead of stealing, and names the holder',
    stolen.status === 409 && stolen.json.currentOwnerUserId === me.id,
    `status ${stolen.status}, holder ${String(stolen.json.currentOwnerUserId)}`,
  );

  // wsWith is Waiting-External (backfilled from Scheduled), so it is past Triage
  // and releasing it is a decision that needs explaining.
  const bareRelease = await post(`/api/workspaces/${wsWith.id}/owner`, { release: true });
  check(
    'release without a reason is refused once work has started',
    bareRelease.status === 422,
    `status ${bareRelease.status}`,
  );
  const released = await post(`/api/workspaces/${wsWith.id}/owner`, {
    release: true,
    reason: 'Handing off <b>before</b> leave',
  });
  check(
    'release with a reason clears the owner',
    released.status === 200 && released.json.ownerUserId === null,
    `status ${released.status}, owner ${String(released.json.ownerUserId)}`,
  );

  const assigned = await post(`/api/workspaces/${wsWith.id}/owner`, { ownerUserId: other.id });
  check(
    'assignment hands it to somebody else',
    assigned.status === 200 && assigned.json.ownerUserId === other.id,
    `status ${assigned.status}, owner ${String(assigned.json.ownerUserId)}`,
  );
  const reDetail = await get(`/workspaces/${wsWith.id}`);
  check(
    'the detail payload then names the new owner',
    reDetail.body.includes(`"ownerUserId":${other.id}`) && reDetail.body.includes('"ownerInactive":false'),
    'the page would render Unassigned for a workspace that has an owner',
  );

  // ── My work ───────────────────────────────────────────────────────────────
  const mineApi = await get('/api/my-work', other.id);
  check('GET /api/my-work returns 200', mineApi.status === 200, `status ${mineApi.status}`);
  check(
    'my-work lists what the acting user owns',
    mineApi.body.includes(`"workspaceId":${wsWith.id}`),
    'the owned workspace is missing from my-work',
  );
  const spoofed = await get(`/api/my-work?userId=${other.id}`, me.id);
  check(
    'my-work takes no user id from the caller',
    !spoofed.body.includes(`"workspaceId":${wsWith.id}`),
    'a query parameter changed whose work was returned',
  );

  // ── Index owner filters, resolved server-side ─────────────────────────────
  const allRows = await get('/workspaces');
  const unassignedRows = await get('/workspaces?owner=unassigned');
  const otherMine = await get('/workspaces?owner=me', other.id);
  const myMine = await get('/workspaces?owner=me', me.id);
  check('the unfiltered index lists both workspaces', rowCount(allRows.body) === 2, `${rowCount(allRows.body)} rows`);
  check(
    '?owner=unassigned lists only the one with no owner',
    rowCount(unassignedRows.body) === 1 && unassignedRows.body.includes(`"workspaceId":${wsWithout.id}`),
    `${rowCount(unassignedRows.body)} rows`,
  );
  check(
    '?owner=me lists the owner\'s own work',
    rowCount(otherMine.body) === 1 && otherMine.body.includes(`"workspaceId":${wsWith.id}`),
    `${rowCount(otherMine.body)} rows`,
  );
  check(
    'and shows somebody else nothing — the filter is per-user, not just non-empty',
    rowCount(myMine.body) === 0,
    `${rowCount(myMine.body)} rows for a user who owns nothing`,
  );
  check(
    'the index reports which filter is active',
    unassignedRows.body.includes('"ownerFilter":"unassigned"') &&
      otherMine.body.includes('"ownerFilter":"me"') &&
      allRows.body.includes('"ownerFilter":"any"'),
  );
  check(
    'the index offers all three filters as links',
    ['href="/workspaces"', "'/workspaces?owner=me'", "'/workspaces?owner=unassigned'"].every((l) =>
      allRows.body.includes(l),
    ),
  );

  // ── The dashboard carries the owner too ───────────────────────────────────
  const dashboard = await get('/');
  check('the dashboard shows an Owner column', dashboard.body.includes('<th>Owner</th>'));
  check('the dashboard offers an owner filter', dashboard.body.includes('ownerFilter'));
  check(
    'the dashboard payload carries the owner it renders',
    dashboard.body.includes(`"ownerUserId":${other.id}`),
    'the Owner column would be empty for a workspace that has an owner',
  );

  // ── Escaping: the other defect that shipped ───────────────────────────────
  const pages: [string, string][] = [
    ['/', dashboard.body],
    ['/workspaces', index.body],
    ['/workspaces?owner=unassigned', unassignedRows.body],
    ['/workspaces?owner=me', otherMine.body],
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
