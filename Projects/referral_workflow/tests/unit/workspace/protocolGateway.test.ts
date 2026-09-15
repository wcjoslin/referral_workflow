/**
 * Unit tests for assertionCatalog.ts and protocolGateway.ts (PRD-29)
 *
 * The invariants that carry the weight:
 *
 *   - EVERY CATALOG TRANSITION IS LEGAL IN THE STATE MACHINE. This is asserted
 *     as a property over the whole catalog rather than case by case, and it
 *     already caught a real problem: the PRD specified `cancel` as "any
 *     non-terminal → Declined", but three of those five transitions throw. The
 *     catalog was narrowed to what the machine permits rather than the machine
 *     widened to suit the catalog.
 *   - AUTHORIZATION IS BY PARTY ROLE, and the surface derives from the same
 *     catalog the gateway enforces, so they cannot disagree.
 *   - AN INVALID ASSERTION PRODUCES NO ARTIFACT. Asserted by counting rows, not
 *     by trusting the thrown error.
 *   - IDEMPOTENCY IS REAL. A replayed key emits one artifact, not two.
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
      // Overridden per-test where the individual branch is under test.
      senderIdentityMode: 'organization',
    },
  },
}));

const sendMailMock = jest.fn().mockResolvedValue(true);
jest.mock('../../../src/modules/messaging/mailer', () => ({
  sendMail: (...args: unknown[]) => sendMailMock(...args),
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
import { config } from '../../../src/config';
import {
  partyAddresses,
  patients,
  referralMessages,
  referralWorkspaces,
  referrals,
  users,
  workflowEvents,
  workspaceAssertions,
  workspaceParties,
} from '../../../src/db/schema';
import { ReferralState, transition } from '../../../src/state/referralStateMachine';
import { WorkStatus } from '../../../src/state/workStatusMachine';
import {
  ASSERTION_CATALOG,
  ASSERTION_TYPES,
  availableAssertions,
  isAssertionType,
  missingContext,
} from '../../../src/modules/workspace/assertionCatalog';
import {
  AssertionNotAvailableError,
  AssertionNotPermittedError,
  MissingAssertionContextError,
  PartyNotOnWorkspaceError,
  getAssertions,
  submitAssertion,
  transmitPending,
} from '../../../src/modules/workspace/protocolGateway';
import { buildAck } from '../../../src/modules/prd06/ackBuilder';
import { parseAck } from '../../../src/modules/prd06/ackParser';

let seq = 0;
let userId: number;

/**
 * Flips the sender-identity mode for a test.
 *
 * `config.workspace.senderIdentityMode` is a narrowed literal union on the real
 * config, so it reads as read-only here. The cast is confined to this one
 * helper rather than repeated at every call site.
 */
function setSenderMode(mode: 'individual' | 'organization'): void {
  (config.workspace as unknown as { senderIdentityMode: string }).senderIdentityMode = mode;
}

interface Fixture {
  workspaceId: number;
  referralId: number;
  initiatingPartyId: number;
  receivingPartyId: number;
}

beforeEach(async () => {
  sendMailMock.mockClear();
  sendMailMock.mockResolvedValue(true);
  setSenderMode('organization');

  await db.delete(workspaceAssertions);
  await db.delete(partyAddresses);
  await db.delete(workspaceParties);
  await db.delete(referralMessages);
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
  userId = user.id;
});

