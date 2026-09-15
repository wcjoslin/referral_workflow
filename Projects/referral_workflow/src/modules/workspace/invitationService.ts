/**
 * PRD-30 — invitations that let a party into one workspace.
 *
 * THE TOKEN RULES, which are the whole security surface of this module:
 *
 *   1. A token is 32 bytes from `crypto.randomBytes`, base64url-encoded. 256
 *      bits, because there is no rate limiting anywhere in this codebase, so
 *      entropy is the only thing making guessing impractical.
 *   2. Only the SHA-256 hash is stored. The raw invitation token exists in one
 *      place — the URL inside the delivered email — and the raw session token in
 *      one place, the guest's cookie.
 *   3. No raw token is ever logged, written to audit metadata, returned to the
 *      inviter, or put in an error message. `createInvitation()` returns the URL
 *      to its caller precisely once so the mail can be built; the route does not
 *      pass it back to the browser.
 *   4. Lookup is BY HASH. A raw token is hashed and compared, so a database dump
 *      grants nothing.
 *
 * Acceptance is single-use: the invitation's `acceptedAt` is stamped and the raw
 * token stops working, exchanged for a separate session token with its own
 * shorter expiry.
 *
 * SCOPE: an invitation binds to a `(workspaceId, partyId)` pair. The PARTY is the
 * access scope, because what a guest may see is decided by which organization
 * they represent. There is deliberately no reference to a specific
 * `party_addresses` row — that would add nothing to the access decision and
 * would imply an address had been verified when PRD-24 may only have inferred it
 * from a domain match.
 */

import { createHash, randomBytes } from 'crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import {
  referralWorkspaces,
  referrals,
  patients,
  users,
  workspaceGuests,
  workspaceInvitations,
  workspaceParties,
} from '../../db/schema';
import { config } from '../../config';
import { emitEvent } from '../analytics/eventService';
import { sendMail } from '../messaging/mailer';
import { ActingUser, formatActor } from './identityService';

export class InvitationNotFoundError extends Error {
  constructor() {
    // Deliberately says nothing about which part was wrong, and carries no id:
    // an unauthenticated caller probing tokens learns nothing from the message.
    super('That invitation link is not valid');
    this.name = 'InvitationNotFoundError';
  }
}

export class InvitationExpiredError extends Error {
  constructor(readonly expiredAt: Date) {
    super('That invitation link has expired');
    this.name = 'InvitationExpiredError';
  }
}

export class InvitationRevokedError extends Error {
  constructor() {
    super('That invitation has been revoked');
    this.name = 'InvitationRevokedError';
  }
}

export class InvitationAlreadyAcceptedError extends Error {
  constructor() {
    super('That invitation link has already been used');
    this.name = 'InvitationAlreadyAcceptedError';
  }
}

export class PartyNotOnWorkspaceError extends Error {
  constructor(partyId: number, workspaceId: number) {
    super(`Party ${partyId} is not on workspace ${workspaceId}`);
    this.name = 'PartyNotOnWorkspaceError';
  }
}

export interface Invitation {
  id: number;
  workspaceId: number;
  partyId: number;
  partyOrgName: string;
  recipientEmail: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  supersededById: number | null;
  emailDelivered: boolean;
  invitedByDisplayName: string | null;
  /** Derived, so the panel does not have to re-implement the rules. */
  status: 'pending' | 'accepted' | 'expired' | 'revoked' | 'superseded';
}

// ── Tokens ────────────────────────────────────────────────────────────────────

