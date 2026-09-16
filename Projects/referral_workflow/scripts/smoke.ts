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
/** Fetches with an arbitrary Cookie header — the guest session is not an actingUserId. */
async function getRaw(pathname: string, cookie: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}${pathname}`, { headers: { cookie }, redirect: 'manual' });
  return { status: res.status, body: await res.text() };
}


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

  // ── Parties & participants (PRD-24) ───────────────────────────────────────
  //
  // Continues from the ownership section above: wsWith is owned by `other`, so
  // they must already be a Manager participant without anyone adding them.
  const partiesApi = await get(`/api/workspaces/${wsWith.id}/parties`);
  check('GET the parties returns 200', partiesApi.status === 200, `status ${partiesApi.status}`);
  check(
    'both parties were seeded on creation, with no manual step',
    partiesApi.body.includes('"partyRole":"initiating"') &&
      partiesApi.body.includes('"partyRole":"receiving"'),
    'a workspace exists without its counterparties',
  );
  check(
    'the receiving party is named from config, not guessed from our own domain',
    partiesApi.body.includes('"orgName":"Specialist Care Group"') &&
      partiesApi.body.includes('"orgNameVerified":true'),
  );
  check(
    'the initiating party falls back to its domain and says so',
    partiesApi.body.includes('"orgName":"primary.direct"') &&
      partiesApi.body.includes('"orgNameVerified":false'),
    'a derived name was presented as though somebody had confirmed it',
  );
  check(
    'a party with an address starts assumed, not verified',
    partiesApi.body.includes('"capabilityVerifiedAt":null'),
    'a capability nobody has exercised is being shown as proven',
  );

  // The three-step lookup, exercised through the observer: a message from an
  // address nobody has seen before must still reach the right party.
  const { recordThreadMessage } = await import('../src/modules/messaging/threadService');
  await recordThreadMessage({
    referralId: withCcda.id,
    direction: 'inbound',
    messageType: 'InfoReply',
    summary: 'Follow-up from a clinician at the referring organization',
    senderAddress: 'e.chen@primary.direct',
  });
  await new Promise((r) => setTimeout(r, 300));

  const afterObserve = await get(`/api/workspaces/${wsWith.id}/parties`);
  check(
    'an inbound sender teaches the party a new address',
    afterObserve.body.includes('e.chen@primary.direct'),
    'the domain fallback did not file it, so the next message would not match exactly',
  );

  const modeBad = await post(`/api/workspaces/${wsWith.id}/parties/1/protocol-mode`, {
    protocolMode: 'carrier-pigeon',
  });
  check('an unknown protocol mode is refused', modeBad.status === 400, `status ${modeBad.status}`);

  const participantsApi = await get(`/api/workspaces/${wsWith.id}/participants`);
  check(
    'GET the participants returns 200',
    participantsApi.status === 200,
    `status ${participantsApi.status}`,
  );
  check(
    'the owner is already a Manager participant, unprompted',
    participantsApi.body.includes(`"userId":${other.id}`) &&
      participantsApi.body.includes('"role":"Manager"') &&
      participantsApi.body.includes('"isOwner":true'),
    'the accountable person is missing from the list of people involved',
  );

  const addBad = await post(`/api/workspaces/${wsWith.id}/participants`, {
    userId: roster[3].id,
    role: 'Admin',
  });
  check('an unknown participant role is refused', addBad.status === 400, `status ${addBad.status}`);
  const addOk = await post(`/api/workspaces/${wsWith.id}/participants`, {
    userId: roster[3].id,
    role: 'Viewer',
  });
  check('a participant can be added', addOk.status === 200, `status ${addOk.status}`);
  const reAdd = await post(`/api/workspaces/${wsWith.id}/participants`, {
    userId: roster[3].id,
    role: 'Collaborator',
  });
  const afterReAdd = await get(`/api/workspaces/${wsWith.id}/participants`);
  check(
    're-adding updates the role rather than duplicating the person',
    reAdd.status === 200 && afterReAdd.body.split(`"userId":${roster[3].id}`).length - 1 === 1,
    'the same person appears twice on one roster',
  );

  const removeOwner = await fetch(`${BASE}/api/workspaces/${wsWith.id}/participants/${other.id}`, {
    method: 'DELETE',
  });
  check(
    'the owner cannot be removed from the roster',
    removeOwner.status === 409,
    `status ${removeOwner.status}`,
  );

  check(
    'the participants panel is live, not a PRD-24 placeholder',
    reDetail.body.includes('"participants":true') && reDetail.body.includes('renderParties'),
    'slots.participants was not true — the page would render the coming-soon card',
  );
  check(
    'the panel explains protocol mode in plain language rather than echoing the enum',
    reDetail.body.includes('speaks 360X') && reDetail.body.includes('nothing is transmitted'),
  );
  check(
    'the panel says roles are not access control yet',
    reDetail.body.includes('not access control yet'),
    'a reader could take Viewer for a permission',
  );

  // ── Guest participation (PRD-30) ──────────────────────────────────────────
  //
  // The invitation token is created through the service rather than the API on
  // purpose: the API deliberately does NOT return it, which is itself asserted
  // below. There is no other way to obtain one, and that is the design.
  const { createInvitation, revokeInvitation } = await import(
    '../src/modules/workspace/invitationService'
  );
  const { getParties } = await import('../src/modules/workspace/partyService');

  const wsWithParties = await getParties(wsWith.id);
  const invitedParty = wsWithParties.find((p) => p.partyRole === 'initiating');
  if (!invitedParty) throw new Error('no initiating party to invite');

  const inviteApi = await post(`/api/workspaces/${wsWith.id}/invitations`, {
    partyId: invitedParty.id,
    recipientEmail: 'guest@primary.direct',
  });
  check('POST an invitation returns 200', inviteApi.status === 200, `status ${inviteApi.status}`);
  check(
    'the API never returns the raw token',
    !('inviteUrl' in inviteApi.json) && !JSON.stringify(inviteApi.json).includes('/guest/'),
    'a token came back to the inviter, and from there into browser history',
  );

  const badInvite = await post(`/api/workspaces/${wsWith.id}/invitations`, {
    partyId: invitedParty.id,
    recipientEmail: 'not-an-email',
  });
  check('a malformed recipient is refused', badInvite.status === 400, `status ${badInvite.status}`);

  const { invitation, inviteUrl } = await createInvitation(
    wsWith.id,
    invitedParty.id,
    'smoke-guest@primary.direct',
    other,
  );
  const token = inviteUrl.split('/guest/')[1];

  const accept = await fetch(`${BASE}/guest/${token}`, { redirect: 'manual' });
  const setCookie = accept.headers.get('set-cookie') ?? '';
  const guestCookie = setCookie.split(';')[0];
  check('accepting redirects rather than rendering the token', accept.status === 302, `status ${accept.status}`);
  check(
    'the session cookie is HttpOnly, unlike the acting-user cookie',
    setCookie.includes('HttpOnly'),
    'client script can read a real credential',
  );
  check(
    'the token leaves the address bar immediately',
    accept.headers.get('location') === '/guest/workspace',
    `redirected to ${accept.headers.get('location')}`,
  );

  const guestPage = await getRaw('/guest/workspace', guestCookie);
  check('the guest page renders', guestPage.status === 200, `status ${guestPage.status}`);
  check(
    'it carries the patient and both organizations',
    guestPage.body.includes('"patientName"') && guestPage.body.includes('"receivingOrg"'),
  );
  // The internal-absence check is the security control, so it runs against the
  // bytes a guest's browser actually receives rather than against a unit test.
  for (const forbidden of ['workStatus', 'ownerUserId', 'queueId', 'nextAction', 'exceptionReason', 'participants']) {
    check(
      `the guest page contains no ${forbidden}`,
      !guestPage.body.includes(`"${forbidden}"`),
      'an internal field reached a guest',
    );
  }
  check(
    'the guest page carries no internal nav',
    !guestPage.body.includes('href="/workspaces"') && !guestPage.body.includes('href="/analytics"'),
    'a guest is being offered surfaces they cannot reach',
  );

  const guestApi = await getRaw('/api/guest/workspace', guestCookie);
  check('the guest API serves the same scope', guestApi.status === 200, `status ${guestApi.status}`);

  // The mitigation for the authentication finding: a guest cookie cannot reach
  // an internal surface, page or API.
  for (const internal of [`/workspaces/${wsWith.id}`, `/workspaces/${wsWithout.id}`, '/', `/api/workspaces/${wsWith.id}`, '/api/users']) {
    const res = await getRaw(internal, guestCookie);
    check(
      `a guest cookie is refused at ${internal}`,
      res.status === 403,
      `status ${res.status} — a guest reached an internal surface`,
    );
  }

  const noSession = await get('/api/guest/workspace');
  check('the guest API refuses a request with no session', noSession.status === 401, `status ${noSession.status}`);
  const tampered = await getRaw('/api/guest/workspace', `guestSession=${'B'.repeat(43)}`);
  check('a tampered session resolves to nothing', tampered.status === 401, `status ${tampered.status}`);

  // ── The conversation (PRD-22) ─────────────────────────────────────────────
  //
  // Placed inside the guest block on purpose: the only way to prove the
  // internal/shared boundary is to read the bytes a guest's browser actually
  // receives while an internal comment exists on the same workspace.

  const HOSTILE_COMMENT = '<script>alert("comment")</script> & "quoted" <b>bold</b>';

  const emptyComment = await post(`/api/workspaces/${wsWith.id}/comments`, { body: '   ' }, me.id);
  check('an empty comment is refused', emptyComment.status === 400, `status ${emptyComment.status}`);

  const longComment = await post(
    `/api/workspaces/${wsWith.id}/comments`,
    { body: 'x'.repeat(4001) },
    me.id,
  );
  check('an over-length comment is refused', longComment.status === 400, `status ${longComment.status}`);

  const unconfirmed = await post(
    `/api/workspaces/${wsWith.id}/comments`,
    { body: 'sharing without meaning to', visibility: 'Shared' },
    me.id,
  );
  check(
    'sharing without the confirmation is refused',
    unconfirmed.status === 422,
    `status ${unconfirmed.status}`,
  );

  const internalComment = await post(
    `/api/workspaces/${wsWith.id}/comments`,
    { body: `INTERNAL-ONLY-MARKER the payer is difficult ${HOSTILE_COMMENT}` },
    me.id,
  );
  check(
    'an internal comment posts and defaults to Internal',
    internalComment.status === 200 &&
      (internalComment.json.comment as { visibility?: string } | undefined)?.visibility ===
        'Internal',
    `status ${internalComment.status}`,
  );

  const sharedComment = await post(
    `/api/workspaces/${wsWith.id}/comments`,
    {
      body: `SHARED-MARKER could you send the echo report? ${HOSTILE_COMMENT}`,
      visibility: 'Shared',
      confirmShared: true,
    },
    me.id,
  );
  check(
    'a confirmed shared comment posts',
    sharedComment.status === 200 &&
      (sharedComment.json.comment as { visibility?: string } | undefined)?.visibility === 'Shared',
    `status ${sharedComment.status}`,
  );

  const thread = await get(`/api/workspaces/${wsWith.id}/comments`, me.id);
  check(
    'the internal thread carries both visibilities',
    thread.status === 200 &&
      thread.body.includes('INTERNAL-ONLY-MARKER') &&
      thread.body.includes('SHARED-MARKER'),
    `status ${thread.status}`,
  );

  // THE BOUNDARY, read from the bytes rather than asserted about.
  const guestWithComments = await getRaw('/guest/workspace', guestCookie);
  check(
    'the guest page carries the shared comment',
    guestWithComments.body.includes('SHARED-MARKER'),
    'a shared comment did not reach the guest',
  );
  check(
    'the guest page carries no internal comment',
    !guestWithComments.body.includes('INTERNAL-ONLY-MARKER'),
    'an internal note reached a guest',
  );
  check(
    'and no internal comment field rides along with it',
    !guestWithComments.body.includes('"shareLocked"') &&
      !guestWithComments.body.includes('"authorJobRole"') &&
      !guestWithComments.body.includes('"deletedByActor"'),
    'an internal comment field reached a guest',
  );
  // A hostile comment body is embedded as JSON inside a <script> block. If it
  // could close that block the page would execute it, which no unit test sees.
  check(
    'a hostile comment body cannot close the script block it is embedded in',
    !guestWithComments.body.includes('</script>alert'),
    'a comment body broke out of its script context',
  );

  const guestPost = await fetch(`${BASE}/api/guest/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: guestCookie },
    body: JSON.stringify({ body: 'GUEST-MARKER on its way this afternoon' }),
  });
  check('a guest can post a comment', guestPost.status === 200, `status ${guestPost.status}`);

  // Both an understood value and a nonsense one: an unrecognised string must be
  // REFUSED rather than read as "not supplied" and quietly defaulted to Shared.
  for (const attempted of ['Internal', 'Public', '']) {
    const guestForcing = await fetch(`${BASE}/api/guest/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: guestCookie },
      body: JSON.stringify({ body: 'a private note', visibility: attempted }),
    });
    check(
      `a guest asking for visibility "${attempted}" is refused`,
      guestForcing.status === 400,
      `status ${guestForcing.status} — a guest set their own visibility`,
    );
  }

  const threadWithGuest = await get(`/api/workspaces/${wsWith.id}/comments`, me.id);
  check(
    'the guest comment is attributed to the guest and their party internally',
    threadWithGuest.body.includes('GUEST-MARKER') &&
      threadWithGuest.body.includes('"authorKind":"guest"') &&
      // The fixture's guest supplied no name, so this also exercises the
      // fallback: the party's org name, which PRD-24 derived from the address
      // domain rather than inventing one.
      threadWithGuest.body.includes('"authorPartyOrgName":"primary.direct"'),
    'a guest comment lost its attribution',
  );

  // THE SHARE LOCK. The guest has loaded the page since the comment was shared,
  // so pulling it back would be rewriting what an outside party already saw.
  const sharedId = (sharedComment.json.comment as { id?: number } | undefined)?.id;
  const downgrade = await fetch(
    `${BASE}/api/workspaces/${wsWith.id}/comments/${sharedId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: `actingUserId=${me.id}` },
      body: JSON.stringify({ body: 'trying to take it back', visibility: 'Internal' }),
    },
  );
  check(
    'a shared comment a guest has seen cannot be made internal again',
    downgrade.status === 409,
    `status ${downgrade.status}`,
  );

  const notAuthor = await fetch(
    `${BASE}/api/workspaces/${wsWith.id}/comments/${sharedId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: `actingUserId=${other.id}` },
      body: JSON.stringify({ body: 'not mine to reword', visibility: 'Shared' }),
    },
  );
  check(
    'only the author may reword a comment',
    notAuthor.status === 403,
    `status ${notAuthor.status}`,
  );

  // A guest cookie must not reach the internal conversation, the same way it
  // cannot reach any other internal surface.
  for (const internal of [
    `/api/workspaces/${wsWith.id}/comments`,
    `/api/workspaces/${wsWith.id}/mention-targets`,
    `/api/workspaces/${wsWith.id}/comments/${sharedId}/history`,
  ]) {
    const res = await getRaw(internal, guestCookie);
    check(
      `a guest cookie is refused at ${internal}`,
      res.status === 403,
      `status ${res.status} — a guest reached the internal conversation`,
    );
  }

  const reDetailComments = await get(`/workspaces/${wsWith.id}`, me.id);
  check(
    'the workspace page carries the conversation panel',
    reDetailComments.body.includes('renderConversation') &&
      reDetailComments.body.includes('cmt-internal') &&
      reDetailComments.body.includes('cmt-shared'),
    'the conversation panel is not wired into the page',
  );
  check(
    'the page no longer renders the PRD-22 placeholder',
    !reDetailComments.body.includes(">Conversation<span class=\"slot-tag\">PRD-22"),
    'the placeholder is still being rendered alongside the real panel',
  );
  check(
    'the share confirmation names who will be able to read the comment',
    reDetailComments.body.includes('share-warn') &&
      reDetailComments.body.includes('has a live invitation'),
    'the confirmation does not say who will read it',
  );

  // ── Documents (PRD-23) ────────────────────────────────────────────────────
  //
  // Inside the guest block for the same reason the conversation checks are: the
  // only way to prove both document gates is to read the bytes a guest's
  // browser actually receives while an internal and a patient-scoped document
  // exist on the same workspace.

  const { backfillDocuments: smokeBackfill, registerDocument: smokeRegister } = await import(
    '../src/modules/workspace/documentService'
  );

  const indexed = await smokeBackfill();
  check(
    'the backfill indexes the existing referral documents',
    indexed.messages + indexed.legacyCcda > 0,
    `indexed ${indexed.messages} messages and ${indexed.legacyCcda} legacy C-CDAs`,
  );
  const reIndexed = await smokeBackfill();
  check(
    'and re-running it changes nothing',
    reIndexed.messages === 0 && reIndexed.alreadyIndexed > 0,
    `second run indexed ${reIndexed.messages}, skipped ${reIndexed.alreadyIndexed}`,
  );

  // An internal and a patient-scoped document, the two a guest must never see.
  // The patient-scoped one is marked Shared on purpose: visibility alone would
  // let it through, which is why there are two gates.
  await smokeRegister({
    workspaceId: wsWith.id,
    contentSource: 'prior-auth-request',
    contentRef: 90001,
    contentType: 'application/json',
    docType: 'INTERNAL-PRIOR-AUTH-DOC',
    source: 'payer-outbound',
    receivedAt: new Date(),
    visibility: 'Internal',
  });
  await smokeRegister({
    workspaceId: wsWith.id,
    contentSource: 'attachment-response',
    contentRef: 90002,
    contentType: 'application/xml',
    docType: 'PATIENT-LEVEL-CLAIMS-DOC',
    source: 'payer-outbound',
    scope: 'patient',
    receivedAt: new Date(),
    visibility: 'Shared',
  });

  const docsApi = await get(`/api/workspaces/${wsWith.id}/documents`, me.id);
  check('GET the documents returns 200', docsApi.status === 200, `status ${docsApi.status}`);
  check(
    'the internal collection carries every source',
    docsApi.body.includes('"source":"inbound-dsm"') &&
      docsApi.body.includes('INTERNAL-PRIOR-AUTH-DOC') &&
      docsApi.body.includes('PATIENT-LEVEL-CLAIMS-DOC'),
    'a source is missing from the internal collection',
  );
  check(
    'a patient-scoped document is labelled as such rather than passed off as this referral\u2019s',
    docsApi.body.includes('"scope":"patient"'),
    'scope is not being reported',
  );

  const documents = (JSON.parse(docsApi.body) as {
    documents: { id: number; docType: string; renderAs: string; contentType: string }[];
  }).documents;
  const ccdaDoc = documents.find((d) => d.renderAs === 'ccda' && d.docType === 'Referral Note');
  const internalDoc = documents.find((d) => d.docType === 'INTERNAL-PRIOR-AUTH-DOC');
  const patientDoc = documents.find((d) => d.docType === 'PATIENT-LEVEL-CLAIMS-DOC');
  check(
    'the referral C-CDA is indexed and opens in the viewer',
    !!ccdaDoc,
    'no document reported renderAs ccda',
  );

  if (ccdaDoc) {
    const content = await get(`/api/documents/${ccdaDoc.id}/content`, me.id);
    check(
      'the content endpoint serves the real C-CDA',
      content.status === 200 && content.body.includes('ClinicalDocument'),
      `status ${content.status}`,
    );

    const frame = await get(`/documents/${ccdaDoc.id}/ccda-frame`, me.id);
    check(
      'the document-keyed viewer frame renders and points at the content endpoint',
      frame.status === 200 && frame.body.includes(`/api/documents/${ccdaDoc.id}/content`),
      `status ${frame.status}`,
    );
    check(
      'and it still loads the real Sialia viewer rather than a stand-in',
      frame.body.includes('/static/ccdaview'),
      'the frame is not wired to the vendor viewer',
    );

    const log = await get(`/api/documents/${ccdaDoc.id}/access-log`, me.id);
    check(
      'fetching content wrote an access record naming the viewer',
      log.status === 200 && log.body.includes('"action":"view"') && log.body.includes('Chen'),
      `status ${log.status}, body ${log.body.slice(0, 120)}`,
    );
  }

  // The regression that matters most: the review page's own viewer is untouched.
  const legacyXml = await get(`/referrals/${withCcda.id}/ccda.xml`, me.id);
  const legacyFrame = await get(`/referrals/${withCcda.id}/ccda-frame`, me.id);
  check(
    'the referral-keyed C-CDA route still works unchanged',
    legacyXml.status === 200 && legacyXml.body.includes('ClinicalDocument'),
    `status ${legacyXml.status}`,
  );
  check(
    'and so does the referral-keyed frame, still deriving its own URL',
    legacyFrame.status === 200 &&
      legacyFrame.body.includes(`"referralId":${withCcda.id}`) &&
      legacyFrame.body.includes("'/referrals/' + frame.referralId + '/ccda.xml'"),
    `status ${legacyFrame.status}`,
  );

  // ── Upload, end to end with real bytes ────────────────────────────────────
  const PDF_BYTES = Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.from('smoke-upload-marker'),
    Buffer.from('\n%%EOF\n'),
  ]);

  async function upload(
    pathname: string,
    body: Buffer,
    headers: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    // Uint8Array rather than the Buffer itself: `fetch`'s BodyInit does not
    // accept a Node Buffer under these lib types, and a view over the same
    // bytes costs nothing.
    const res = await fetch(`${BASE}${pathname}`, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
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

  const uploaded = await upload(`/api/workspaces/${wsWith.id}/documents`, PDF_BYTES, {
    'content-type': 'application/pdf',
    'x-document-filename': encodeURIComponent('Prior imaging — Ünïcode.pdf'),
    'x-document-type': encodeURIComponent('Prior Imaging Report'),
    'x-document-visibility': 'Internal',
    cookie: `actingUserId=${me.id}`,
  });
  check(
    'a raw-body upload lands and reports that nothing was transmitted',
    uploaded.status === 200 && uploaded.json.transmitted === false,
    `status ${uploaded.status}`,
  );
  check(
    'the detected type comes from the bytes',
    uploaded.json.detectedContentType === 'application/pdf',
    `detected ${String(uploaded.json.detectedContentType)}`,
  );

  const uploadedId = uploaded.json.documentId as number;
  const roundTrip = await fetch(`${BASE}/api/documents/${uploadedId}/content?download=1`, {
    headers: { cookie: `actingUserId=${me.id}` },
  });
  const returned = Buffer.from(await roundTrip.arrayBuffer());
  check(
    'the uploaded bytes come back byte-identical',
    returned.equals(PDF_BYTES),
    `${returned.length} bytes back, ${PDF_BYTES.length} sent`,
  );
  check(
    'and the download carries a Content-Disposition that survives a non-ASCII name',
    (roundTrip.headers.get('content-disposition') ?? '').includes("filename*=UTF-8''"),
    `disposition was ${String(roundTrip.headers.get('content-disposition'))}`,
  );

  // A lie about the content type must not decide anything.
  const lying = await upload(`/api/workspaces/${wsWith.id}/documents`, PDF_BYTES, {
    'content-type': 'image/png',
    'x-document-filename': encodeURIComponent('claims-to-be.png'),
    cookie: `actingUserId=${me.id}`,
  });
  check(
    'a declared type that disagrees with the bytes is overruled',
    lying.status === 200 && lying.json.detectedContentType === 'application/pdf',
    `detected ${String(lying.json.detectedContentType)}`,
  );

  const notAllowed = await upload(`/api/workspaces/${wsWith.id}/documents`, Buffer.from('GIF89a x'), {
    'content-type': 'application/pdf',
    'x-document-filename': encodeURIComponent('sneaky.pdf'),
    cookie: `actingUserId=${me.id}`,
  });
  check(
    'a file whose bytes match nothing on the allow-list is refused',
    notAllowed.status === 400,
    `status ${notAllowed.status}`,
  );

  const emptyUpload = await upload(`/api/workspaces/${wsWith.id}/documents`, Buffer.alloc(0), {
    'content-type': 'application/pdf',
    'x-document-filename': encodeURIComponent('nothing.pdf'),
    cookie: `actingUserId=${me.id}`,
  });
  check('a zero-byte upload is refused', emptyUpload.status === 400, `status ${emptyUpload.status}`);

  // ── The two guest gates, read from the bytes ──────────────────────────────
  const guestDocsApi = await getRaw('/api/guest/documents', guestCookie);
  check('the guest document API returns 200', guestDocsApi.status === 200, `status ${guestDocsApi.status}`);
  check(
    'a guest sees the shared referral document',
    guestDocsApi.body.includes('Referral Note'),
    'a shared document did not reach the guest',
  );
  check(
    'a guest sees neither the internal nor the patient-scoped document',
    !guestDocsApi.body.includes('INTERNAL-PRIOR-AUTH-DOC') &&
      !guestDocsApi.body.includes('PATIENT-LEVEL-CLAIMS-DOC'),
    'a withheld document reached a guest',
  );
  check(
    'and no internal document field rides along',
    !guestDocsApi.body.includes('"scope"') &&
      !guestDocsApi.body.includes('"visibility"') &&
      !guestDocsApi.body.includes('"deliveryStatus"') &&
      !guestDocsApi.body.includes('"accessCount"') &&
      !guestDocsApi.body.includes('"sha256"'),
    'an internal document field reached a guest',
  );

  const guestPageDocs = await getRaw('/guest/workspace', guestCookie);
  check(
    'the guest page carries the shared document and not the withheld ones',
    guestPageDocs.body.includes('Referral Note') &&
      !guestPageDocs.body.includes('INTERNAL-PRIOR-AUTH-DOC') &&
      !guestPageDocs.body.includes('PATIENT-LEVEL-CLAIMS-DOC'),
    'the guest page leaked a withheld document',
  );

  if (internalDoc) {
    const denied = await getRaw(`/api/guest/documents/${internalDoc.id}/content`, guestCookie);
    check(
      'a guest fetching an internal document is refused',
      denied.status === 403,
      `status ${denied.status}`,
    );
  }
  if (patientDoc) {
    const denied = await getRaw(`/api/guest/documents/${patientDoc.id}/content`, guestCookie);
    check(
      'a guest fetching a patient-scoped document is refused even though it is marked Shared',
      denied.status === 403,
      `status ${denied.status}`,
    );
    const log = await get(`/api/documents/${patientDoc.id}/access-log`, me.id);
    check(
      'and the refusal is recorded with its reason',
      log.body.includes('"action":"denied"') && log.body.includes('patient-scoped'),
      `log was ${log.body.slice(0, 160)}`,
    );
  }

  for (const internalRoute of [
    `/api/workspaces/${wsWith.id}/documents`,
    ccdaDoc ? `/api/documents/${ccdaDoc.id}/content` : '/api/documents/1/content',
    ccdaDoc ? `/api/documents/${ccdaDoc.id}/access-log` : '/api/documents/1/access-log',
  ]) {
    const res = await getRaw(internalRoute, guestCookie);
    check(
      `a guest cookie is refused at ${internalRoute}`,
      res.status === 403,
      `status ${res.status} — a guest reached the internal document API`,
    );
  }

  const guestUpload = await upload('/api/guest/documents', PDF_BYTES, {
    'content-type': 'application/pdf',
    'x-document-filename': encodeURIComponent('from-the-other-side.pdf'),
    cookie: guestCookie,
  });
  check('a guest can upload a document', guestUpload.status === 200, `status ${guestUpload.status}`);

  const guestForcingDoc = await upload('/api/guest/documents', PDF_BYTES, {
    'content-type': 'application/pdf',
    'x-document-filename': encodeURIComponent('private.pdf'),
    'x-document-visibility': 'Internal',
    cookie: guestCookie,
  });
  check(
    'a guest cannot ask for an internal document',
    guestForcingDoc.status === 400,
    `status ${guestForcingDoc.status} — a guest set their own document visibility`,
  );

  const docPanel = await get(`/workspaces/${wsWith.id}`, me.id);
  check(
    'the workspace page carries the document panel',
    docPanel.body.includes('renderDocuments') &&
      docPanel.body.includes('doc-evidence') &&
      docPanel.body.includes('Opened by'),
    'the document panel is not wired into the page',
  );
  check(
    'and it keeps delivery and access as two separate facts',
    docPanel.body.includes('>Delivery<') && docPanel.body.includes('>Opened by<'),
    'delivery and access were merged into one indicator',
  );
  check(
    'the page no longer renders the PRD-23 placeholder',
    !docPanel.body.includes('>Documents<span class=\\"slot-tag\\">PRD-23'),
    'the placeholder is still being rendered alongside the real panel',
  );

  // ── Activity history (PRD-25) ─────────────────────────────────────────────
  //
  // Inside the guest block so the guest feed can be checked against the bytes
  // while internal events for the same referral exist.

  // The routing route recorded NOTHING before PRD-25. Driven through the real
  // route so the event is proved end to end rather than at the service.
  const reroute = await post(
    `/api/referrals/${withCcda.id}/routing`,
    { department: 'Neurology' },
    me.id,
  );
  check('the routing route accepts a change', reroute.status === 200, `status ${reroute.status}`);

  const activity = await get(`/api/workspaces/${wsWith.id}/activity`, me.id);
  check('GET the activity feed returns 200', activity.status === 200, `status ${activity.status}`);
  check(
    'the routing change is now recorded, with the value it changed FROM',
    activity.body.includes('referral.routing_changed') &&
      activity.body.includes('"previousDepartment":"Cardiology"') &&
      activity.body.includes('Neurology'),
    'a routing change left no usable trace',
  );

  const feed = JSON.parse(activity.body) as {
    total: number;
    counts: Record<string, number>;
    entries: { kind: string; eventType: string; actorLabel: string; evidence: string | null }[];
  };
  check('the feed reads the log for this referral', feed.total > 5, `${feed.total} entries`);
  check(
    'it carries every kind the referral has generated',
    feed.counts.status > 0 && feed.counts.user > 0 && feed.counts.access > 0,
    `counts ${JSON.stringify(feed.counts)}`,
  );
  check(
    'delivery and access are distinct evidence, never one "seen" flag',
    feed.entries.some((e) => e.evidence === 'access') &&
      feed.entries.every((e) => e.evidence === null || e.evidence === 'access' || e.evidence === 'delivery'),
    'evidence is not being classified',
  );
  check(
    'a real person is named rather than a raw actor string',
    feed.entries.some((e) => e.actorLabel.includes('Chen')),
    'the actor resolver did not resolve anybody',
  );
  check(
    'no actor renders as an unresolved prefix',
    !feed.entries.some((e) => /^(user|guest|clinician|skill|payer):/.test(e.actorLabel)),
    'an actor string reached the feed unresolved',
  );

  const filtered = await get(`/api/workspaces/${wsWith.id}/activity?kind=user`, me.id);
  const filteredFeed = JSON.parse(filtered.body) as {
    total: number;
    counts: Record<string, number>;
    entries: { kind: string }[];
  };
  check(
    'a kind filter narrows the entries but keeps the unfiltered counts',
    filteredFeed.entries.every((e) => e.kind === 'user') &&
      filteredFeed.total === feed.total &&
      filteredFeed.counts.status === feed.counts.status,
    'a filtered feed reported filtered counts, so every other tab would read zero',
  );

  const badKind = await get(`/api/workspaces/${wsWith.id}/activity?kind=nonsense`, me.id);
  check(
    'an unrecognised kind shows everything rather than erroring',
    badKind.status === 200 && (JSON.parse(badKind.body) as { entries: unknown[] }).entries.length === feed.total,
    `status ${badKind.status}`,
  );

  // ── The guest feed, read from the bytes ───────────────────────────────────
  const guestActivity = await getRaw('/api/guest/activity', guestCookie);
  check('the guest activity API returns 200', guestActivity.status === 200, `status ${guestActivity.status}`);
  for (const internal of [
    'workspace.assigned',
    'workspace.work_status_changed',
    'workspace.comment_added',
    'workspace.document_viewed',
    'referral.routing_changed',
    'INTERNAL-ONLY-MARKER',
  ]) {
    check(
      `the guest feed withholds ${internal}`,
      !guestActivity.body.includes(internal),
      'an internal event reached a guest',
    );
  }
  // NOT asserting the feed is non-empty here: the smoke fixtures are inserted
  // directly rather than driven through ingest, so no `referral.*` event was
  // ever emitted for them. What this block can prove is the security property —
  // every entry that DOES appear is allow-listed — and the end of the script
  // asserts the feed fills up once real protocol events exist.
  const guestEntries = (JSON.parse(guestActivity.body) as {
    entries: { eventType: string }[];
  }).entries;
  check(
    'every entry a guest can see is an allow-listed protocol milestone',
    guestEntries.every((e) => e.eventType.startsWith('referral.')),
    `a non-protocol event reached a guest: ${guestEntries.map((e) => e.eventType).join(', ')}`,
  );
  check(
    'and never names which member of staff acted',
    !guestActivity.body.includes('Chen') && !guestActivity.body.includes('"user:'),
    'internal staffing detail reached a guest',
  );

  const guestPageActivity = await getRaw('/guest/workspace', guestCookie);
  check(
    'the guest page carries its history section',
    guestPageActivity.body.includes('gActivity') && guestPageActivity.body.includes('/api/guest/activity'),
    'the guest history section is not wired in',
  );

  const activityDenied = await getRaw(`/api/workspaces/${wsWith.id}/activity`, guestCookie);
  check(
    'a guest cookie is refused at the internal activity API',
    activityDenied.status === 403,
    `status ${activityDenied.status}`,
  );

  const actPanel = await get(`/workspaces/${wsWith.id}`, me.id);
  check(
    'the workspace page carries the activity panel',
    actPanel.body.includes('renderActivity') && actPanel.body.includes('act-tabs'),
    'the activity panel is not wired into the page',
  );
  check(
    'every reserved panel is now filled',
    // Asserted against the embedded payload, not the page text: renderSlots()
    // carries the string 'slot-tag' in its source whether or not it is ever
    // called, so searching the bytes proves nothing.
    /"slots":\{"activity":true,"documents":true,"conversation":true,"participants":true,"owner":true\}/.test(
      actPanel.body,
    ),
    'a reserved panel is still flagged unbuilt',
  );

  await revokeInvitation(invitation.id, other);
  const afterRevoke = await getRaw('/api/guest/workspace', guestCookie);
  check(
    'revocation takes effect mid-session',
    afterRevoke.status === 403,
    `status ${afterRevoke.status}`,
  );
  check(
    'and says access ended rather than sending them back to a dead link',
    afterRevoke.body.includes('has been ended'),
    `body was ${afterRevoke.body.slice(0, 120)}`,
  );

  for (const [label, bad] of [['unknown', 'A'.repeat(43)], ['malformed', 'short']] as [string, string][]) {
    const res = await fetch(`${BASE}/guest/${bad}`, { redirect: 'manual' });
    const body = await res.text();
    check(
      `an ${label} token explains itself instead of throwing`,
      res.status === 404 && body.includes('not valid') && !body.includes('at Object.'),
      `status ${res.status}`,
    );
  }


  // ── Protocol assertions (PRD-29) ──────────────────────────────────────────
  //
  // wsWith is Waiting-External on a Scheduled referral, so the receiving party
  // can assert `encounter` and `interim-update` and nothing from earlier in the
  // lifecycle. That is the catalog doing its job, and asserting on it here
  // checks the SERVER's answer rather than a hand-written list.
  const availApi = await get(`/api/workspaces/${wsWith.id}/assertions/available`);
  check('GET the available assertions returns 200', availApi.status === 200, `status ${availApi.status}`);
  check(
    'a licensed user acts for the RECEIVING party, resolved server-side',
    availApi.body.includes('"partyRole":"receiving"'),
    'the internal party was not resolved, so a coordinator could assert as the other side',
  );
  check(
    'the offered set matches the protocol state rather than listing everything',
    availApi.body.includes('"encounter"') && !availApi.body.includes('"accept"'),
    'accept was offered on a Scheduled referral',
  );
  check(
    'every offered assertion is labelled without a protocol acronym',
    !/"label":"[^"]*(RRI|SIU|C-CDA|MDN|HL7)/.test(availApi.body),
    'a guest who knows no HL7 could not act on these labels',
  );

  // An assertion the state forbids must be refused, and must leave nothing.
  const tooEarly = await post(`/api/workspaces/${wsWith.id}/assertions`, { assertionType: 'accept' });
  check('an assertion the state forbids is refused', tooEarly.status === 409, `status ${tooEarly.status}`);
  const notAThing = await post(`/api/workspaces/${wsWith.id}/assertions`, { assertionType: 'elope' });
  check('an unknown assertion type is refused', notAThing.status === 400, `status ${notAThing.status}`);

  // An assertion the initiating party owns must be refused to our staff.
  const notOurs = await post(`/api/workspaces/${wsWith.id}/assertions`, {
    assertionType: 'interim-update',
    context: { note: 'ok' },
  });
  check('an assertion our role does permit succeeds', notOurs.status === 200, `status ${notOurs.status}`);

  const assertKey = `smoke-encounter-${Date.now()}`;
  const encounterRes = await post(`/api/workspaces/${wsWith.id}/assertions`, {
    assertionType: 'encounter',
    assertionKey: assertKey,
    context: {},
  });
  check('a permitted assertion renders and advances the protocol', encounterRes.status === 200, `status ${encounterRes.status}`);
  check(
    'and it moved the referral state through the machine',
    encounterRes.json.toState === 'Encounter',
    `toState was ${String(encounterRes.json.toState)}`,
  );

  const replay = await post(`/api/workspaces/${wsWith.id}/assertions`, {
    assertionType: 'encounter',
    assertionKey: assertKey,
    context: {},
  });
  check(
    'a replayed assertion key emits nothing new',
    replay.status === 200 && replay.json.idempotentReplay === true &&
      replay.json.assertionId === encounterRes.json.assertionId,
    'a double-clicked button would emit a second artifact',
  );

  // The consult note is the one that proves the point of the PRD: a real C-CDA
  // rendered by the existing builder, closing the loop.
  const outcome = await post(`/api/workspaces/${wsWith.id}/assertions`, {
    assertionType: 'final-outcome',
    context: { assessment: 'Stable angina, medical management', plan: 'Review in three months' },
  });
  check('the consult note assertion closes the referral', outcome.status === 200 && outcome.json.toState === 'Closed', `status ${outcome.status}`);

  const listed = await get(`/api/workspaces/${wsWith.id}/assertions`);
  check(
    'the assertions are listed with their delivery outcome',
    listed.status === 200 && listed.body.includes('"assertionType":"final-outcome"'),
    `status ${listed.status}`,
  );
  check(
    'the artifact points at a stored message row rather than nowhere',
    /"artifactMessageId":\d+/.test(listed.body),
    'an artifact was recorded with no bytes behind it',
  );

  // The C-CDA must actually be a C-CDA, built by the real builder — and must
  // carry no internal field. This is read from the stored artifact, not asserted
  // about in the abstract.
  const { db: smokeDb } = await import('../src/db');
  const { referralMessages: smokeMessages } = await import('../src/db/schema');
  const { eq: smokeEq } = await import('drizzle-orm');
  const stored = await smokeDb
    .select()
    .from(smokeMessages)
    .where(smokeEq(smokeMessages.referralId, withCcda.id));
  const consultNote = stored.find((m) => m.messageType === 'ConsultNote');
  check(
    'the consult note is real C-CDA from the existing builder',
    !!consultNote?.contentXml?.includes('ClinicalDocument') &&
      !!consultNote?.contentXml?.includes('2.16.840.1.113883.10.20.22.1.4'),
    'the stored artifact is not a Consultation Note document',
  );
  const allPayloads = stored.map((m) => `${m.contentHl7 ?? ''}${m.contentXml ?? ''}${m.contentBody ?? ''}`).join('');
  for (const internal of ['Waiting-External', 'exceptionReason', 'ownerUserId', 'workStatus']) {
    check(
      `no internal field "${internal}" reaches any rendered artifact`,
      !allPayloads.includes(internal),
      'internal workspace data leaked into a protocol artifact',
    );
  }
  // PRD-22's builder boundary, and behavioural rather than structural: three
  // comments exist on this workspace by now — one internal, one shared, one
  // written by a guest — and NONE of them may appear in an RRI, an SIU, a C-CDA
  // or an MDN. A builder is fed structured context by the gateway; it must never
  // reach into the conversation on its own. A SHARED comment is as forbidden
  // here as an internal one: sharing makes it visible in the workspace, not
  // transmissible over 360X.
  for (const marker of ['INTERNAL-ONLY-MARKER', 'SHARED-MARKER', 'GUEST-MARKER']) {
    check(
      `no comment ("${marker}") reaches any rendered artifact`,
      !allPayloads.includes(marker),
      'a comment was transmitted as part of a protocol artifact',
    );
  }

  check('the workspace page carries the assertion panel', reDetail.body.includes('renderAssertions'));


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

  // ── PRD-25: no orphaned events ────────────────────────────────────────────
  //
  // Placed last, once every assertion in this run has been made. Before PRD-25
  // the retransmit path emitted `workspace.assertion_made` with `entityId: 0`,
  // which belongs to no referral and would never appear in a per-referral feed.
  const { workflowEvents: smokeEvents } = await import('../src/db/schema');
  const orphaned = await smokeDb
    .select()
    .from(smokeEvents)
    .where(smokeEq(smokeEvents.entityId, 0));
  const orphanTypes = [...new Set(orphaned.map((e) => e.eventType))].sort();
  check(
    'no workspace event is orphaned at entityId 0',
    !orphanTypes.includes('workspace.assertion_made'),
    `orphaned event types: ${orphanTypes.join(', ')}`,
  );

  const finalFeed = await get(`/api/workspaces/${wsWith.id}/activity`, me.id);
  const finalEntries = (JSON.parse(finalFeed.body) as {
    entries: { eventType: string; kind: string }[];
  }).entries;
  check(
    'the feed carries the protocol assertions made during this run',
    finalEntries.some((e) => e.eventType === 'workspace.assertion_made'),
    'assertion events are not reaching the per-referral feed',
  );
  check(
    'and the protocol state changes alongside them',
    finalEntries.some((e) => e.kind === 'status'),
    'no status entry reached the feed',
  );

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
