/**
 * Unit tests for partyService.ts (PRD-24)
 *
 * The weight is on two things:
 *
 *   - the THREE-STEP lookup, and the difference between its steps. An exact
 *     match identifies a party; a domain match only infers one. Collapsing that
 *     distinction is how PRD-29 would end up replying to an address nobody has
 *     confirmed, so `matchedOn` is asserted separately for each step.
 *   - the BACKFILL re-deriving rather than skipping. PRD-18's first backfill
 *     skipped workspaces it had already seen and left all hundred seeded ones
 *     stuck in Triage. The same shape of bug here would leave every existing
 *     workspace with an empty parties panel, so it is asserted directly.
 */

jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct', orgName: 'Specialist Care Group' },
    database: { url: ':memory:' },
  },
}));

jest.mock('../../../src/db', () => {
  const Database = require('better-sqlite3');
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const schema = require('../../../src/db/schema');

  const sqlite = new Database(':memory:');
  sqlite.exec(require('../../helpers/testSchema').TEST_SCHEMA_DDL);
  return { db: drizzle(sqlite, { schema }), sqlite };
});

import { db } from '../../../src/db';
import {
  partyAddresses,
  patients,
  referralMessages,
  referralWorkspaces,
  referrals,
  workflowEvents,
  workspaceParties,
} from '../../../src/db/schema';
import { ReferralState } from '../../../src/state/referralStateMachine';
import { WorkStatus } from '../../../src/state/workStatusMachine';
import {
  AddressAlreadyClaimedError,
  NoDirectAddressError,
  PartyNotFoundError,
  backfillParties,
  domainOf,
  findPartyByDirectAddress,
  getParties,
  provisionalOrgName,
  recordPartyAddress,
  seedParties,
  setProtocolMode,
  updateParty,
} from '../../../src/modules/workspace/partyService';

let patientId: number;
let seq = 0;