/** 256 bits. Entropy is the only brake on guessing — there is no rate limiting. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

// NOTE: there is deliberately no constant-time comparison helper here.
//
// Every token lookup is an indexed equality on the SHA-256 hash, performed by
// SQLite — `WHERE token_hash = ?` — so no JavaScript comparison of secrets
// happens on any path. An exported `hashesMatch()` was written and then removed
// precisely because nothing called it: an unused constant-time helper implies a
// protection that is not in effect, which is worse than not having one.
//
// If a future path ever compares a candidate hash in JS, use
// `crypto.timingSafeEqual` there, and note that SQLite's own comparison is not
// constant-time either — the mitigation for that is the 256 bits of entropy,
// not the comparison.

function statusOf(row: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  supersededById: number | null;
}): Invitation['status'] {
  // Order matters: a revoked invitation is revoked even if it also expired, and
  // a superseded one is reported as such rather than as merely expired, because
  // "someone re-issued this" is a different answer to "this timed out".
  if (row.revokedAt) return 'revoked';
  if (row.supersededById !== null) return 'superseded';
  if (row.acceptedAt) return 'accepted';
  if (row.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'pending';
}

// ── Reads ─────────────────────────────────────────────────────────────────────

async function toInvitation(row: typeof workspaceInvitations.$inferSelect): Promise<Invitation> {
  const [party] = await db
    .select({ orgName: workspaceParties.orgName, directAddress: workspaceParties.directAddress })
    .from(workspaceParties)
    .where(eq(workspaceParties.id, row.partyId))
    .limit(1);

  const [inviter] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, row.invitedByUserId))
    .limit(1);

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    partyId: row.partyId,
    partyOrgName: party?.orgName ?? 'Unknown organization',
    recipientEmail: row.recipientEmail,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    supersededById: row.supersededById,
    emailDelivered: row.emailDelivered,
    invitedByDisplayName: inviter?.displayName ?? null,
    status: statusOf(row),
  };
}

export async function listInvitations(workspaceId: number): Promise<Invitation[]> {
  if (!Number.isInteger(workspaceId)) return [];
  const rows = await db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.workspaceId, workspaceId))
    .orderBy(desc(workspaceInvitations.createdAt));
  return Promise.all(rows.map(toInvitation));
}

export async function getInvitation(invitationId: number): Promise<Invitation | null> {
  if (!Number.isInteger(invitationId)) return null;
  const [row] = await db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, invitationId))
    .limit(1);
  return row ? toInvitation(row) : null;
}

// ── Writes ────────────────────────────────────────────────────────────────────

async function referralIdFor(workspaceId: number): Promise<number> {
  const [row] = await db
    .select({ referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  return row?.referralId ?? 0;
}

export interface CreatedInvitation {
  invitation: Invitation;
  /** The ONLY place the raw token appears. Not returned to the inviter's browser. */
  inviteUrl: string;
}

/**
 * Creates an invitation and emails the link.
 *
 * The email contains the patient's name, the referring organization and the
 * expiry — and no clinical detail. The referral content lives behind the link,
 * not in the mail, because an invitation lands in an inbox this system does not
 * control.
 */
export async function createInvitation(
  workspaceId: number,
  partyId: number,
  recipientEmail: string,
  actor: ActingUser,
  expiresInHours?: number,
): Promise<CreatedInvitation> {
  // The party must actually be on this workspace, or the invitation would grant
  // a scope that does not exist.
  const [party] = await db
    .select()
    .from(workspaceParties)
    .where(and(eq(workspaceParties.id, partyId), eq(workspaceParties.workspaceId, workspaceId)))
    .limit(1);
  if (!party) throw new PartyNotOnWorkspaceError(partyId, workspaceId);

  // AC16: an invitation with no expiry cannot be created. The default comes from
  // config rather than a literal here so a deployment can shorten it.
  const hours =
    expiresInHours && expiresInHours > 0
      ? expiresInHours
      : config.workspace.guestInvitationExpiryHours;

  const rawToken = mintToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + hours * 3_600_000);

  const [row] = await db
    .insert(workspaceInvitations)
    .values({
      workspaceId,
      partyId,
      recipientEmail: recipientEmail.trim(),
      tokenHash: hashToken(rawToken),
      invitedByUserId: actor.id,
      expiresAt,
      emailDelivered: false,
      createdAt: now,
    })
    .returning();

  const inviteUrl = `${config.workspace.publicBaseUrl}/guest/${rawToken}`;
  const delivered = await deliverInvitation(workspaceId, recipientEmail.trim(), inviteUrl, expiresAt);
  if (delivered) {
    await db
      .update(workspaceInvitations)
      .set({ emailDelivered: true })
      .where(eq(workspaceInvitations.id, row.id));
  }

  void emitEvent({
    eventType: 'workspace.guest_invited',
    entityType: 'referral',
    entityId: await referralIdFor(workspaceId),
    actor: formatActor(actor),
    metadata: {
      workspaceId,
      partyId,
      invitationId: row.id,
      recipientEmail: recipientEmail.trim(),
      expiresAt: expiresAt.toISOString(),
      emailDelivered: delivered,
      // NOTE: no token, hashed or otherwise. Audit metadata is read by people.
    },
  }).catch((err) => console.error('[InvitationService]', err));

  const created = await getInvitation(row.id);
  if (!created) throw new InvitationNotFoundError();
  return { invitation: { ...created, emailDelivered: delivered }, inviteUrl };
}