async function makeWorkspace(
  state: ReferralState = ReferralState.ACKNOWLEDGED,
  counterpartyAddress: string | null = 'referrals@lakeside.direct',
): Promise<Fixture> {
  const [patient] = await db
    .insert(patients)
    .values({ firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1815-12-10' })
    .returning();

  const [referral] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      sourceMessageId: `gw-${++seq}-${Date.now()}`,
      referrerAddress: counterpartyAddress ?? '',
      reasonForReferral: 'Chest pain on exertion',
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
      workStatus: WorkStatus.TRIAGE,
      workStatusIsManual: false,
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
      directAddress: counterpartyAddress,
      partyRole: 'initiating',
      protocolMode: counterpartyAddress ? 'workspace-mediated' : 'local-only',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const [receiving] = await db
    .insert(workspaceParties)
    .values({
      workspaceId: workspace.id,
      orgName: 'Specialist Care Group',
      orgNameVerified: true,
      directAddress: 'receiving@specialist.direct',
      partyRole: 'receiving',
      protocolMode: 'workspace-mediated',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return {
    workspaceId: workspace.id,
    referralId: referral.id,
    initiatingPartyId: initiating.id,
    receivingPartyId: receiving.id,
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const events = async (): Promise<string[]> =>
  (await db.select().from(workflowEvents)).map((e) => e.eventType);

const stateOf = async (referralId: number): Promise<string> =>
  (await db.select({ state: referrals.state }).from(referrals).where(eq(referrals.id, referralId)))[0]
    .state;

let keyCounter = 0;
const key = (): string => `key-${++keyCounter}`;

// ── The catalog ───────────────────────────────────────────────────────────────

describe('assertionCatalog', () => {
  it('declares every transition as one the state machine actually permits', () => {
    // A PROPERTY over the whole catalog, not a case-by-case check. This caught
    // the PRD specifying `cancel` from Received, Accepted and Scheduled, all of
    // which throw — so the catalog was narrowed rather than the machine widened.
    const illegal: string[] = [];
    for (const type of ASSERTION_TYPES) {
      const spec = ASSERTION_CATALOG[type];
      if (spec.toState === null) continue;
      for (const from of spec.fromStates) {
        try {
          transition(from, spec.toState);
        } catch {
          illegal.push(`${type}: ${from} -> ${spec.toState}`);
        }
      }
    }
    expect(illegal).toEqual([]);
  });

  it('keeps cancel to the two states the machine permits, and records why', () => {
    // Pinned deliberately. If somebody widens this they have to come past the
    // property test above, which is the point.
    expect(ASSERTION_CATALOG.cancel.fromStates).toEqual([
      ReferralState.ACKNOWLEDGED,
      ReferralState.PENDING_INFORMATION,
    ]);
  });

  it('never offers an assertion to a party role it does not permit', () => {
    for (const state of Object.values(ReferralState)) {
      for (const role of ['initiating', 'receiving', 'other'] as const) {
        for (const spec of availableAssertions(state, role)) {
          expect(spec.permittedRoles).toContain(role);
          expect(spec.fromStates).toContain(state);
        }
      }
    }
  });

  it('gives an observer party nothing to assert, in any state', () => {
    // A payer contact is on the workspace to see it, not to move the protocol.
    for (const state of Object.values(ReferralState)) {
      expect(availableAssertions(state, 'other')).toEqual([]);
    }
  });

  it("splits the roles so neither side can do the other side's job", () => {
    expect(ASSERTION_CATALOG.accept.permittedRoles).toEqual(['receiving']);
    expect(ASSERTION_CATALOG.cancel.permittedRoles).toEqual(['initiating']);
    expect(ASSERTION_CATALOG['acknowledge-outcome'].permittedRoles).toEqual(['initiating']);
    expect(ASSERTION_CATALOG['final-outcome'].permittedRoles).toEqual(['receiving']);
  });

  it('labels every assertion in language that mentions no protocol acronym', () => {
    // A guest who knows no HL7 has to be able to act on these.
    for (const type of ASSERTION_TYPES) {
      const spec = ASSERTION_CATALOG[type];
      expect(spec.label).not.toMatch(/RRI|SIU|C-CDA|CCDA|MDN|HL7|ACK/);
      expect(spec.description.length).toBeGreaterThan(20);
    }
  });

  it('treats a blank required field as missing', () => {
    // A decline whose reason is three spaces is a decline with no reason.
    expect(missingContext('decline', { reason: '   ' })).toEqual(['reason']);
    expect(missingContext('decline', {})).toEqual(['reason']);
    expect(missingContext('decline', { reason: 'Out of network' })).toEqual([]);
  });

  it('recognises only known assertion types', () => {
    expect(isAssertionType('accept')).toBe(true);
    expect(isAssertionType('elope')).toBe(false);
  });
});

describe('buildAck round-trips against parseAck', () => {
  it('produces a message its own parser reads back identically', () => {
    // The justification for adding a builder at all: this is stronger than
    // validating against a sample message.
    const opts = {
      messageControlId: 'ctrl-1',
      acknowledgedControlId: 'ctrl-0',
      ackCode: 'AA' as const,
      sendingFacility: 'a@b.direct',
      receivingFacility: 'c@d.direct',
    };
    expect(parseAck(buildAck(opts))).toEqual({
      ackCode: 'AA',
      acknowledgedControlId: 'ctrl-0',
      messageControlId: 'ctrl-1',
    });
  });

  it('survives HL7 delimiters in the free-text field', () => {
    const parsed = parseAck(
      buildAck({
        messageControlId: 'c1',
        acknowledgedControlId: 'c0',
        ackCode: 'AE',
        sendingFacility: 'a@b.direct',
        receivingFacility: 'c@d.direct',
        textMessage: 'pipes | carets ^ and ampersands &',
      }),
    );
    // An unescaped pipe would shift every following field; parseAck reads by
    // position, so it would come back wrong rather than crash.
    expect(parsed.acknowledgedControlId).toBe('c0');
    expect(parsed.ackCode).toBe('AE');
  });
});

// ── Authorization ─────────────────────────────────────────────────────────────

describe('submitAssertion() authorization', () => {
  it('refuses an assertion the asserting party role may not make', async () => {
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);

    // The INITIATING party trying to accept its own referral.
    await expect(
      submitAssertion({
        workspaceId: f.workspaceId,
        assertionKey: key(),
        assertionType: 'accept',
        partyId: f.initiatingPartyId,
        actor: `user:${userId}`,
      }),
    ).rejects.toThrow(AssertionNotPermittedError);
  });

  it('refuses an assertion unavailable from the current protocol state', async () => {
    const f = await makeWorkspace(ReferralState.RECEIVED);

    await expect(
      submitAssertion({
        workspaceId: f.workspaceId,
        assertionKey: key(),
        assertionType: 'accept',
        partyId: f.receivingPartyId,
        actor: `user:${userId}`,
      }),
    ).rejects.toThrow(AssertionNotAvailableError);
  });

  it('PRODUCES NO ARTIFACT when it refuses', async () => {
    const f = await makeWorkspace(ReferralState.RECEIVED);

    await expect(
      submitAssertion({
        workspaceId: f.workspaceId,
        assertionKey: key(),
        assertionType: 'accept',
        partyId: f.receivingPartyId,
        actor: `user:${userId}`,
      }),
    ).rejects.toThrow();

    // Counted rather than inferred from the thrown error: validate-before-render
    // is only true if nothing was written.
    expect(await db.select().from(workspaceAssertions)).toHaveLength(0);
    expect(await db.select().from(referralMessages)).toHaveLength(0);
    expect(await stateOf(f.referralId)).toBe(ReferralState.RECEIVED);
  });

  it('refuses a party that is not on this workspace', async () => {
    const f = await makeWorkspace();
    const other = await makeWorkspace();

    await expect(
      submitAssertion({
        workspaceId: f.workspaceId,
        assertionKey: key(),
        assertionType: 'accept',
        partyId: other.receivingPartyId,
        actor: `user:${userId}`,
      }),
    ).rejects.toThrow(PartyNotOnWorkspaceError);
  });

  it('refuses when required context is missing, naming what is missing', async () => {
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);

    await expect(
      submitAssertion({
        workspaceId: f.workspaceId,
        assertionKey: key(),
        assertionType: 'decline',
        partyId: f.receivingPartyId,
        actor: `user:${userId}`,
        context: {},
      }),
    ).rejects.toThrow(MissingAssertionContextError);

    expect(await db.select().from(workspaceAssertions)).toHaveLength(0);
  });
});

// ── Rendering and the protocol ────────────────────────────────────────────────

describe('submitAssertion() rendering', () => {
  it('renders an accept through the real RRI builder and advances the state', async () => {
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);

    const result = await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });

    expect(result.toState).toBe(ReferralState.ACCEPTED);
    expect(await stateOf(f.referralId)).toBe(ReferralState.ACCEPTED);

    const [msg] = await db.select().from(referralMessages);
    // A real RRI, not a hand-built string: MSH and MSA segments with AA.
    expect(msg.messageType).toBe('RRI');
    expect(msg.contentHl7).toContain('MSH|');
    expect(msg.contentHl7).toContain('MSA|AA');
  });

  it('renders a decline with the reason inside the artifact', async () => {
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'decline',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
      context: { reason: 'Out of network for this plan' },
    });

    const [msg] = await db.select().from(referralMessages);
    expect(msg.contentHl7).toContain('MSA|AR');
    expect(msg.contentHl7).toContain('Out of network');
    expect(await stateOf(f.referralId)).toBe(ReferralState.DECLINED);
  });

  it('renders a consult note as C-CDA XML and closes the referral', async () => {
    const f = await makeWorkspace(ReferralState.ENCOUNTER);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'final-outcome',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
      context: { assessment: 'Stable angina, medical management', plan: 'Review in 3 months' },
    });

    const [msg] = await db.select().from(referralMessages);
    expect(msg.messageType).toBe('ConsultNote');
    expect(msg.contentXml).toContain('ClinicalDocument');
    expect(msg.contentXml).toContain('Stable angina');
    expect(await stateOf(f.referralId)).toBe(ReferralState.CLOSED);
  });

  it('renders an SIU for a scheduling assertion', async () => {
    const f = await makeWorkspace(ReferralState.ACCEPTED);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'scheduled',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
      context: { appointmentDate: '2026-10-22T14:30:00Z', location: 'Cardiology Suite 2' },
    });

    const [msg] = await db.select().from(referralMessages);
    expect(msg.messageType).toBe('SIU');
    expect(msg.contentHl7).toContain('SCH|');
    expect(msg.contentHl7).toContain('Cardiology Suite 2');
    expect(await stateOf(f.referralId)).toBe(ReferralState.SCHEDULED);
  });

  it('closes the loop with an ACK the parser can read', async () => {
    const f = await makeWorkspace(ReferralState.CLOSED);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'acknowledge-outcome',
      partyId: f.initiatingPartyId,
      actor: `user:${userId}`,
    });

    const [msg] = await db.select().from(referralMessages);
    expect(msg.messageType).toBe('ACK');
    expect(parseAck(msg.contentHl7 as string).ackCode).toBe('AA');
    expect(await stateOf(f.referralId)).toBe(ReferralState.CLOSED_CONFIRMED);
  });

  it('leaves the protocol state alone for an assertion that has no transition', async () => {
    const f = await makeWorkspace(ReferralState.ACCEPTED);

    const result = await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'interim-update',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
      context: { note: 'Awaiting the echo report' },
    });

    expect(result.toState).toBeNull();
    expect(await stateOf(f.referralId)).toBe(ReferralState.ACCEPTED);
    // Still recorded and still sent: an update is a real message.
    expect(await db.select().from(referralMessages)).toHaveLength(1);
  });

  it('stores the artifact BEFORE attempting delivery, so a failure loses nothing', async () => {
    sendMailMock.mockResolvedValue(false);
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });
    await flush();

    const [assertion] = await db.select().from(workspaceAssertions);
    expect(assertion.artifactMessageId).not.toBeNull();
    expect(assertion.deliveryStatus).toBe('Failed');
    // The record survives the failure, and the state still moved.
    expect(await db.select().from(referralMessages)).toHaveLength(1);
    expect(await stateOf(f.referralId)).toBe(ReferralState.ACCEPTED);
  });

  it('raises a delivery failure for PRD-28 without touching the party mode', async () => {
    sendMailMock.mockResolvedValue(false);
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });
    await flush();

    expect(await events()).toContain('workspace.artifact_delivery_failed');
    // A bounced message says nothing about what the other side can parse.
    const [party] = await db
      .select()
      .from(workspaceParties)
      .where(eq(workspaceParties.id, f.initiatingPartyId));
    expect(party.capabilityVerifiedAt).toBeNull();
    expect(party.protocolMode).toBe('workspace-mediated');
  });

  it('marks the party capability verified after a real successful exchange', async () => {
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });
    await flush();

    const [party] = await db
      .select()
      .from(workspaceParties)
      .where(eq(workspaceParties.id, f.initiatingPartyId));
    expect(party.capabilityVerifiedAt).not.toBeNull();
    expect(await events()).toContain('workspace.capability_verified');
  });
});

