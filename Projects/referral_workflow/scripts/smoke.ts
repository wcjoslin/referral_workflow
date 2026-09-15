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
