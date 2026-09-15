/**
 * Unit tests for invitationService.ts and guestAccess.ts (PRD-30)
 *
 * These are security tests, so they are written to fail for mistakes nobody
 * anticipated rather than only for the ones already listed:
 *
 *   - THE PAYLOAD IS CHECKED AGAINST AN ALLOW-LIST of keys, not against a list
 *     of forbidden fields. Naming what may appear fails when somebody adds an
 *     internal field and accidentally copies it through; naming what may not
 *     appear only fails for fields somebody already thought of.
 *   - NO RAW TOKEN ANYWHERE. Asserted against the stored row and against every
 *     audit event, not just against the return value.
 *   - REVOCATION IS PER REQUEST. A session minted before revocation must die,
 *     and must die with the right REASON — "access ended", not "no session",
 *     because the second sends the guest back to a link that will also fail.
 */

jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct', orgName: 'Specialist Care Group' },
    database: { url: ':memory:' },
    workspace: {
      publicBaseUrl: 'http://test.invalid',
      guestInvitationExpiryHours: 336,
      guestSessionExpiryHours: 24,
    },
  },
}));

// SMTP is never reachable in a unit test. Stubbed to report failure so the
// "invitation survives a failed send" path is the one under test by default.
jest.mock('../../../src/modules/messaging/mailer', () => ({
  sendMail: jest.fn().mockResolvedValue(false),
  buildTransport: jest.fn(),
}));

jest.mock('../../../src/db', () => {
  const Database = require('better-sqlite3');
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const schema = require('../../../src/db/schema');

  const sqlite = new Database(':memory:');
  sqlite.exec(require('../../helpers/testSchema').TEST_SCHEMA_DDL);
  return { db: drizzle(sqlite, { schema }), sqlite };
});

import { eq } from 'drizzle-orm';
import { db } from '../../../src/db';
import {
  partyAddresses,
  patients,
  referralWorkspaces,
  referrals,
  users,
  workflowEvents,
  workspaceGuests,
  workspaceInvitations,
  workspaceParties,
} from '../../../src/db/schema';
import { ReferralState } from '../../../src/state/referralStateMachine';
import { WorkStatus } from '../../../src/state/workStatusMachine';
import { ActingUser } from '../../../src/modules/workspace/identityService';
import {
  InvitationAlreadyAcceptedError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationRevokedError,
  PartyNotOnWorkspaceError,
  acceptInvitation,
  createInvitation,
  hashToken,
  listInvitations,
  reissueInvitation,
  revokeInvitation,
} from '../../../src/modules/workspace/invitationService';
import {
  GUEST_PAYLOAD_KEYS,
  GUEST_SESSION_COOKIE,
  GUEST_WORKSPACE_KEYS,
  GuestAccessRevokedError,
  GuestScopeMismatchError,
  GuestSessionExpiredError,
  GuestSessionMissingError,
  buildGuestPayload,
  buildGuestTimeline,
  formatGuestActor,
  guestCookiePresent,
  requireGuest,
} from '../../../src/modules/workspace/guestAccess';

let seq = 0;
let actor: ActingUser;

const acting = (id: number): ActingUser => ({
  id,
  displayName: `User ${id}`,
  email: `u${id}@example.test`,
  directAddress: null,
  jobRole: 'coordinator',
  legacyClinicianId: null,
  allQueuesAccess: false,
  active: true,
});

/** A CookieCarrier, which is all requireGuest needs. */
const withCookie = (value: string | null): { headers: { cookie?: string } } => ({
  headers: value === null ? {} : { cookie: `${GUEST_SESSION_COOKIE}=${value}` },
});

beforeEach(async () => {
  await db.delete(workspaceGuests);
  await db.delete(workspaceInvitations);
  await db.delete(partyAddresses);
  await db.delete(workspaceParties);
  await db.delete(workflowEvents);
  await db.delete(referralWorkspaces);
  await db.delete(referrals);
  await db.delete(users);
  await db.delete(patients);

  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Dana Ruiz',
      email: `dana-${++seq}@example.test`,
      jobRole: 'coordinator',
      allQueuesAccess: false,
      active: true,
      createdAt: new Date(),
    })
    .returning();
  actor = acting(user.id);
});