// ── local-only ────────────────────────────────────────────────────────────────

describe('a counterparty with no Direct address', () => {
  it('still validates, renders, stores and advances — marked local-only', async () => {
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED, null);

    const result = await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });
    await flush();

    expect(result.deliveryMode).toBe('local-only');
    expect(result.deliveryStatus).toBe('Not-Transmitted');
    expect(result.artifactMessageId).not.toBeNull();
    expect(await stateOf(f.referralId)).toBe(ReferralState.ACCEPTED);
    // A missing address must not stop the workflow.
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(await events()).toContain('workspace.artifact_not_transmitted');
  });

  it('transmits a local-only artifact only when explicitly asked', async () => {
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED, null);
    const submitted = await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });
    await flush();
    expect(sendMailMock).not.toHaveBeenCalled();

    // An address arrives later.
    await db
      .update(workspaceParties)
      .set({ directAddress: 'referrals@lakeside.direct' })
      .where(eq(workspaceParties.id, f.initiatingPartyId));

    // Nothing is sent by that alone — silently mailing a batch of old artifacts
    // the moment somebody fills in a field would be a surprise with PHI in it.
    expect(sendMailMock).not.toHaveBeenCalled();

    const result = await transmitPending(submitted.assertionId, `user:${userId}`);
    await flush();

    expect(result.deliveryMode).toBe('transmitted');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('emits ONE artifact for a replayed assertion key', async () => {
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);
    const k = key();

    const first = await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: k,
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });
    const second = await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: k,
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });
    await flush();

    expect(second.idempotentReplay).toBe(true);
    expect(second.assertionId).toBe(first.assertionId);
    expect(await db.select().from(workspaceAssertions)).toHaveLength(1);
    expect(await db.select().from(referralMessages)).toHaveLength(1);
  });

  it('replays without re-transitioning the protocol state', async () => {
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);
    const k = key();

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: k,
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });
    // A second transition Accepted -> Accepted would throw if it were attempted.
    await expect(
      submitAssertion({
        workspaceId: f.workspaceId,
        assertionKey: k,
        assertionType: 'accept',
        partyId: f.receivingPartyId,
        actor: `user:${userId}`,
      }),
    ).resolves.toMatchObject({ idempotentReplay: true });
    expect(await stateOf(f.referralId)).toBe(ReferralState.ACCEPTED);
  });
});

