/**
 * Unit tests for activityService.ts and eventCatalog.ts (PRD-25)
 *
 * Three things carry the weight:
 *
 *   - THE CATALOG MUST MATCH REALITY. A test greps every `eventType:` literal
 *     out of `src/` and asserts the catalog names it. That is the whole value of
 *     a catalog, and the draft's version had already drifted three ways before a
 *     line of it was written.
 *   - THE ACTOR RESOLVER MUST NOT INVENT PEOPLE. `clinician:` contains
 *     automation, and rendering `SYSTEM-SKILL-payer-network-check` as a doctor
 *     in a narrative feed is worse than the analytics bug PRD-17 fixed.
 *   - THE GUEST FEED IS AN ALLOW-LIST. Asserted by adding an unknown internal
 *     event type and confirming it does not appear, which is the case a
 *     deny-list would miss.
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
      senderIdentityMode: 'organization',
      uploadDir: '/tmp/prd25-uploads',
      maxUploadBytes: 4096,
    },
  },
}));

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
  return { db: drizzle(sqlite, { schema }) };
});

import { eq } from 'drizzle-orm';
import { execSync } from 'child_process';
import path from 'path';
import { db } from '../../../src/db';
import {
  documentAccessLog,
  patients,
  referralComments,
  referralWorkspaces,
  referrals,
  users,
  workflowEvents,
  workspaceDocuments,
  workspaceGuests,
  workspaceInvitations,
  workspaceParties,
} from '../../../src/db/schema';
import { ReferralState } from '../../../src/state/referralStateMachine';
import { WorkStatus } from '../../../src/state/workStatusMachine';
import { GuestContext } from '../../../src/modules/workspace/guestAccess';
import {
  ALL_EVENT_TYPES,
  GUEST_VISIBLE_EVENTS,
  WorkspaceEvents,
  evidenceOf,
  kindOf,
} from '../../../src/modules/workspace/eventCatalog';
import {
  NotReopenableError,
  reopenReferral,
} from '../../../src/modules/workspace/dispositionOverride';
import {
  ActivityWorkspaceNotFoundError,
  getActivityFeed,
  getGuestActivityFeed,
  resolveActorLabel,
} from '../../../src/modules/workspace/activityService';

let seq = 0;

interface Fixture {
  workspaceId: number;
  referralId: number;
  partyId: number;
}

beforeEach(async () => {
  await db.delete(documentAccessLog);
  await db.delete(workspaceDocuments);
  await db.delete(referralComments);
  await db.delete(workspaceGuests);
  await db.delete(workspaceInvitations);
  await db.delete(workspaceParties);
  await db.delete(workflowEvents);
  await db.delete(referralWorkspaces);
  await db.delete(referrals);
  await db.delete(users);
  await db.delete(patients);
});

async function makeWorkspace(): Promise<Fixture> {
  const [patient] = await db
    .insert(patients)
    .values({ firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1815-12-10' })
    .returning();
  const [referral] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      sourceMessageId: `act-${++seq}-${Date.now()}`,
      referrerAddress: 'referrals@lakeside.direct',
      state: ReferralState.SCHEDULED,
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
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  const [party] = await db
    .insert(workspaceParties)
    .values({
      workspaceId: workspace.id,
      partyRole: 'initiating',
      orgName: 'Lakeside Primary Care',
      orgNameVerified: false,
      directAddress: 'referrals@lakeside.direct',
      protocolMode: 'workspace-mediated',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  return { workspaceId: workspace.id, referralId: referral.id, partyId: party.id };
}

/** Writes an event directly — these tests read the log, they do not exercise emitters. */
async function event(
  fx: Fixture,
  eventType: string,
  actor: string,
  opts: {
    at?: Date;
    metadata?: Record<string, unknown>;
    fromState?: string;
    toState?: string;
  } = {},
): Promise<void> {
  await db.insert(workflowEvents).values({
    eventType,
    entityType: 'referral',
    entityId: fx.referralId,
    fromState: opts.fromState ?? null,
    toState: opts.toState ?? null,
    actor,
    metadata: opts.metadata === undefined ? null : JSON.stringify(opts.metadata),
    createdAt: opts.at ?? new Date(),
  });
}