/** Patient name and referring organization only — no clinical detail. */
async function deliverInvitation(
  workspaceId: number,
  to: string,
  inviteUrl: string,
  expiresAt: Date,
): Promise<boolean> {
  const referralId = await referralIdFor(workspaceId);
  const [context] = await db
    .select({
      firstName: patients.firstName,
      lastName: patients.lastName,
      referrerAddress: referrals.referrerAddress,
    })
    .from(referrals)
    .innerJoin(patients, eq(patients.id, referrals.patientId))
    .where(eq(referrals.id, referralId))
    .limit(1);

  const patientName = context ? `${context.firstName} ${context.lastName}`.trim() : 'a patient';
  const referringOrg = context?.referrerAddress ?? 'the referring organization';

  return sendMail({
    to,
    subject: `Referral collaboration invitation — ${patientName}`,
    text: [
      `You have been invited to collaborate on a referral for ${patientName}.`,
      `Referring organization: ${referringOrg}`,
      '',
      'Open the referral here:',
      inviteUrl,
      '',
      `This link expires on ${expiresAt.toISOString()}.`,
      'It grants access to this one referral only, and no password is required.',
      '',
      'If you were not expecting this, you can ignore it — the link will expire on its own.',
    ].join('\n'),
  });
}

export async function revokeInvitation(invitationId: number, actor: ActingUser): Promise<void> {
  const [row] = await db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, invitationId))
    .limit(1);
  if (!row) throw new InvitationNotFoundError();
  if (row.revokedAt) return; // already revoked; the caller's intent is satisfied

  const now = new Date();
  await db
    .update(workspaceInvitations)
    .set({ revokedAt: now, revokedByUserId: actor.id })
    .where(eq(workspaceInvitations.id, invitationId));

  // The session row is DELIBERATELY LEFT INTACT.
  //
  // Clearing `sessionTokenHash` here looks like belt and braces and is actually
  // harmful: the guard looks a session up by that hash, so a cleared hash makes
  // it fail with "no guest session — open your invitation link again" before it
  // ever reaches the revocation check. That is the wrong answer and useless
  // advice, since the link will not work either. AC13 asks for a clear "access
  // ended" state, which only the per-request invitation check can produce.
  //
  // Nothing is lost by leaving it: `requireGuest()` re-reads the invitation on
  // every request, so the session is dead the moment this row is written. The
  // hash surviving is what lets the guest be told why.

  void emitEvent({
    eventType: 'workspace.guest_revoked',
    entityType: 'referral',
    entityId: await referralIdFor(row.workspaceId),
    actor: formatActor(actor),
    metadata: { workspaceId: row.workspaceId, partyId: row.partyId, invitationId },
  }).catch((err) => console.error('[InvitationService]', err));
}

/**
 * Issues a fresh invitation to the same party and address, and marks the old one
 * superseded so its token stops working (AC15).
 */