// ── Sender identity ───────────────────────────────────────────────────────────

describe('senderIdentityMode', () => {
  it('uses the organizational address under the default mode', async () => {
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });

    const [assertion] = await db.select().from(workspaceAssertions);
    expect(assertion.sentFromAddress).toBe('receiving@specialist.direct');
  });

  it("uses the acting user's own address under individual mode", async () => {
    setSenderMode('individual');
    await db
      .update(users)
      .set({ directAddress: 'echen@specialist.direct' })
      .where(eq(users.id, userId));
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });

    const [assertion] = await db.select().from(workspaceAssertions);
    expect(assertion.sentFromAddress).toBe('echen@specialist.direct');
    // The HL7 sender field carries it too, not just the audit row.
    const [msg] = await db.select().from(referralMessages);
    expect(msg.contentHl7).toContain('echen@specialist.direct');
  });

  it('falls back to the organizational address for a user who has none', async () => {
    // Dr. Sarah Kim has no individual address in the seed roster on purpose,
    // which is the case this exercises.
    setSenderMode('individual');
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });

    const [assertion] = await db.select().from(workspaceAssertions);
    expect(assertion.sentFromAddress).toBe('receiving@specialist.direct');
  });

  it("resolves a guest to their own party's address regardless of the mode", async () => {
    // The setting is about our staff. Applying it to a counterparty would be
    // meaningless, so a guest is unaffected by it either way.
    setSenderMode('individual');
    const f = await makeWorkspace(ReferralState.CLOSED);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'acknowledge-outcome',
      partyId: f.initiatingPartyId,
      actor: 'guest:7',
    });

    const [assertion] = await db.select().from(workspaceAssertions);
    expect(assertion.sentFromAddress).toBe('referrals@lakeside.direct');
  });
});

