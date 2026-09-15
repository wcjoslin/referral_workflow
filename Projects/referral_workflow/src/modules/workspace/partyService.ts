/**
 * PRD-24 — the organizations on a referral.
 *
 * A PARTY is a counterparty in an exchange, never a user of this application. It
 * is never a row in `users` and never a row in `workspace_participants`, and
 * that structural separation is the whole mechanism keeping "external
 * organizations are not workspace users" true once PRD-30 lets them act.
 *
 * ADDRESS CARDINALITY, which is the reason this module is not trivial. An
 * organization receives a domain or subdomain from its HISP and provisions
 * addresses at whatever granularity it likes — organizational intake,
 * departmental, per-clinician, commonly all at once. So a party has:
 *
 *   - ONE canonical intake address on `workspace_parties.direct_address`, which
 *     is what PRD-29 addresses artifacts to, and
 *   - EVERY address ever seen from it in `party_addresses`.
 *
 * Without the second, a follow-up message from a clinician's own address fails
 * to match the party and lands as a correlation exception rather than on the
 * right workspace.
 *
 * `referrals.referrer_address` remains the protocol reply-to. The initiating
 * party row is DERIVED from it, not a replacement for it: five outbound paths
 * (PRD-03 SIU, PRD-04 consult note, PRD-05 interim update, PRD-09 info request)
 * still read the referral column, and this module does not touch them.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  partyAddresses,
  referralMessages,
  referralWorkspaces,
  referrals,
  workspaceParties,
} from '../../db/schema';
import { config } from '../../config';
import { emitEvent } from '../analytics/eventService';

export type PartyRole = 'initiating' | 'receiving' | 'other';
export type ProtocolMode = 'native-360x' | 'workspace-mediated' | 'local-only';

export const PARTY_ROLES: readonly PartyRole[] = ['initiating', 'receiving', 'other'];
export const PROTOCOL_MODES: readonly ProtocolMode[] = [
  'native-360x',
  'workspace-mediated',
  'local-only',
];

export function isPartyRole(value: string): value is PartyRole {
  return (PARTY_ROLES as readonly string[]).includes(value);
}

export function isProtocolMode(value: string): value is ProtocolMode {
  return (PROTOCOL_MODES as readonly string[]).includes(value);
}

export interface Party {
  id: number;
  workspaceId: number;
  /** Resolved: the stored name, or the address domain when there is none. */
  orgName: string;
  orgNameVerified: boolean;
  /** The canonical intake address. Null => local-only, nothing transmittable. */
  directAddress: string | null;
  partyRole: PartyRole;
  protocolMode: ProtocolMode;
  protocolModeSetBy: string | null;
  /** Set by PRD-29 after a real exchange. Null => the mode is assumed, not proven. */
  capabilityVerifiedAt: Date | null;
  contactName: string | null;
  /** Every address seen from this party, intake first. */
  addresses: PartyAddress[];
}

export interface PartyAddress {
  id: number;
  address: string;
  addressKind: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface PartyMatch {
  party: Party;
  /**
   * How it resolved. `domain` is an INFERENCE, not an identification: it means
   * only that the address shares a domain with one we know. PRD-29 must not
   * reply to an address that matched this way — it falls back to intake.
   */
  matchedOn: 'intake' | 'known-address' | 'domain';
}

export class PartyNotFoundError extends Error {
  constructor(partyId: number) {
    super(`No party with id ${partyId}`);
    this.name = 'PartyNotFoundError';
  }
}

/** A mode other than `local-only` on a party with no address is not reachable. */
export class NoDirectAddressError extends Error {
  constructor(partyId: number, mode: ProtocolMode) {
    super(`Party ${partyId} has no Direct address, so it cannot be set to ${mode}`);
    this.name = 'NoDirectAddressError';
  }
}

/** Two parties on one workspace may never claim the same address. */
export class AddressAlreadyClaimedError extends Error {
  constructor(address: string, byPartyId: number) {
    super(`${address} is already claimed by party ${byPartyId} on this workspace`);
    this.name = 'AddressAlreadyClaimedError';
  }
}

// ── Address helpers ───────────────────────────────────────────────────────────

/**
 * The domain part of a Direct address, lowercased, or null.
 *
 * Returns null for an empty string, a value with no `@`, and an `@` with nothing
 * after it. All three are reachable: `messageProcessor.ts:23` defaults an
 * unparseable From header to `''`, and `referrals.referrer_address` is NOT NULL,
 * so the empty string — not null — is what a malformed address looks like here.
 */
export function domainOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at === -1) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return domain === '' ? null : domain;
}