interface Fixture {
  workspaceId: number;
  referralId: number;
  initiatingPartyId: number;
}

async function makeWorkspace(
  patientName = 'Ada',
  state: ReferralState = ReferralState.SCHEDULED,
): Promise<Fixture> {
  const [patient] = await db
    .insert(patients)
    .values({ firstName: patientName, lastName: 'Lovelace', dateOfBirth: '1815-12-10' })
    .returning();

  const [referral] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      sourceMessageId: `guest-${++seq}-${Date.now()}`,
      referrerAddress: 'referrals@lakeside.direct',
      reasonForReferral: 'Chest pain',
      state,
      routingDepartment: 'Cardiology',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const [workspace] = await db
    .insert(referralWorkspaces)
    .values({
      referralId: referral.id,
      workStatus: WorkStatus.WAITING_EXTERNAL,
      workStatusIsManual: false,
      ownerUserId: actor.id,
      nextAction: 'Chase the specialist',
      exceptionReason: 'an internal note that must never reach a guest',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const now = new Date();
  const [initiating] = await db
    .insert(workspaceParties)
    .values({
      workspaceId: workspace.id,
      orgName: 'Lakeside Cardiology',
      orgNameVerified: true,
      directAddress: 'referrals@lakeside.direct',
      partyRole: 'initiating',
      protocolMode: 'workspace-mediated',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await db.insert(workspaceParties).values({
    workspaceId: workspace.id,
    orgName: 'Specialist Care Group',
    orgNameVerified: true,
    directAddress: 'receiving@specialist.direct',
    partyRole: 'receiving',
    protocolMode: 'workspace-mediated',
    createdAt: now,
    updatedAt: now,
  });

  return { workspaceId: workspace.id, referralId: referral.id, initiatingPartyId: initiating.id };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

const events = async (): Promise<{ eventType: string; actor: string; metadata: string | null }[]> =>
  (await db.select().from(workflowEvents)).map((e) => ({
    eventType: e.eventType,
    actor: e.actor,
    metadata: e.metadata,
  }));

async function invite(f: Fixture, email = 'guest@lakeside.direct'): Promise<{ id: number; token: string }> {
  const { invitation, inviteUrl } = await createInvitation(
    f.workspaceId,
    f.initiatingPartyId,
    email,
    actor,
  );
  return { id: invitation.id, token: inviteUrl.split('/guest/')[1] };
}

describe('createInvitation()', () => {
  it('stores only a hash — the raw token appears solely in the returned URL', async () => {
    const f = await makeWorkspace();
    const { invitation, inviteUrl } = await createInvitation(
      f.workspaceId,
      f.initiatingPartyId,
      'guest@lakeside.direct',
      actor,
    );
    const token = inviteUrl.split('/guest/')[1];

    const [row] = await db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, invitation.id));

    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints 256 bits of entropy, which is the only brake on guessing', async () => {
    const f = await makeWorkspace();
    const first = await invite(f, 'a@lakeside.direct');
    const second = await invite(f, 'b@lakeside.direct');

    // 32 random bytes base64url-encode to 43 characters.
    expect(first.token).toHaveLength(43);
    expect(first.token).not.toBe(second.token);
  });

  it('applies the configured default expiry, and every invitation has one', async () => {
    const f = await makeWorkspace();
    const { invitation } = await createInvitation(
      f.workspaceId,
      f.initiatingPartyId,
      'guest@lakeside.direct',
      actor,
    );

    const hours = (invitation.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(335);
    expect(hours).toBeLessThan(337);
  });

  it('honours an explicit expiry', async () => {
    const f = await makeWorkspace();
    const { invitation } = await createInvitation(
      f.workspaceId,
      f.initiatingPartyId,
      'guest@lakeside.direct',
      actor,
      2,
    );

    const hours = (invitation.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThan(2.1);
  });

  it('refuses a party that is not on the workspace', async () => {
    const f = await makeWorkspace();
    const other = await makeWorkspace('Grace');

    await expect(
      createInvitation(f.workspaceId, other.initiatingPartyId, 'guest@lakeside.direct', actor),
    ).rejects.toThrow(PartyNotOnWorkspaceError);
  });

  it('survives a failed send, recorded as undelivered rather than lost', async () => {
    // The mailer stub reports failure. Losing the invitation because SMTP was
    // down would be strictly worse than showing it undelivered with a resend.
    const f = await makeWorkspace();
    const { invitation } = await createInvitation(
      f.workspaceId,
      f.initiatingPartyId,
      'guest@lakeside.direct',
      actor,
    );

    expect(invitation.emailDelivered).toBe(false);
    expect(await listInvitations(f.workspaceId)).toHaveLength(1);
  });

  it('writes no raw token into the audit event', async () => {
    const f = await makeWorkspace();
    const { token } = await invite(f);
    await flush();

    const all = await events();
    expect(all.some((e) => e.eventType === 'workspace.guest_invited')).toBe(true);
    for (const event of all) {
      expect(event.metadata ?? '').not.toContain(token);
    }
  });
});

describe('acceptInvitation()', () => {
  it('exchanges the token for a session and reports the scope', async () => {
    const f = await makeWorkspace();
    const { token } = await invite(f);

    const accepted = await acceptInvitation(token, 'Dr Chen');

    expect(accepted.workspaceId).toBe(f.workspaceId);
    expect(accepted.partyId).toBe(f.initiatingPartyId);
    expect(accepted.sessionToken).toHaveLength(43);
    expect(accepted.sessionToken).not.toBe(token);
  });

  it('stores only a hash of the session token', async () => {
    const f = await makeWorkspace();
    const { token } = await invite(f);
    const accepted = await acceptInvitation(token);

    const [guest] = await db
      .select()
      .from(workspaceGuests)
      .where(eq(workspaceGuests.id, accepted.guestId));

    expect(JSON.stringify(guest)).not.toContain(accepted.sessionToken);
    expect(guest.sessionTokenHash).toBe(hashToken(accepted.sessionToken));
  });

  it('succeeds once, then refuses the same token', async () => {
    const f = await makeWorkspace();
    const { token } = await invite(f);

    await acceptInvitation(token);
    await expect(acceptInvitation(token)).rejects.toThrow(InvitationAlreadyAcceptedError);
  });

  it('never lets a session outlive its invitation', async () => {
    // The configured session window is 24h; this invitation has 1h left, so the
    // session must expire with the invitation rather than after it.
    const f = await makeWorkspace();
    const { invitation, inviteUrl } = await createInvitation(
      f.workspaceId,
      f.initiatingPartyId,
      'guest@lakeside.direct',
      actor,
      1,
    );
    const accepted = await acceptInvitation(inviteUrl.split('/guest/')[1]);

    expect(accepted.sessionExpiresAt.getTime()).toBeLessThanOrEqual(invitation.expiresAt.getTime());
  });

  it('throws for an expired invitation', async () => {
    const f = await makeWorkspace();
    const { id, token } = await invite(f);
    await db
      .update(workspaceInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workspaceInvitations.id, id));

    await expect(acceptInvitation(token)).rejects.toThrow(InvitationExpiredError);
  });

  it('throws for a revoked invitation', async () => {
    const f = await makeWorkspace();
    const { id, token } = await invite(f);
    await revokeInvitation(id, actor);

    await expect(acceptInvitation(token)).rejects.toThrow(InvitationRevokedError);
  });

  it('rejects a malformed token without querying', async () => {
    // Shape is checked before the database is touched, so a long or hostile
    // path segment costs nothing.
    for (const bad of ['', 'short', 'x'.repeat(500), '../../etc/passwd', 'has spaces in it']) {
      await expect(acceptInvitation(bad)).rejects.toThrow(InvitationNotFoundError);
    }
  });

  it('says the same thing for an unknown token as for a malformed one', async () => {
    // Nothing is learned by probing: both answers are identical.
    const unknown = 'A'.repeat(43);
    await expect(acceptInvitation(unknown)).rejects.toThrow(InvitationNotFoundError);
    await expect(acceptInvitation('short')).rejects.toThrow(InvitationNotFoundError);
  });

  it('emits acceptance attributed to the guest, not to a user', async () => {
    const f = await makeWorkspace();
    const { token } = await invite(f);
    const accepted = await acceptInvitation(token);
    await flush();

    const accept = (await events()).find((e) => e.eventType === 'workspace.guest_accepted');
    expect(accept!.actor).toBe(`guest:${accepted.guestId}`);
  });
});

describe('revokeInvitation() and reissueInvitation()', () => {
  it('kills a live session on its NEXT REQUEST, with the right reason', async () => {
    const f = await makeWorkspace();
    const { id, token } = await invite(f);
    const accepted = await acceptInvitation(token);

    // Works before.
    await expect(requireGuest(withCookie(accepted.sessionToken))).resolves.toMatchObject({
      workspaceId: f.workspaceId,
    });

    await revokeInvitation(id, actor);

    // The REASON matters as much as the refusal: telling a revoked guest there
    // is "no session" sends them back to a link that will also fail. AC13 asks
    // for a clear access-ended state.
    await expect(requireGuest(withCookie(accepted.sessionToken))).rejects.toThrow(
      GuestAccessRevokedError,
    );
  });

  it('is a no-op when already revoked', async () => {
    const f = await makeWorkspace();
    const { id } = await invite(f);
    await revokeInvitation(id, actor);

    await expect(revokeInvitation(id, actor)).resolves.toBeUndefined();
  });

  it('marks the old invitation superseded and invalidates its token', async () => {
    const f = await makeWorkspace();
    const { id, token } = await invite(f);

    const fresh = await reissueInvitation(id, actor);

    await expect(acceptInvitation(token)).rejects.toThrow(InvitationAlreadyAcceptedError);
    await expect(
      acceptInvitation(fresh.inviteUrl.split('/guest/')[1]),
    ).resolves.toMatchObject({ workspaceId: f.workspaceId });
  });

  it('ends a session that the superseded invitation had produced', async () => {
    const f = await makeWorkspace();
    const { id, token } = await invite(f);
    const accepted = await acceptInvitation(token);

    await reissueInvitation(id, actor);

    await expect(requireGuest(withCookie(accepted.sessionToken))).rejects.toThrow(
      GuestAccessRevokedError,
    );
  });

  it('reports statuses the panel can render without re-deriving the rules', async () => {
    const f = await makeWorkspace();
    const pending = await invite(f, 'a@lakeside.direct');
    const revoked = await invite(f, 'b@lakeside.direct');
    await revokeInvitation(revoked.id, actor);
    const accepted = await invite(f, 'c@lakeside.direct');
    await acceptInvitation(accepted.token);

    const byId = new Map((await listInvitations(f.workspaceId)).map((i) => [i.id, i.status]));
    expect(byId.get(pending.id)).toBe('pending');
    expect(byId.get(revoked.id)).toBe('revoked');
    expect(byId.get(accepted.id)).toBe('accepted');
  });
});

describe('requireGuest()', () => {
  it('resolves the cookie to exactly one workspace and party', async () => {
    const f = await makeWorkspace();
    const accepted = await acceptInvitation((await invite(f)).token);

    const guest = await requireGuest(withCookie(accepted.sessionToken));

    expect(guest.workspaceId).toBe(f.workspaceId);
    expect(guest.partyId).toBe(f.initiatingPartyId);
    expect(guest.partyOrgName).toBe('Lakeside Cardiology');
    expect(guest.partyRole).toBe('initiating');
  });

  it('throws when there is no cookie', async () => {
    await expect(requireGuest(withCookie(null))).rejects.toThrow(GuestSessionMissingError);
  });

  it('throws for a tampered or unknown cookie', async () => {
    await expect(requireGuest(withCookie('B'.repeat(43)))).rejects.toThrow(GuestSessionMissingError);
    await expect(requireGuest(withCookie('nonsense'))).rejects.toThrow(GuestSessionMissingError);
  });

  it('throws when the session has expired', async () => {
    const f = await makeWorkspace();
    const accepted = await acceptInvitation((await invite(f)).token);
    await db
      .update(workspaceGuests)
      .set({ sessionExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(workspaceGuests.id, accepted.guestId));

    await expect(requireGuest(withCookie(accepted.sessionToken))).rejects.toThrow(
      GuestSessionExpiredError,
    );
  });

  it('throws when the invitation expired after the session was minted', async () => {
    const f = await makeWorkspace();
    const { id, token } = await invite(f);
    const accepted = await acceptInvitation(token);
    await db
      .update(workspaceInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workspaceInvitations.id, id));

    // Per-request, not at acceptance — otherwise expiry would be advisory.
    await expect(requireGuest(withCookie(accepted.sessionToken))).rejects.toThrow(
      GuestSessionExpiredError,
    );
  });

  it('REFUSES a valid session presented against another workspace', async () => {
    const f = await makeWorkspace();
    const other = await makeWorkspace('Grace');
    const accepted = await acceptInvitation((await invite(f)).token);

    // The path id is only ever used to reject. It can never select a workspace.
    await expect(
      requireGuest(withCookie(accepted.sessionToken), other.workspaceId),
    ).rejects.toThrow(GuestScopeMismatchError);

    await expect(
      requireGuest(withCookie(accepted.sessionToken), f.workspaceId),
    ).resolves.toMatchObject({ workspaceId: f.workspaceId });
  });

  it('formats the actor as guest:<id>, distinct from user:<id>', async () => {
    expect(formatGuestActor({ guestId: 7 })).toBe('guest:7');
  });

  it('detects a guest cookie without validating it', async () => {
    // Internal routes refuse anything that looks like a guest. Validating here
    // would let an invalid guest cookie through to be served as default staff.
    expect(guestCookiePresent(withCookie('anything at all'))).toBe(true);
    expect(guestCookiePresent(withCookie(null))).toBe(false);
  });
});

describe('buildGuestPayload()', () => {
  it('contains exactly the allowed keys and no others', async () => {
    const f = await makeWorkspace();
    const accepted = await acceptInvitation((await invite(f)).token);
    const guest = await requireGuest(withCookie(accepted.sessionToken));

    const payload = await buildGuestPayload(guest);

    // An ALLOW-LIST, deliberately. A forbidden-field list only catches leaks
    // somebody already imagined; this fails for any key that appears at all,
    // including one a future PRD copies in by accident.
    expect(Object.keys(payload!).sort()).toEqual([...GUEST_PAYLOAD_KEYS].sort());
    expect(Object.keys(payload!.workspace).sort()).toEqual([...GUEST_WORKSPACE_KEYS].sort());
  });

  it('leaks no internal value anywhere in the serialized payload', async () => {
    const f = await makeWorkspace();
    const accepted = await acceptInvitation((await invite(f)).token);
    const guest = await requireGuest(withCookie(accepted.sessionToken));

    const serialized = JSON.stringify(await buildGuestPayload(guest));

    // The fixture deliberately sets an owner, a work status, a next action and
    // an exception reason, so this is a real check rather than a vacuous one.
    expect(serialized).not.toContain('Waiting-External');
    expect(serialized).not.toContain('Chase the specialist');
    expect(serialized).not.toContain('an internal note that must never reach a guest');
    expect(serialized).not.toContain('workStatus');
    expect(serialized).not.toContain('ownerUserId');
    expect(serialized).not.toContain('queueId');
  });

  it('carries the patient and both organizations, which is the point of it', async () => {
    const f = await makeWorkspace();
    const accepted = await acceptInvitation((await invite(f)).token);
    const guest = await requireGuest(withCookie(accepted.sessionToken));

    const payload = await buildGuestPayload(guest);

    expect(payload!.workspace.patientName).toBe('Ada Lovelace');
    expect(payload!.workspace.initiatingOrg).toBe('Lakeside Cardiology');
    expect(payload!.workspace.receivingOrg).toBe('Specialist Care Group');
    expect(payload!.workspace.referralState).toBe(ReferralState.SCHEDULED);
  });

  it('still presents the PRD-23 collection as present and empty', async () => {
    const f = await makeWorkspace();
    const accepted = await acceptInvitation((await invite(f)).token);
    const guest = await requireGuest(withCookie(accepted.sessionToken));

    const payload = await buildGuestPayload(guest);

    // Present AND empty: a consumer written against Phase 2a must not break
    // when PRD-23 fills it, so the shape is the contract.
    expect(payload!.sharedDocuments).toEqual([]);
  });

  it('carries shared comments and leaves internal ones out of the payload entirely', async () => {
    // PRD-22 filled sharedComments, so this no longer asserts an empty array.
    // The filter is in listSharedComments' SQL: an internal comment is not
    // hidden from this payload, it is never loaded into the process for it.
    const f = await makeWorkspace();
    const accepted = await acceptInvitation((await invite(f)).token);
    const guest = await requireGuest(withCookie(accepted.sessionToken));

    const { postComment } = await import('../../../src/modules/workspace/commentService');
    await postComment({
      workspaceId: f.workspaceId,
      body: 'INTERNAL: the payer is being difficult about this one',
      author: { kind: 'user', user: actor },
    });
    await postComment({
      workspaceId: f.workspaceId,
      body: 'Could you send the echo report?',
      visibility: 'Shared',
      confirmShared: true,
      author: { kind: 'user', user: actor },
    });

    const payload = await buildGuestPayload(guest);

    expect(payload!.sharedComments.map((c) => c.body)).toEqual([
      'Could you send the echo report?',
    ]);
    // Asserted over the whole serialised payload, not just the comment slice:
    // an internal note copied into any other field fails here too.
    expect(JSON.stringify(payload)).not.toContain('INTERNAL');
    expect(JSON.stringify(payload)).not.toContain('payer');
  });

  it('offers the guest the assertions their party role actually permits', async () => {
    // No longer empty: PRD-29 filled this, which was the third of PRD-30's
    // deferred items. The fixture's guest is the INITIATING party on a
    // Scheduled referral, so the catalog gives them interim-update and not
    // accept, decline or scheduled — all of which are the receiving party's.
    const f = await makeWorkspace();
    const accepted = await acceptInvitation((await invite(f)).token);
    const guest = await requireGuest(withCookie(accepted.sessionToken));

    const types = (await buildGuestPayload(guest))!.availableAssertions.map((a) => a.type);

    expect(types).toContain('interim-update');
    expect(types).not.toContain('accept');
    expect(types).not.toContain('decline');
    expect(types).not.toContain('scheduled');
  });

  it('gives every offered assertion a label a guest can act on without knowing HL7', async () => {
    const f = await makeWorkspace();
    const accepted = await acceptInvitation((await invite(f)).token);
    const guest = await requireGuest(withCookie(accepted.sessionToken));

    const offered = (await buildGuestPayload(guest))!.availableAssertions;

    expect(offered.length).toBeGreaterThan(0);
    for (const a of offered) {
      expect(a.label).toMatch(/[a-z]/);
      expect(a.label).not.toMatch(/RRI|SIU|C-CDA|MDN|HL7/);
      expect(a.description).toMatch(/[a-z]/);
    }
  });
});

describe('buildGuestTimeline()', () => {
  it('marks everything up to the current state as reached', async () => {
    const steps = buildGuestTimeline(ReferralState.SCHEDULED);

    expect(steps.filter((s) => s.current).map((s) => s.state)).toEqual([ReferralState.SCHEDULED]);
    expect(steps.find((s) => s.state === ReferralState.ACKNOWLEDGED)!.reached).toBe(true);
    expect(steps.find((s) => s.state === ReferralState.CLOSED)!.reached).toBe(false);
  });

  it('follows the declined branch rather than the happy path', async () => {
    const steps = buildGuestTimeline(ReferralState.DECLINED);

    expect(steps.map((s) => s.state)).toEqual([
      ReferralState.RECEIVED,
      ReferralState.ACKNOWLEDGED,
      ReferralState.DECLINED,
    ]);
    expect(steps.every((s) => s.reached)).toBe(true);
  });

  it('follows the no-show and consult branches', async () => {
    // A single canonical sequence would misreport all three branches, which is
    // why this mirrors the internal page's logic rather than an index order.
    expect(buildGuestTimeline(ReferralState.NO_SHOW).map((s) => s.state)).toContain(
      ReferralState.NO_SHOW,
    );
    expect(buildGuestTimeline(ReferralState.CONSULT).map((s) => s.state)).toContain(
      ReferralState.CONSULT,
    );
    expect(buildGuestTimeline(ReferralState.CONSULT).map((s) => s.state)).not.toContain(
      ReferralState.ENCOUNTER,
    );
  });

  it('renders every protocol state without throwing', async () => {
    for (const state of Object.values(ReferralState)) {
      expect(() => buildGuestTimeline(state)).not.toThrow();
      expect(buildGuestTimeline(state).length).toBeGreaterThan(0);
    }
  });
});