// ── Audit ─────────────────────────────────────────────────────────────────────

describe('audit and attribution', () => {
  it('attributes a guest assertion to the guest, not to a clinician', async () => {
    const f = await makeWorkspace(ReferralState.CLOSED);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'acknowledge-outcome',
      partyId: f.initiatingPartyId,
      actor: 'guest:42',
    });
    await flush();

    const rows = await db.select().from(workflowEvents);
    const made = rows.find((e) => e.eventType === 'workspace.assertion_made');
    // Delegating to dispositionService would have produced `clinician:<id>`
    // here, which is the concrete reason the gateway owns its own flow.
    expect(made!.actor).toBe('guest:42');
  });

  it('records authorship and transport signing as separate facts', async () => {
    setSenderMode('individual');
    await db
      .update(users)
      .set({ directAddress: 'echen@specialist.direct' })
      .where(eq(users.id, userId));
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });
    await flush();

    const made = (await db.select().from(workflowEvents)).find(
      (e) => e.eventType === 'workspace.assertion_made',
    );
    const meta = JSON.parse(made!.metadata as string) as Record<string, unknown>;
    // Neither fact may imply the other: individual authorship is not
    // non-repudiation of that individual.
    expect(meta.authoredAs).toBe('echen@specialist.direct');
    expect(meta.transportSignedBy).toBe('receiving@specialist.direct');
    expect(meta.transportMode).toBe('address-on-file');
  });

  it('lists assertions with their party and delivery outcome', async () => {
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);
    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });
    await flush();

    const [record] = await getAssertions(f.workspaceId);
    expect(record.assertionType).toBe('accept');
    expect(record.partyOrgName).toBe('Specialist Care Group');
    expect(record.deliveryStatus).toBe('Delivered');
  });

  it('puts no internal workspace data into any rendered artifact', async () => {
    const f = await makeWorkspace(ReferralState.ACKNOWLEDGED);
    await db
      .update(referralWorkspaces)
      .set({
        workStatus: WorkStatus.WAITING_EXTERNAL,
        nextAction: 'Chase the specialist',
        exceptionReason: 'internal only',
        ownerUserId: userId,
      })
      .where(eq(referralWorkspaces.id, f.workspaceId));

    await submitAssertion({
      workspaceId: f.workspaceId,
      assertionKey: key(),
      assertionType: 'accept',
      partyId: f.receivingPartyId,
      actor: `user:${userId}`,
    });

    const [msg] = await db.select().from(referralMessages);
    const payload = `${msg.contentHl7 ?? ''}${msg.contentXml ?? ''}${msg.contentBody ?? ''}`;
    for (const internal of ['Waiting-External', 'Chase the specialist', 'internal only']) {
      expect(payload).not.toContain(internal);
    }
  });
});