beforeAll(async () => {
  const [patient] = await db
    .insert(patients)
    .values({ firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1815-12-10' })
    .returning();
  patientId = patient.id;
});

beforeEach(async () => {
  await db.delete(partyAddresses);
  await db.delete(workspaceParties);
  await db.delete(referralMessages);
  await db.delete(workflowEvents);
  await db.delete(referralWorkspaces);
  await db.delete(referrals);
});

async function makeWorkspace(
  referrerAddress = 'Referrals@Lakeside.Direct',
): Promise<{ workspaceId: number; referralId: number }> {
  const [referral] = await db
    .insert(referrals)
    .values({
      patientId,
      sourceMessageId: `party-${++seq}-${Date.now()}`,
      referrerAddress,
      state: ReferralState.ACKNOWLEDGED,
      routingDepartment: 'Cardiology',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const [workspace] = await db
    .insert(referralWorkspaces)
    .values({
      referralId: referral.id,
      workStatus: WorkStatus.TRIAGE,
      workStatusIsManual: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  return { workspaceId: workspace.id, referralId: referral.id };
}

async function insertInboundMessage(referralId: number, senderAddress: string): Promise<number> {
  const [row] = await db
    .insert(referralMessages)
    .values({
      referralId,
      direction: 'inbound',
      messageType: 'InfoReply',
      summary: 'test',
      senderAddress,
      createdAt: new Date(),
    })
    .returning();
  return row.id;
}

/** emitEvent is fire-and-forget, so let the microtask queue drain. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

const events = async (): Promise<string[]> =>
  (await db.select().from(workflowEvents)).map((e) => e.eventType);

describe('domainOf() and provisionalOrgName()', () => {
  it('extracts the domain, lowercased', () => {
    expect(domainOf('ECHen@Lakeside.Direct')).toBe('lakeside.direct');
  });

  it('returns null for every shape of unusable address', () => {
    // The empty string is the reachable one: messageProcessor defaults an
    // unparseable From header to '', and referrer_address is NOT NULL, so ''
    // rather than null is what a malformed address actually looks like.
    expect(domainOf('')).toBeNull();
    expect(domainOf('no-at-sign')).toBeNull();
    expect(domainOf('trailing@')).toBeNull();
    expect(domainOf(null)).toBeNull();
    expect(domainOf(undefined)).toBeNull();
  });

  it('names a party after its domain, not a prettified guess', () => {
    // A fabricated name should look like a fallback, because it is also flagged
    // unverified; a plausible-looking invention would undermine the flag.
    expect(provisionalOrgName('referrals@lakeside-cardiology.direct')).toBe(
      'lakeside-cardiology.direct',
    );
  });
});

describe('seedParties()', () => {
  it('creates an initiating party from the referrer address and a receiving one from config', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);

    const parties = await getParties(workspaceId);
    expect(parties.map((p) => p.partyRole)).toEqual(['initiating', 'receiving']);
    expect(parties[0].directAddress).toBe('Referrals@Lakeside.Direct');
    expect(parties[1].directAddress).toBe('receiving@specialist.direct');
  });

  it('names the receiving party from config and marks it verified', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);

    const receiving = (await getParties(workspaceId)).find((p) => p.partyRole === 'receiving');
    // We know who we are. Guessing our own name from our own domain, then
    // flagging it unverified, would be absurd.
    expect(receiving!.orgName).toBe('Specialist Care Group');
    expect(receiving!.orgNameVerified).toBe(true);
  });

  it('falls back to the domain for the initiating party and does not claim it is verified', async () => {
    const { workspaceId, referralId } = await makeWorkspace('intake@riverside-ortho.direct');
    await seedParties(workspaceId, referralId);

    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating');
    expect(initiating!.orgName).toBe('riverside-ortho.direct');
    expect(initiating!.orgNameVerified).toBe(false);
  });

  it('records each intake address as a known address', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);

    const parties = await getParties(workspaceId);
    expect(parties[0].addresses.map((a) => a.addressKind)).toEqual(['intake']);
    expect(parties[0].addresses[0].address).toBe('Referrals@Lakeside.Direct');
  });

  it('starts a party with no address at local-only', async () => {
    const { workspaceId, referralId } = await makeWorkspace('');
    await seedParties(workspaceId, referralId);

    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating');
    expect(initiating!.directAddress).toBeNull();
    expect(initiating!.protocolMode).toBe('local-only');
    expect(initiating!.addresses).toEqual([]);
  });

  it('starts a party WITH an address at workspace-mediated, not native-360x', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);

    // Assuming the other side speaks 360X before any exchange has proved it
    // would display a capability nobody has observed.
    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating');
    expect(initiating!.protocolMode).toBe('workspace-mediated');
    expect(initiating!.capabilityVerifiedAt).toBeNull();
  });

  it('is idempotent — a second run leaves two parties, not four', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);
    await seedParties(workspaceId, referralId);

    expect(await getParties(workspaceId)).toHaveLength(2);
  });

  it('survives both sides sharing one address, as a loopback demo does', async () => {
    const { workspaceId, referralId } = await makeWorkspace('receiving@specialist.direct');
    await seedParties(workspaceId, referralId);

    // The unique index would reject the second claim, so the seed must not try.
    const parties = await getParties(workspaceId);
    expect(parties).toHaveLength(2);
    expect(parties.flatMap((p) => p.addresses)).toHaveLength(1);
  });

  it('orders parties initiating, receiving, other', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);
    await db.insert(workspaceParties).values({
      workspaceId,
      orgName: 'Observer Health Plan',
      orgNameVerified: true,
      directAddress: null,
      partyRole: 'other',
      protocolMode: 'local-only',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect((await getParties(workspaceId)).map((p) => p.partyRole)).toEqual([
      'initiating',
      'receiving',
      'other',
    ]);
  });
});

describe('findPartyByDirectAddress()', () => {
  let workspaceId: number;
  let referralId: number;

  beforeEach(async () => {
    ({ workspaceId, referralId } = await makeWorkspace());
    await seedParties(workspaceId, referralId);
  });

  it('matches the canonical intake address regardless of case', async () => {
    const match = await findPartyByDirectAddress(workspaceId, 'referrals@LAKESIDE.direct');
    expect(match!.matchedOn).toBe('intake');
    expect(match!.party.partyRole).toBe('initiating');
  });

  it('matches an address learned from a message', async () => {
    const messageId = await insertInboundMessage(referralId, 'e.chen@lakeside.direct');
    await recordPartyAddress(workspaceId, 'e.chen@lakeside.direct', messageId);

    const match = await findPartyByDirectAddress(workspaceId, 'E.Chen@Lakeside.Direct');
    expect(match!.matchedOn).toBe('known-address');
    expect(match!.party.partyRole).toBe('initiating');
  });

  it('falls back to the domain for an address never seen before', async () => {
    // This is the case the whole child table exists for: without it, a
    // follow-up from a departmental address raises a correlation exception
    // instead of landing on the right workspace.
    const match = await findPartyByDirectAddress(workspaceId, 'cardiology@lakeside.direct');
    expect(match!.matchedOn).toBe('domain');
    expect(match!.party.partyRole).toBe('initiating');
  });

  it('reports a domain match as an inference, distinct from an exact one', async () => {
    const exact = await findPartyByDirectAddress(workspaceId, 'referrals@lakeside.direct');
    const inferred = await findPartyByDirectAddress(workspaceId, 'anyone@lakeside.direct');

    // Both resolve to the same party, and that is precisely why the caller
    // needs to be able to tell them apart — PRD-29 replies to one, not the other.
    expect(exact!.party.id).toBe(inferred!.party.id);
    expect(exact!.matchedOn).toBe('intake');
    expect(inferred!.matchedOn).toBe('domain');
  });

  it('returns null for a domain belonging to nobody on this workspace', async () => {
    expect(await findPartyByDirectAddress(workspaceId, 'someone@unrelated.example')).toBeNull();
  });

  it('returns null for an unusable address rather than guessing', async () => {
    expect(await findPartyByDirectAddress(workspaceId, '')).toBeNull();
    expect(await findPartyByDirectAddress(workspaceId, 'no-at-sign')).toBeNull();
  });

  it('does not leak across workspaces', async () => {
    const other = await makeWorkspace('intake@somewhere-else.direct');
    await seedParties(other.workspaceId, other.referralId);

    expect(await findPartyByDirectAddress(other.workspaceId, 'referrals@lakeside.direct')).toBeNull();
  });
});

describe('recordPartyAddress()', () => {
  let workspaceId: number;
  let referralId: number;

  beforeEach(async () => {
    ({ workspaceId, referralId } = await makeWorkspace());
    await seedParties(workspaceId, referralId);
  });

  it('files a new address against the matching party and emits', async () => {
    const messageId = await insertInboundMessage(referralId, 'nurse@lakeside.direct');
    await recordPartyAddress(workspaceId, 'nurse@lakeside.direct', messageId);
    await flush();

    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating');
    expect(initiating!.addresses.map((a) => a.address)).toContain('nurse@lakeside.direct');
    expect(await events()).toContain('workspace.party_address_observed');
  });

  it('is a no-op for an address already on file, and emits nothing', async () => {
    await recordPartyAddress(workspaceId, 'Referrals@Lakeside.Direct', null);
    await flush();

    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating');
    expect(initiating!.addresses).toHaveLength(1);
    expect(await events()).not.toContain('workspace.party_address_observed');
  });

  it('treats a case variant as the same address, not a new one', async () => {
    await recordPartyAddress(workspaceId, 'REFERRALS@lakeside.DIRECT', null);

    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating');
    expect(initiating!.addresses).toHaveLength(1);
    // Stored as originally received, so the audit record keeps the real form.
    expect(initiating!.addresses[0].address).toBe('Referrals@Lakeside.Direct');
  });

  it('drops an address belonging to no party rather than raising', async () => {
    // A message from a stranger must not fail the thread write recording it;
    // correlating unknown senders is PRD-28's job.
    await expect(
      recordPartyAddress(workspaceId, 'stranger@nowhere.example', null),
    ).resolves.toBeUndefined();

    const all = await db.select().from(partyAddresses);
    expect(all.map((a) => a.address)).not.toContain('stranger@nowhere.example');
  });

  it('ignores an empty address', async () => {
    await recordPartyAddress(workspaceId, '', null);
    expect(await db.select().from(partyAddresses)).toHaveLength(2);
  });
});

describe('setProtocolMode()', () => {
  it('refuses any mode but local-only on a party with no address', async () => {
    const { workspaceId, referralId } = await makeWorkspace('');
    await seedParties(workspaceId, referralId);
    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating')!;

    await expect(setProtocolMode(initiating.id, 'native-360x', 'user:1')).rejects.toThrow(
      NoDirectAddressError,
    );
  });

  it('records who set it, and emits with both modes', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);
    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating')!;

    const updated = await setProtocolMode(initiating.id, 'native-360x', 'user:4');
    await flush();

    expect(updated.protocolMode).toBe('native-360x');
    expect(updated.protocolModeSetBy).toBe('user:4');

    const [event] = (await db.select().from(workflowEvents)).filter(
      (e) => e.eventType === 'workspace.protocol_mode_changed',
    );
    expect(event.fromState).toBe('workspace-mediated');
    expect(event.toState).toBe('native-360x');
  });

  it('is a silent no-op when the mode is already set', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);
    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating')!;

    await setProtocolMode(initiating.id, 'workspace-mediated', 'user:1');
    await flush();

    expect(await events()).not.toContain('workspace.protocol_mode_changed');
  });

  it('throws for a party that does not exist', async () => {
    await expect(setProtocolMode(99999, 'local-only', 'user:1')).rejects.toThrow(PartyNotFoundError);
  });
});

describe('updateParty()', () => {
  it('marks a name a person typed as verified', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);
    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating')!;

    const updated = await updateParty(initiating.id, { orgName: 'Lakeside Cardiology' }, 'user:2');

    // Somebody asserted it, which is exactly what verified means here.
    expect(updated.orgName).toBe('Lakeside Cardiology');
    expect(updated.orgNameVerified).toBe(true);
  });

  it('files a newly set intake address as a known address', async () => {
    const { workspaceId, referralId } = await makeWorkspace('');
    await seedParties(workspaceId, referralId);
    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating')!;

    const updated = await updateParty(initiating.id, { directAddress: 'new@lakeside.direct' }, 'user:2');
    expect(updated.addresses.map((a) => a.address)).toContain('new@lakeside.direct');
  });

  it('refuses an address already claimed by the other party on this workspace', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);
    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating')!;

    await expect(
      updateParty(initiating.id, { directAddress: 'receiving@specialist.direct' }, 'user:2'),
    ).rejects.toThrow(AddressAlreadyClaimedError);
  });

  it('emits a from/to pair so the change is reviewable', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);
    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating')!;

    await updateParty(initiating.id, { orgName: 'Lakeside Cardiology' }, 'user:2');
    await flush();

    const [event] = (await db.select().from(workflowEvents)).filter(
      (e) => e.eventType === 'workspace.party_updated',
    );
    expect(event.actor).toBe('user:2');
    expect(JSON.parse(event.metadata!).orgName).toEqual({
      from: 'lakeside.direct',
      to: 'Lakeside Cardiology',
    });
  });
});

describe('backfillParties()', () => {
  it('seeds a workspace that has none', async () => {
    await makeWorkspace();
    const result = await backfillParties();

    expect(result.created).toBe(1);
  });

  it('RE-DERIVES a workspace it has already seen rather than skipping it', async () => {
    // The PRD-18 backfill defect, asserted directly: it took a `continue` path
    // for existing workspaces, so all hundred seeded ones stayed in Triage. The
    // equivalent here would leave a half-seeded workspace permanently missing a
    // party, and the panel would read "Unknown organization" forever.
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);
    await db
      .delete(workspaceParties)
      .where(eqParty(workspaceId, 'receiving'));

    expect(await getParties(workspaceId)).toHaveLength(1);

    const result = await backfillParties();

    expect(await getParties(workspaceId)).toHaveLength(2);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('reports a complete workspace as skipped and changes nothing', async () => {
    const { workspaceId, referralId } = await makeWorkspace();
    await seedParties(workspaceId, referralId);

    const result = await backfillParties();

    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
    expect(await getParties(workspaceId)).toHaveLength(2);
  });

  it('recovers observed addresses from existing message history', async () => {
    // sender_address has been recorded on every inbound message all along, so a
    // backfilled workspace can know what a live one would have learned.
    const { workspaceId, referralId } = await makeWorkspace();
    await insertInboundMessage(referralId, 'dept.cardio@lakeside.direct');
    await insertInboundMessage(referralId, 'e.chen@lakeside.direct');

    await backfillParties();

    const initiating = (await getParties(workspaceId)).find((p) => p.partyRole === 'initiating')!;
    expect(initiating.addresses.map((a) => a.address)).toEqual(
      expect.arrayContaining(['dept.cardio@lakeside.direct', 'e.chen@lakeside.direct']),
    );
  });

  it('is safe to run twice', async () => {
    const { workspaceId } = await makeWorkspace();
    await backfillParties();
    await backfillParties();

    expect(await getParties(workspaceId)).toHaveLength(2);
  });

  it('leaves archived workspaces alone', async () => {
    const { workspaceId } = await makeWorkspace();
    await db
      .update(referralWorkspaces)
      .set({ archivedAt: new Date() })
      .where(eqWorkspace(workspaceId));

    const result = await backfillParties();

    expect(result.created).toBe(0);
    expect(await getParties(workspaceId)).toHaveLength(0);
  });
});

// Small helpers kept at the bottom so the tests above read as prose.
function eqParty(workspaceId: number, role: string) {
  const { and, eq } = require('drizzle-orm');
  return and(eq(workspaceParties.workspaceId, workspaceId), eq(workspaceParties.partyRole, role));
}

function eqWorkspace(workspaceId: number) {
  const { eq } = require('drizzle-orm');
  return eq(referralWorkspaces.id, workspaceId);
}