/**
 * A provisional organization name derived from the address domain.
 *
 * `referrals@lakeside-cardiology.direct` becomes `lakeside-cardiology.direct`.
 * Deliberately the bare domain rather than a prettified guess: a name we
 * invented should look like a fallback, because AC3 also requires flagging it
 * unverified, and a plausible-looking fabrication undermines that flag.
 */
export function provisionalOrgName(address: string | null | undefined): string | null {
  return domainOf(address);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

type PartyRow = typeof workspaceParties.$inferSelect;

function toParty(row: PartyRow, addresses: PartyAddress[]): Party {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    // A party with neither a stored name nor a derivable domain still needs
    // something renderable, and 'Unknown organization' is honest about it.
    orgName: row.orgName ?? provisionalOrgName(row.directAddress) ?? 'Unknown organization',
    orgNameVerified: row.orgNameVerified,
    directAddress: row.directAddress,
    partyRole: row.partyRole as PartyRole,
    protocolMode: row.protocolMode as ProtocolMode,
    protocolModeSetBy: row.protocolModeSetBy,
    capabilityVerifiedAt: row.capabilityVerifiedAt,
    contactName: row.contactName,
    addresses,
  };
}

/** Role order for display: initiating, receiving, other (AC13). */
const ROLE_ORDER: Record<PartyRole, number> = { initiating: 0, receiving: 1, other: 2 };

async function addressesFor(partyIds: number[]): Promise<Map<number, PartyAddress[]>> {
  const byParty = new Map<number, PartyAddress[]>();
  if (partyIds.length === 0) return byParty;

  const rows = await db
    .select()
    .from(partyAddresses)
    .orderBy(asc(partyAddresses.firstSeenAt), asc(partyAddresses.id));

  for (const row of rows) {
    if (!partyIds.includes(row.partyId)) continue;
    const list = byParty.get(row.partyId) ?? [];
    list.push({
      id: row.id,
      address: row.address,
      addressKind: row.addressKind,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
    });
    byParty.set(row.partyId, list);
  }
  return byParty;
}

export async function getParties(workspaceId: number): Promise<Party[]> {
  if (!Number.isInteger(workspaceId)) return [];

  const rows = await db
    .select()
    .from(workspaceParties)
    .where(eq(workspaceParties.workspaceId, workspaceId));

  const byParty = await addressesFor(rows.map((r) => r.id));

  return rows
    .map((row) => toParty(row, byParty.get(row.id) ?? []))
    .sort((a, b) => ROLE_ORDER[a.partyRole] - ROLE_ORDER[b.partyRole] || a.id - b.id);
}

export async function getParty(partyId: number): Promise<Party | null> {
  if (!Number.isInteger(partyId)) return null;
  const [row] = await db
    .select()
    .from(workspaceParties)
    .where(eq(workspaceParties.id, partyId))
    .limit(1);
  if (!row) return null;
  const byParty = await addressesFor([row.id]);
  return toParty(row, byParty.get(row.id) ?? []);
}

/**
 * Resolves an inbound address to a party on this workspace, in three steps:
 * the canonical intake address, then any address on file, then the DOMAIN.
 *
 * The domain step is what makes a first message from a departmental or
 * per-clinician address correlate instead of raising an exception — and it is
 * also the step a caller must not over-trust, hence `matchedOn`.
 */