async function makeUser(displayName: string, slug?: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      displayName,
      email: `u${++seq}@example.test`,
      jobRole: 'coordinator',
      legacyClinicianId: slug ?? null,
      allQueuesAccess: false,
      active: true,
      createdAt: new Date(),
    })
    .returning();
  return row.id;
}

async function makeGuest(fx: Fixture, displayName: string | null): Promise<GuestContext> {
  // invited_by_user_id is NOT NULL: somebody always invited a guest.
  const inviterId = await makeUser(`Inviter ${seq}`);
  const [invitation] = await db
    .insert(workspaceInvitations)
    .values({
      workspaceId: fx.workspaceId,
      partyId: fx.partyId,
      recipientEmail: `g${++seq}@lakeside.test`,
      tokenHash: `h-${seq}`,
      invitedByUserId: inviterId,
      expiresAt: new Date(Date.now() + 86_400_000),
      emailDelivered: false,
      createdAt: new Date(),
    })
    .returning();
  const [guest] = await db
    .insert(workspaceGuests)
    .values({
      invitationId: invitation.id,
      workspaceId: fx.workspaceId,
      partyId: fx.partyId,
      displayName,
      sessionTokenHash: `s-${seq}`,
      sessionExpiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    })
    .returning();
  return {
    guestId: guest.id,
    invitationId: invitation.id,
    workspaceId: fx.workspaceId,
    partyId: fx.partyId,
    partyRole: 'initiating',
    partyOrgName: 'Lakeside Primary Care',
    protocolMode: 'workspace-mediated',
    displayName,
    expiresAt: guest.sessionExpiresAt as Date,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('eventCatalog (PRD-25)', () => {
  it('names every event type the codebase actually emits', () => {
    // THE POINT OF THE CATALOG. The draft of PRD-25 misnamed one real event,
    // omitted four and declared eleven that nothing emitted. This is the test
    // that makes such a claim checkable rather than aspirational.
    const root = path.resolve(__dirname, '../../../src');
    const raw = execSync(
      `grep -rho "eventType: '[a-z_.]*'" ${root} || true`,
      { encoding: 'utf-8' },
    );
    const emitted = [
      ...new Set(
        raw
          .split('\n')
          .map((line) => line.replace(/^eventType: '/, '').replace(/'$/, '').trim())
          .filter((t) => t.includes('.')),
      ),
    ].sort();

    expect(emitted.length).toBeGreaterThan(40); // sanity: the grep found things
    const missing = emitted.filter((t) => !ALL_EVENT_TYPES.includes(t));
    expect(missing).toEqual([]);
  });

  it('declares nothing it cannot classify', () => {
    for (const type of ALL_EVENT_TYPES) {
      expect(['system', 'user', 'guest', 'status', 'delivery', 'access']).toContain(
        kindOf(type, 'system'),
      );
    }
  });

  it('keeps delivery and access as separate evidence, and everything else as neither', () => {
    expect(evidenceOf('message.acknowledged')).toBe('delivery');
    expect(evidenceOf(WorkspaceEvents.ARTIFACT_NOT_TRANSMITTED)).toBe('delivery');
    expect(evidenceOf(WorkspaceEvents.DOCUMENT_VIEWED)).toBe('access');
    expect(evidenceOf(WorkspaceEvents.DOCUMENT_DOWNLOADED)).toBe('access');
    // An assignment proves nothing about the counterparty either way.
    expect(evidenceOf(WorkspaceEvents.ASSIGNED)).toBeNull();
    // Neither does a transmitted artifact that has not been acknowledged.
    expect(evidenceOf(WorkspaceEvents.ASSERTION_MADE)).toBeNull();
  });

  it('classifies a guest opening a document as access, not as guest', () => {
    // The evidence it carries is the more important fact; the actor label still
    // says a guest did it.
    expect(kindOf(WorkspaceEvents.DOCUMENT_VIEWED, 'guest:4')).toBe('access');
    expect(kindOf(WorkspaceEvents.GUEST_ACCEPTED, 'guest:4')).toBe('guest');
    expect(kindOf(WorkspaceEvents.ASSIGNED, 'user:5')).toBe('user');
    expect(kindOf(WorkspaceEvents.PARTY_SEEDED, 'system')).toBe('system');
  });

  it('exposes only protocol milestones to a guest', () => {
    for (const type of GUEST_VISIBLE_EVENTS) {
      expect(type.startsWith('referral.')).toBe(true);
    }
    // Not one workspace event, and specifically not the ones that would leak.
    expect(GUEST_VISIBLE_EVENTS).not.toContain(WorkspaceEvents.ASSIGNED);
    expect(GUEST_VISIBLE_EVENTS).not.toContain(WorkspaceEvents.WORK_STATUS_CHANGED);
    expect(GUEST_VISIBLE_EVENTS).not.toContain(WorkspaceEvents.COMMENT_ADDED);
    expect(GUEST_VISIBLE_EVENTS).not.toContain(WorkspaceEvents.DOCUMENT_VIEWED);
  });
});

describe('resolveActorLabel()', () => {
  const labels = {
    usersById: new Map([[5, 'Dana Ruiz']]),
    usersBySlug: new Map([['dr-chen', 'Dr. Emily Chen, MD']]),
    guestsById: new Map([
      [4, { displayName: 'Dr. Ruth Okoro', orgName: 'Lakeside Primary Care' }],
      [9, { displayName: null, orgName: 'Lakeside Primary Care' }],
    ]),
  };

  it('resolves a real person from each namespace that holds one', () => {
    expect(resolveActorLabel('user:5', labels)).toBe('Dana Ruiz');
    expect(resolveActorLabel('clinician:dr-chen', labels)).toBe('Dr. Emily Chen, MD');
    expect(resolveActorLabel('guest:4', labels)).toBe('Dr. Ruth Okoro (Lakeside Primary Care)');
    expect(resolveActorLabel('system', labels)).toBe('System');
  });

  it('NEVER renders automation in the clinician namespace as a person', () => {
    // PRD-17's finding: skillActions writes SYSTEM-SKILL-<name> and
    // pendingInfoChecker writes SYSTEM-TIMEOUT, both through the clinician
    // namespace. Showing those as doctors in a narrative feed actively
    // misinforms — it is the analytics bug PRD-17 fixed, made worse.
    expect(resolveActorLabel('clinician:SYSTEM-SKILL-payer-network-check', labels)).toBe(
      'Automated rule: payer-network-check',
    );
    expect(resolveActorLabel('clinician:SYSTEM-TIMEOUT', labels)).toBe('Automatic timeout');
    expect(resolveActorLabel('clinician:SYSTEM-SOMETHING-NEW', labels)).toBe(
      'Automation: SOMETHING-NEW',
    );
    for (const label of [
      resolveActorLabel('clinician:SYSTEM-SKILL-payer-network-check', labels),
      resolveActorLabel('clinician:SYSTEM-TIMEOUT', labels),
    ]) {
      expect(label).not.toContain('Dr.');
      expect(label).not.toContain('Dana');
    }
  });

  it('names the automation namespaces plainly', () => {
    expect(resolveActorLabel('skill:payer-network-check', labels)).toBe(
      'Automated rule: payer-network-check',
    );
    expect(resolveActorLabel('payer:Aetna', labels)).toBe('Aetna (payer)');
  });

  it('handles a guest with no supplied name, and the unresolved-denial actor', () => {
    expect(resolveActorLabel('guest:9', labels)).toBe('A guest (Lakeside Primary Care)');
    // Not a missing guest: a denial where no session resolved. That IS the event.
    expect(resolveActorLabel('guest:unresolved', labels)).toBe('An unidentified guest');
  });

  it('degrades an unknown shape to the raw string rather than throwing', () => {
    expect(resolveActorLabel('robot:42', labels)).toBe('robot:42');
    expect(resolveActorLabel('user:999', labels)).toBe('User 999');
    expect(resolveActorLabel('clinician:dr-nobody', labels)).toBe('dr-nobody');
    expect(resolveActorLabel('', labels)).toBe('Unknown');
  });
});

describe('getActivityFeed()', () => {
  it('reads the log for one referral, in the order it happened', async () => {
    const fx = await makeWorkspace();
    const base = Date.now();
    await event(fx, 'referral.received', 'system', { at: new Date(base) });
    await event(fx, 'referral.acknowledged', 'system', { at: new Date(base + 1000) });
    await event(fx, WorkspaceEvents.ASSIGNED, 'user:5', { at: new Date(base + 2000) });

    const feed = await getActivityFeed(fx.workspaceId);
    expect(feed.entries.map((e) => e.eventType)).toEqual([
      'referral.received',
      'referral.acknowledged',
      WorkspaceEvents.ASSIGNED,
    ]);
    expect(feed.total).toBe(3);
  });

  it('does not read another referral’s events', async () => {
    const fx = await makeWorkspace();
    const other = await makeWorkspace();
    await event(fx, 'referral.received', 'system');
    await event(other, 'referral.received', 'system');
    await event(other, WorkspaceEvents.ASSIGNED, 'user:5');

    await expect(getActivityFeed(fx.workspaceId)).resolves.toMatchObject({ total: 1 });
    await expect(getActivityFeed(other.workspaceId)).resolves.toMatchObject({ total: 2 });
  });

  it('breaks a timestamp tie by id so the order is stable between requests', async () => {
    const fx = await makeWorkspace();
    const same = new Date();
    await event(fx, 'referral.received', 'system', { at: same });
    await event(fx, 'referral.acknowledged', 'system', { at: same });
    await event(fx, WorkspaceEvents.ASSIGNED, 'user:5', { at: same });

    const first = await getActivityFeed(fx.workspaceId);
    const second = await getActivityFeed(fx.workspaceId);
    expect(first.entries.map((e) => e.id)).toEqual(second.entries.map((e) => e.id));
    expect(first.entries.map((e) => e.eventType)).toEqual([
      'referral.received',
      'referral.acknowledged',
      WorkspaceEvents.ASSIGNED,
    ]);
  });

  it('reports UNFILTERED counts even when a filter is applied', async () => {
    const fx = await makeWorkspace();
    await event(fx, 'referral.received', 'system');
    await event(fx, WorkspaceEvents.ASSIGNED, 'user:5');
    await event(fx, WorkspaceEvents.PARTY_SEEDED, 'system');
    await event(fx, WorkspaceEvents.DOCUMENT_VIEWED, 'guest:4', { metadata: { documentId: 1 } });

    const filtered = await getActivityFeed(fx.workspaceId, 'user');
    expect(filtered.entries).toHaveLength(1);
    // A tab must be able to show its own count while you are on another one.
    expect(filtered.counts).toEqual({
      system: 1,
      user: 1,
      guest: 0,
      status: 1,
      delivery: 0,
      access: 1,
    });
    expect(filtered.total).toBe(4);
  });

  it('resolves actors through the roster, including automation', async () => {
    const fx = await makeWorkspace();
    const danaId = await makeUser('Dana Ruiz');
    await makeUser('Dr. Emily Chen, MD', 'dr-chen');
    const guest = await makeGuest(fx, 'Dr. Ruth Okoro');

    await event(fx, WorkspaceEvents.ASSIGNED, `user:${danaId}`);
    await event(fx, 'referral.acknowledged', 'clinician:dr-chen');
    await event(fx, 'referral.auto_declined', 'clinician:SYSTEM-SKILL-payer-network-check');
    await event(fx, WorkspaceEvents.GUEST_ACCEPTED, `guest:${guest.guestId}`);

    const labels = (await getActivityFeed(fx.workspaceId)).entries.map((e) => e.actorLabel);
    expect(labels).toEqual([
      'Dana Ruiz',
      'Dr. Emily Chen, MD',
      'Automated rule: payer-network-check',
      'Dr. Ruth Okoro (Lakeside Primary Care)',
    ]);
  });

  it('carries the transition on a state change and nothing on other entries', async () => {
    const fx = await makeWorkspace();
    await event(fx, 'referral.scheduled', 'user:5', {
      fromState: 'Accepted',
      toState: 'Scheduled',
    });
    await event(fx, WorkspaceEvents.COMMENT_ADDED, 'user:5', { metadata: { commentId: 1 } });

    const [transitionEntry, commentEntry] = (await getActivityFeed(fx.workspaceId)).entries;
    expect(transitionEntry).toMatchObject({ fromState: 'Accepted', toState: 'Scheduled' });
    expect(commentEntry).toMatchObject({ fromState: null, toState: null });
  });

  it('links an entry to its artifact, and says so when the artifact has gone', async () => {
    const fx = await makeWorkspace();
    const [document] = await db
      .insert(workspaceDocuments)
      .values({
        workspaceId: fx.workspaceId,
        contentSource: 'referral-ccda',
        contentRef: fx.referralId,
        contentType: 'application/xml',
        docType: 'Referral Note',
        source: 'inbound-dsm',
        scope: 'referral',
        receivedAt: new Date(),
        visibility: 'Shared',
        immutable: true,
        createdAt: new Date(),
      })
      .returning();

    await event(fx, WorkspaceEvents.DOCUMENT_VIEWED, 'user:5', {
      metadata: { documentId: document.id },
    });
    await event(fx, WorkspaceEvents.DOCUMENT_VIEWED, 'user:5', {
      metadata: { documentId: 99999 },
    });

    const entries = (await getActivityFeed(fx.workspaceId)).entries;
    expect(entries[0].artifact).toEqual({
      kind: 'document',
      id: document.id,
      label: 'Referral Note',
    });
    // The event happened. Hiding it would be a quieter kind of lie than saying
    // the target is gone.
    expect(entries[1].artifact).toEqual({
      kind: 'document',
      id: 99999,
      label: 'Document no longer available',
    });
  });

  it('degrades a malformed metadata blob instead of failing the whole feed', async () => {
    const fx = await makeWorkspace();
    await db.insert(workflowEvents).values({
      eventType: WorkspaceEvents.DOCUMENT_INDEXED,
      entityType: 'referral',
      entityId: fx.referralId,
      actor: 'system',
      metadata: '{not json at all',
      createdAt: new Date(),
    });
    await event(fx, 'referral.received', 'system');

    const feed = await getActivityFeed(fx.workspaceId);
    expect(feed.total).toBe(2);
    expect(feed.entries[0].metadata).toEqual({});
    expect(feed.entries[0].summary).toBeTruthy();
  });

  it('gives an unknown event type a readable summary rather than a blank row', async () => {
    const fx = await makeWorkspace();
    await event(fx, 'workspace.something_nobody_added_yet', 'system');
    const [entry] = (await getActivityFeed(fx.workspaceId)).entries;
    // A later PRD forgetting to add a phrase degrades one line, not the feed.
    expect(entry.summary).toBe('Something nobody added yet');
  });

  it('handles several hundred entries in one read, in order', async () => {
    const fx = await makeWorkspace();
    const base = Date.now();
    for (let i = 0; i < 400; i += 1) {
      await event(fx, 'referral.received', 'system', { at: new Date(base + i * 10) });
    }
    const feed = await getActivityFeed(fx.workspaceId);
    expect(feed.total).toBe(400);
    for (let i = 1; i < feed.entries.length; i += 1) {
      expect(feed.entries[i].occurredAt.getTime()).toBeGreaterThanOrEqual(
        feed.entries[i - 1].occurredAt.getTime(),
      );
    }
  });

  it('refuses an unknown workspace rather than returning an empty feed', async () => {
    await expect(getActivityFeed(9999)).rejects.toThrow(ActivityWorkspaceNotFoundError);
    await expect(getActivityFeed(0)).rejects.toThrow(ActivityWorkspaceNotFoundError);
  });

  it('returns an empty feed, not an error, for a workspace with no events', async () => {
    const fx = await makeWorkspace();
    await expect(getActivityFeed(fx.workspaceId)).resolves.toEqual({
      entries: [],
      counts: { system: 0, user: 0, guest: 0, status: 0, delivery: 0, access: 0 },
      total: 0,
    });
  });
});

describe('getGuestActivityFeed()', () => {
  it('shows protocol milestones and withholds everything internal', async () => {
    const fx = await makeWorkspace();
    const guest = await makeGuest(fx, 'Dr. Ruth Okoro');
    const danaId = await makeUser('Dana Ruiz');

    await event(fx, 'referral.received', 'system');
    await event(fx, 'referral.scheduled', `user:${danaId}`, {
      fromState: 'Accepted',
      toState: 'Scheduled',
    });
    // All of the following are internal and must not appear.
    await event(fx, WorkspaceEvents.ASSIGNED, `user:${danaId}`);
    await event(fx, WorkspaceEvents.WORK_STATUS_CHANGED, `user:${danaId}`, {
      metadata: { workStatus: 'Waiting-External' },
    });
    await event(fx, WorkspaceEvents.COMMENT_ADDED, `user:${danaId}`, {
      metadata: { visibility: 'Internal' },
    });
    await event(fx, 'referral.routing_changed', `user:${danaId}`, {
      metadata: { previousDepartment: 'Cardiology', department: 'Neurology' },
    });
    await event(fx, WorkspaceEvents.DOCUMENT_VIEWED, `user:${danaId}`);

    const feed = await getGuestActivityFeed(guest);
    expect(feed.entries.map((e) => e.eventType)).toEqual([
      'referral.received',
      'referral.scheduled',
    ]);
    expect(feed.total).toBe(2);
  });

  it('withholds an internal event type nobody thought to forbid', async () => {
    // THE ALLOW-LIST PROOF. A deny-list would have to have anticipated this
    // name; an allow-list does not.
    const fx = await makeWorkspace();
    const guest = await makeGuest(fx, null);
    await event(fx, 'referral.received', 'system');
    await event(fx, 'workspace.exception_raised_in_some_future_prd', 'system', {
      metadata: { secret: 'INTERNAL-ONLY' },
    });

    const feed = await getGuestActivityFeed(guest);
    expect(feed.total).toBe(1);
    expect(JSON.stringify(feed)).not.toContain('INTERNAL-ONLY');
    expect(JSON.stringify(feed)).not.toContain('exception_raised');
  });

  it('never names which member of staff did something', async () => {
    const fx = await makeWorkspace();
    const guest = await makeGuest(fx, null);
    const danaId = await makeUser('Dana Ruiz');
    await event(fx, 'referral.scheduled', `user:${danaId}`);

    const feed = await getGuestActivityFeed(guest);
    // Which coordinator moved the referral is internal staffing detail; that
    // the organization did is the fact a guest needs.
    expect(feed.entries[0].actorLabel).toBe('The specialist organization');
    expect(JSON.stringify(feed)).not.toContain('Dana');
    expect(JSON.stringify(feed)).not.toContain(`user:${danaId}`);
  });

  it('carries no metadata at all, so nothing can ride along in it', async () => {
    const fx = await makeWorkspace();
    const guest = await makeGuest(fx, null);
    await event(fx, 'referral.scheduled', 'system', {
      metadata: { appointmentLocation: 'Suite 2', internalNote: 'INTERNAL-ONLY' },
    });

    const feed = await getGuestActivityFeed(guest);
    expect(feed.entries[0].metadata).toEqual({});
    expect(JSON.stringify(feed)).not.toContain('INTERNAL-ONLY');
  });

  it('returns an empty feed for a workspace that has gone', async () => {
    const fx = await makeWorkspace();
    const guest = await makeGuest(fx, null);
    await db.delete(workspaceGuests);
    await db.delete(workspaceInvitations);
    await db.delete(workspaceParties);
    await db.delete(referralWorkspaces);
    await expect(getGuestActivityFeed(guest)).resolves.toMatchObject({ total: 0 });
  });
});

describe('reopenReferral() — the audited exception (PRD-25)', () => {
  async function setState(fx: Fixture, state: ReferralState): Promise<void> {
    await db
      .update(referrals)
      .set({ state, updatedAt: new Date() })
      .where(eq(referrals.id, fx.referralId));
  }

  async function stateOf(fx: Fixture): Promise<string> {
    const [row] = await db
      .select({ state: referrals.state })
      .from(referrals)
      .where(eq(referrals.id, fx.referralId));
    return row.state;
  }

  it('uses the state machine for Pending-Information, which is a LEGAL transition', async () => {
    const fx = await makeWorkspace();
    await setState(fx, ReferralState.PENDING_INFORMATION);

    const result = await reopenReferral(fx.referralId, 'user:5', 'information arrived by phone');

    expect(result).toEqual({
      fromState: ReferralState.PENDING_INFORMATION,
      toState: ReferralState.ACKNOWLEDGED,
      // The whole point: no exception was needed here, only for the machine to
      // be asked.
      bypassedStateMachine: false,
    });
    await expect(stateOf(fx)).resolves.toBe(ReferralState.ACKNOWLEDGED);
  });

  it('records the bypass for Declined, which the machine forbids', async () => {
    const fx = await makeWorkspace();
    await setState(fx, ReferralState.DECLINED);
    await db
      .update(referrals)
      .set({ declineReason: 'Payer not in network', clinicianId: 'SYSTEM-SKILL-payer-network-check' })
      .where(eq(referrals.id, fx.referralId));

    const result = await reopenReferral(fx.referralId, 'user:5', 'payer confirmed in network');

    expect(result.bypassedStateMachine).toBe(true);
    await expect(stateOf(fx)).resolves.toBe(ReferralState.ACKNOWLEDGED);

    // The decline reason and the automation recorded against it are cleared:
    // leaving them would attribute a decline to somebody on a live referral.
    const [row] = await db
      .select({ declineReason: referrals.declineReason, clinicianId: referrals.clinicianId })
      .from(referrals)
      .where(eq(referrals.id, fx.referralId));
    expect(row.declineReason).toBeNull();
    expect(row.clinicianId).toBeNull();
  });

  it('writes the bypass into the event so an auditor can find every one', async () => {
    const fx = await makeWorkspace();
    await setState(fx, ReferralState.DECLINED);
    await reopenReferral(fx.referralId, 'user:5', 'payer confirmed');

    const [row] = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.eventType, 'referral.disposition_overridden'));
    expect(row.entityId).toBe(fx.referralId);
    expect(row.fromState).toBe(ReferralState.DECLINED);
    expect(row.toState).toBe(ReferralState.ACKNOWLEDGED);
    const metadata = JSON.parse(row.metadata as string) as Record<string, unknown>;
    // One query finds every terminal-state escape ever made.
    expect(metadata.bypassedStateMachine).toBe(true);
    expect(metadata.reason).toBe('payer confirmed');
  });

  it('does not claim a bypass on the legal path', async () => {
    const fx = await makeWorkspace();
    await setState(fx, ReferralState.PENDING_INFORMATION);
    await reopenReferral(fx.referralId, 'user:5');

    const [row] = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.eventType, 'referral.disposition_overridden'));
    const metadata = JSON.parse(row.metadata as string) as Record<string, unknown>;
    expect(metadata.bypassedStateMachine).toBe(false);
  });

  it('refuses every state it does not exist for, and changes nothing', async () => {
    for (const state of [
      ReferralState.RECEIVED,
      ReferralState.ACKNOWLEDGED,
      ReferralState.ACCEPTED,
      ReferralState.SCHEDULED,
      ReferralState.ENCOUNTER,
      ReferralState.CLOSED,
      ReferralState.CLOSED_CONFIRMED,
    ]) {
      const fx = await makeWorkspace();
      await setState(fx, state);
      await expect(reopenReferral(fx.referralId, 'user:5')).rejects.toThrow(NotReopenableError);
      // A refused reopen is not a silent write.
      await expect(stateOf(fx)).resolves.toBe(state);
    }
  });

  it('refuses an unknown referral', async () => {
    await expect(reopenReferral(99999, 'user:5')).rejects.toThrow(NotReopenableError);
  });

  it('is the ONLY module that writes a state the machine forbids', () => {
    // A structural assertion, because the value of the exception is that it is
    // the only one. If a second appears, this PRD's central claim is false.
    const root = path.resolve(__dirname, '../../../src');
    // Scoped to TypeScript: a view cannot write to the database, and
    // referralReview.html carries `state: 'Acknowledged'` as a timeline step
    // label. Matching it would make this assertion noise rather than a check.
    const hits = execSync(
      `grep -rln --include=*.ts "state: ReferralState.ACKNOWLEDGED\\|state: 'Acknowledged'" ${root} || true`,
      { encoding: 'utf-8' },
    )
      .split('\n')
      .filter(Boolean)
      .map((f) => path.basename(f))
      .sort();

    // dispositionOverride owns the exception. pendingInfoChecker writes the same
    // state but calls transition() first, which PRD-25 fixed.
    expect(hits).toEqual(['dispositionOverride.ts', 'pendingInfoChecker.ts']);
  });
});