export async function reissueInvitation(
  invitationId: number,
  actor: ActingUser,
): Promise<CreatedInvitation> {
  const [old] = await db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, invitationId))
    .limit(1);
  if (!old) throw new InvitationNotFoundError();

  const fresh = await createInvitation(
    old.workspaceId,
    old.partyId,
    old.recipientEmail,
    actor,
  );

  await db
    .update(workspaceInvitations)
    .set({ supersededById: fresh.invitation.id })
    .where(eq(workspaceInvitations.id, invitationId));

  // As with revocation, the old session row stays: `supersededById` is checked
  // per request, and keeping the hash is what lets the guard explain itself
  // rather than claiming there is no session.

  void emitEvent({
    eventType: 'workspace.guest_reissued',
    entityType: 'referral',
    entityId: await referralIdFor(old.workspaceId),
    actor: formatActor(actor),
    metadata: {
      workspaceId: old.workspaceId,
      partyId: old.partyId,
      supersededInvitationId: invitationId,
      invitationId: fresh.invitation.id,
    },
  }).catch((err) => console.error('[InvitationService]', err));

  return fresh;
}

export interface AcceptedInvitation {
  guestId: number;
  workspaceId: number;
  partyId: number;
  /** The ONLY place the raw session token appears. Goes straight into a cookie. */
  sessionToken: string;
  sessionExpiresAt: Date;
}

/**
 * Exchanges a raw invitation token for a guest session.
 *
 * Single-use: the invitation is stamped `acceptedAt` and the raw token stops
 * working. Re-opening the emailed link afterwards reports that it has been used
 * rather than silently minting a second session.
 */
export async function acceptInvitation(
  rawToken: string,
  displayName?: string,
): Promise<AcceptedInvitation> {
  // Bail before touching the database on anything that cannot be a token. A
  // base64url 32-byte value is 43 characters; anything else is noise or probing.
  if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) {
    throw new InvitationNotFoundError();
  }

  const [row] = await db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.tokenHash, hashToken(rawToken)))
    .limit(1);
  if (!row) throw new InvitationNotFoundError();

  if (row.revokedAt) throw new InvitationRevokedError();
  if (row.supersededById !== null) throw new InvitationAlreadyAcceptedError();
  if (row.acceptedAt) throw new InvitationAlreadyAcceptedError();
  if (row.expiresAt.getTime() <= Date.now()) throw new InvitationExpiredError(row.expiresAt);

  const now = new Date();
  const sessionToken = mintToken();
  const sessionExpiresAt = new Date(
    now.getTime() + config.workspace.guestSessionExpiryHours * 3_600_000,
  );
  // A session never outlives its invitation, even if the configured session
  // window is longer than the remaining invitation window.
  const effectiveExpiry =
    sessionExpiresAt.getTime() > row.expiresAt.getTime() ? row.expiresAt : sessionExpiresAt;

  const [guest] = await db
    .insert(workspaceGuests)
    .values({
      invitationId: row.id,
      workspaceId: row.workspaceId,
      partyId: row.partyId,
      displayName: displayName?.trim() || null,
      sessionTokenHash: hashToken(sessionToken),
      sessionExpiresAt: effectiveExpiry,
      lastSeenAt: now,
      createdAt: now,
    })
    .returning();

  await db
    .update(workspaceInvitations)
    .set({ acceptedAt: now })
    .where(eq(workspaceInvitations.id, row.id));

  void emitEvent({
    eventType: 'workspace.guest_accepted',
    entityType: 'referral',
    entityId: await referralIdFor(row.workspaceId),
    actor: `guest:${guest.id}`,
    metadata: {
      workspaceId: row.workspaceId,
      partyId: row.partyId,
      invitationId: row.id,
      guestId: guest.id,
      ...(displayName?.trim() ? { displayName: displayName.trim() } : {}),
    },
  }).catch((err) => console.error('[InvitationService]', err));

  return {
    guestId: guest.id,
    workspaceId: row.workspaceId,
    partyId: row.partyId,
    sessionToken,
    sessionExpiresAt: effectiveExpiry,
  };
}

/** Outstanding (pending, unexpired, unrevoked) invitations for a party. */
export async function pendingInvitationsForParty(
  workspaceId: number,
  partyId: number,
): Promise<Invitation[]> {
  const rows = await db
    .select()
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        eq(workspaceInvitations.partyId, partyId),
        isNull(workspaceInvitations.revokedAt),
        isNull(workspaceInvitations.acceptedAt),
      ),
    );
  const all = await Promise.all(rows.map(toInvitation));
  return all.filter((i) => i.status === 'pending');
}