export async function findPartyByDirectAddress(
  workspaceId: number,
  address: string,
): Promise<PartyMatch | null> {
  if (!Number.isInteger(workspaceId)) return null;
  const needle = address?.trim().toLowerCase();
  if (!needle) return null;

  const parties = await getParties(workspaceId);
  if (parties.length === 0) return null;

  const intake = parties.find((p) => p.directAddress?.toLowerCase() === needle);
  if (intake) return { party: intake, matchedOn: 'intake' };

  const known = parties.find((p) =>
    p.addresses.some((a) => a.address.toLowerCase() === needle),
  );
  if (known) return { party: known, matchedOn: 'known-address' };

  const domain = domainOf(needle);
  if (!domain) return null;

  // Domain comparison spans the intake address and every address on file, so a
  // party first seen at a departmental address still matches its own domain.
  const byDomain = parties.find(
    (p) =>
      domainOf(p.directAddress) === domain ||
      p.addresses.some((a) => domainOf(a.address) === domain),
  );
  return byDomain ? { party: byDomain, matchedOn: 'domain' } : null;
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Records an address against whichever party on this workspace it belongs to.
 *
 * Called from `recordThreadMessage()`, the single funnel all nine messaging
 * services already use, so no individual service has to know parties exist.
 *
 * Deliberately forgiving: an address that matches no party is dropped rather
 * than raising. Correlating an unknown sender is PRD-28's job, and a message
 * arriving from a stranger must not fail the thread write that is recording it.
 */
export async function recordPartyAddress(
  workspaceId: number,
  address: string,
  messageId: number | null,
): Promise<void> {
  const trimmed = address?.trim();
  if (!trimmed || !Number.isInteger(workspaceId)) return;

  const now = new Date();

  // Already on file for this workspace? Then only the last-seen stamp moves —
  // and if it belongs to a different party, that is a conflict, not an update.
  const [existing] = await db
    .select()
    .from(partyAddresses)
    .where(
      and(
        eq(partyAddresses.workspaceId, workspaceId),
        sql`lower(${partyAddresses.address}) = ${trimmed.toLowerCase()}`,
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(partyAddresses)
      .set({ lastSeenAt: now })
      .where(eq(partyAddresses.id, existing.id));
    return;
  }

  const match = await findPartyByDirectAddress(workspaceId, trimmed);
  if (!match) return;

  await db.insert(partyAddresses).values({
    workspaceId,
    partyId: match.party.id,
    address: trimmed,
    addressKind: null,
    firstSeenMessageId: messageId,
    firstSeenAt: now,
    lastSeenAt: now,
  });

  void emitEvent({
    eventType: 'workspace.party_address_observed',
    entityType: 'referral',
    entityId: await referralIdFor(workspaceId),
    actor: 'system',
    metadata: {
      workspaceId,
      partyId: match.party.id,
      address: trimmed,
      // How the party was identified matters here: an address learned via a
      // domain match is a weaker claim than one learned from a known address.
      matchedOn: match.matchedOn,
    },
  }).catch((err) => console.error('[PartyService]', err));
}

async function referralIdFor(workspaceId: number): Promise<number> {
  const [row] = await db
    .select({ referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  return row?.referralId ?? 0;
}

/**
 * Seeds the initiating and receiving parties for a workspace.
 *
 * Reads `referrals.referrer_address` itself rather than taking it as an
 * argument: `createWorkspace(referralId)` does not load the referral, and
 * widening its signature would touch both its callers for no gain.
 *
 * Idempotent on `(workspaceId, partyRole)` so a re-run — from the backfill or a
 * retried creation — leaves two parties rather than four.
 */
export async function seedParties(workspaceId: number, referralId: number): Promise<Party[]> {
  const [referral] = await db
    .select({ referrerAddress: referrals.referrerAddress })
    .from(referrals)
    .where(eq(referrals.id, referralId))
    .limit(1);

  const referrerAddress = referral?.referrerAddress?.trim() ?? '';
  const now = new Date();

  const existing = await db
    .select({ id: workspaceParties.id, partyRole: workspaceParties.partyRole })
    .from(workspaceParties)
    .where(eq(workspaceParties.workspaceId, workspaceId));
  const haveRole = new Set(existing.map((r) => r.partyRole));

  const seeded: number[] = [];

  if (!haveRole.has('initiating')) {
    // The initiating party is the one we genuinely do not know: name derived
    // from its domain and flagged unverified until somebody confirms it.
    const [row] = await db
      .insert(workspaceParties)
      .values({
        workspaceId,
        orgName: provisionalOrgName(referrerAddress),
        orgNameVerified: false,
        directAddress: referrerAddress === '' ? null : referrerAddress,
        partyRole: 'initiating',
        protocolMode: resolveInitialMode(referrerAddress),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    seeded.push(row.id);
    await seedIntakeAddress(row.id, workspaceId, referrerAddress, now);
  }

  if (!haveRole.has('receiving')) {
    // The receiving party is US. Naming ourselves from our own domain would be
    // absurd, so the name comes from config and is verified from the start.
    const ourAddress = config.receiving.directAddress?.trim() ?? '';
    const [row] = await db
      .insert(workspaceParties)
      .values({
        workspaceId,
        orgName: config.receiving.orgName,
        orgNameVerified: true,
        directAddress: ourAddress === '' ? null : ourAddress,
        partyRole: 'receiving',
        protocolMode: resolveInitialMode(ourAddress),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    seeded.push(row.id);
    await seedIntakeAddress(row.id, workspaceId, ourAddress, now);
  }

  if (seeded.length > 0) {
    void emitEvent({
      eventType: 'workspace.party_seeded',
      entityType: 'referral',
      entityId: referralId,
      actor: 'system',
      metadata: { workspaceId, partyIds: seeded },
    }).catch((err) => console.error('[PartyService]', err));
  }

  return getParties(workspaceId);
}

/**
 * A party's intake address is also its first known address, so it goes on file
 * with no originating message — it came from the referral, not from a message.
 */
async function seedIntakeAddress(
  partyId: number,
  workspaceId: number,
  address: string,
  now: Date,
): Promise<void> {
  if (address === '') return;
  const [clash] = await db
    .select({ partyId: partyAddresses.partyId })
    .from(partyAddresses)
    .where(
      and(
        eq(partyAddresses.workspaceId, workspaceId),
        sql`lower(${partyAddresses.address}) = ${address.toLowerCase()}`,
      ),
    )
    .limit(1);
  // Both sides legitimately share an address in a loopback demo, where the
  // referrer and receiving addresses are the same mailbox. First claim wins
  // rather than failing the whole seed on a unique-index violation.
  if (clash) return;

  await db.insert(partyAddresses).values({
    workspaceId,
    partyId,
    address,
    addressKind: 'intake',
    firstSeenMessageId: null,
    firstSeenAt: now,
    lastSeenAt: now,
  });
}

/**
 * No address means nothing can be transmitted, so `local-only` is the only
 * honest starting mode. With an address we still start at `workspace-mediated`
 * rather than `native-360x`: assuming the other side speaks 360X before any
 * exchange has proved it would show a capability we have not observed. PRD-29
 * promotes it via markCapabilityVerified().
 */
function resolveInitialMode(address: string): ProtocolMode {
  return address === '' ? 'local-only' : 'workspace-mediated';
}

export async function updateParty(
  partyId: number,
  patch: { orgName?: string; directAddress?: string; contactName?: string },
  actor: string,
): Promise<Party> {
  const current = await getParty(partyId);
  if (!current) throw new PartyNotFoundError(partyId);

  const orgName = patch.orgName?.trim();
  const directAddress = patch.directAddress?.trim();
  const contactName = patch.contactName?.trim();

  if (directAddress) {
    const [clash] = await db
      .select({ id: partyAddresses.id, partyId: partyAddresses.partyId })
      .from(partyAddresses)
      .where(
        and(
          eq(partyAddresses.workspaceId, current.workspaceId),
          sql`lower(${partyAddresses.address}) = ${directAddress.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (clash && clash.partyId !== partyId) {
      throw new AddressAlreadyClaimedError(directAddress, clash.partyId);
    }
  }

  const now = new Date();
  await db
    .update(workspaceParties)
    .set({
      // A name a person typed is verified by definition — somebody asserted it.
      ...(orgName !== undefined ? { orgName, orgNameVerified: orgName !== '' } : {}),
      ...(directAddress !== undefined ? { directAddress: directAddress || null } : {}),
      ...(contactName !== undefined ? { contactName: contactName || null } : {}),
      updatedAt: now,
    })
    .where(eq(workspaceParties.id, partyId));

  if (directAddress) {
    await seedIntakeAddress(partyId, current.workspaceId, directAddress, now);
  }

  void emitEvent({
    eventType: 'workspace.party_updated',
    entityType: 'referral',
    entityId: await referralIdFor(current.workspaceId),
    actor,
    metadata: {
      workspaceId: current.workspaceId,
      partyId,
      ...(orgName !== undefined ? { orgName: { from: current.orgName, to: orgName } } : {}),
      ...(directAddress !== undefined
        ? { directAddress: { from: current.directAddress, to: directAddress || null } }
        : {}),
      ...(contactName !== undefined
        ? { contactName: { from: current.contactName, to: contactName || null } }
        : {}),
    },
  }).catch((err) => console.error('[PartyService]', err));

  const updated = await getParty(partyId);
  if (!updated) throw new PartyNotFoundError(partyId);
  return updated;
}

export async function setProtocolMode(
  partyId: number,
  mode: ProtocolMode,
  actor: string,
): Promise<Party> {
  const current = await getParty(partyId);
  if (!current) throw new PartyNotFoundError(partyId);

  // AC6: with no address there is nothing to transmit to, so any other mode
  // would be a promise the deployment cannot keep.
  if (mode !== 'local-only' && !current.directAddress) {
    throw new NoDirectAddressError(partyId, mode);
  }

  if (current.protocolMode === mode) return current;

  const now = new Date();
  await db
    .update(workspaceParties)
    .set({ protocolMode: mode, protocolModeSetBy: actor, protocolModeSetAt: now, updatedAt: now })
    .where(eq(workspaceParties.id, partyId));

  void emitEvent({
    eventType: 'workspace.protocol_mode_changed',
    entityType: 'referral',
    entityId: await referralIdFor(current.workspaceId),
    fromState: current.protocolMode,
    toState: mode,
    actor,
    metadata: { workspaceId: current.workspaceId, partyId },
  }).catch((err) => console.error('[PartyService]', err));

  const updated = await getParty(partyId);
  if (!updated) throw new PartyNotFoundError(partyId);
  return updated;
}

/**
 * Written by PRD-29 after an actual successful exchange — which is the whole
 * distinction between a capability we assume and one we have observed. No actor
 * parameter: nobody decides this, an exchange either happened or it did not.
 */
export async function markCapabilityVerified(
  partyId: number,
  mode: ProtocolMode,
): Promise<Party> {
  const current = await getParty(partyId);
  if (!current) throw new PartyNotFoundError(partyId);

  const now = new Date();
  await db
    .update(workspaceParties)
    .set({ protocolMode: mode, capabilityVerifiedAt: now, updatedAt: now })
    .where(eq(workspaceParties.id, partyId));

  const updated = await getParty(partyId);
  if (!updated) throw new PartyNotFoundError(partyId);
  return updated;
}

// ── Backfill ──────────────────────────────────────────────────────────────────

export interface BackfillPartiesResult {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * Seeds parties for workspaces that already exist.
 *
 * WHY THIS IS NOT OPTIONAL. Party seeding runs inside `createWorkspace()`, and
 * `backfillWorkspaces()` calls that only for workspaces it is CREATING —
 * existing ones take a `continue` path. So every workspace already in the
 * database would show an empty parties panel forever. That is exactly the defect
 * that shipped in PRD-18's first backfill, which skipped existing workspaces and
 * left all hundred seeded ones stuck in Triage.
 *
 * So this RE-DERIVES rather than skipping: a workspace that has parties but is
 * missing one role gets it, and observed addresses are recovered from the
 * message history that `referral_messages.sender_address` has been recording all
 * along.
 */
export async function backfillParties(): Promise<BackfillPartiesResult> {
  const workspaces = await db
    .select({ id: referralWorkspaces.id, referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(isNull(referralWorkspaces.archivedAt));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const workspace of workspaces) {
    const before = await db
      .select({ partyRole: workspaceParties.partyRole })
      .from(workspaceParties)
      .where(eq(workspaceParties.workspaceId, workspace.id));

    await seedParties(workspace.id, workspace.referralId);
    await recoverObservedAddresses(workspace.id, workspace.referralId);

    const after = await db
      .select({ partyRole: workspaceParties.partyRole })
      .from(workspaceParties)
      .where(eq(workspaceParties.workspaceId, workspace.id));

    if (before.length === 0 && after.length > 0) created += 1;
    else if (after.length > before.length) updated += 1;
    else skipped += 1;
  }

  return { created, updated, skipped };
}

/**
 * Recovers every address this referral has been seen using from its stored
 * message history, so a backfilled workspace starts with the same knowledge a
 * workspace built up live would have.
 */
async function recoverObservedAddresses(workspaceId: number, referralId: number): Promise<void> {
  const messages = await db
    .select({ id: referralMessages.id, senderAddress: referralMessages.senderAddress })
    .from(referralMessages)
    .where(
      and(eq(referralMessages.referralId, referralId), eq(referralMessages.direction, 'inbound')),
    )
    .orderBy(asc(referralMessages.createdAt));

  for (const message of messages) {
    if (!message.senderAddress) continue;
    await recordPartyAddress(workspaceId, message.senderAddress, message.id);
  }
}
