/**
 * PRD-30 — the guest guard, and the guest payload.
 *
 * THIS FILE IS THE SECURITY BOUNDARY. Two rules, and everything else here
 * serves them:
 *
 * 1. ONE GUARD, ONE SCOPE. Every guest route calls `requireGuest()`, which
 *    resolves the session cookie to exactly one `(workspaceId, partyId)` pair.
 *    No guest handler reads a workspace id from the path, the query or the body.
 *    A guest route that took an id would only be as safe as its own checking,
 *    and there would be one such route per feature; there is instead one guard.
 *
 * 2. OMIT, DO NOT HIDE. `buildGuestPayload()` CONSTRUCTS a payload from named
 *    fields. It is never the internal payload with keys deleted, and it never
 *    relies on the client to hide anything. The absence of `workStatus`,
 *    `ownerUserId`, `queueId`, `nextAction`, participants and internal comments
 *    is the control — so a field added to the internal payload later cannot leak
 *    here, because nothing copies the internal payload.
 *
 * EXPIRY AND REVOCATION ARE CHECKED PER REQUEST, not at acceptance. A guest
 * whose invitation is revoked while their page is open loses access on their
 * next call. Checking only at acceptance would make revocation advisory.
 *
 * WHAT THIS FILE DOES NOT FIX: internal routes have no authentication —
 * `tryGetActingUser()` falls back to the first active user when no cookie is
 * present. A guest who edits their URL to `/workspaces/3` would be served a
 * different patient's internal workspace. `guestCookiePresent()` below is the
 * mitigation: internal routes refuse a request carrying a guest cookie, which
 * closes the path this PRD opens. It is not authentication, and PRD-20 owns the
 * real boundary.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  patients,
  referralWorkspaces,
  referrals,
  workspaceGuests,
  workspaceInvitations,
  workspaceParties,
} from '../../db/schema';
import { ReferralState } from '../../state/referralStateMachine';
import { CookieCarrier, readCookie } from './identityService';
import { PartyRole, ProtocolMode } from './partyService';
// Type-only: a value import would close the cycle described above.
import type { GuestSharedComment } from './commentService';
import type { GuestSharedDocument } from './documentService';

/** Read by the guard only. HttpOnly, unlike the acting-user cookie. */
export const GUEST_SESSION_COOKIE = 'guestSession';

export class GuestSessionMissingError extends Error {
  constructor() {
    super('No guest session. Open your invitation link again.');
    this.name = 'GuestSessionMissingError';
  }
}

export class GuestSessionExpiredError extends Error {
  constructor() {
    super('Your access to this referral has expired.');
    this.name = 'GuestSessionExpiredError';
  }
}

export class GuestAccessRevokedError extends Error {
  constructor() {
    super('Your access to this referral has been ended.');
    this.name = 'GuestAccessRevokedError';
  }
}

/** A valid session presented against a workspace that is not its own. */
export class GuestScopeMismatchError extends Error {
  constructor() {
    super('That referral is not available to you.');
    this.name = 'GuestScopeMismatchError';
  }
}

export interface GuestContext {
  guestId: number;
  invitationId: number;
  /** The only workspace this guest can ever reach. */
  workspaceId: number;
  partyId: number;
  partyRole: PartyRole;
  partyOrgName: string;
  protocolMode: ProtocolMode;
  displayName: string | null;
  expiresAt: Date;
}

export function formatGuestActor(guest: Pick<GuestContext, 'guestId'>): string {
  return `guest:${guest.guestId}`;
}

/**
 * True when the request carries a guest session cookie at all.
 *
 * Used by internal routes to refuse such a request. Deliberately does not
 * validate the cookie: an internal route should refuse anything that looks like
 * a guest, valid or not, and validating would mean an invalid guest cookie
 * sailed through to be served as the default acting user.
 */
export function guestCookiePresent(req: CookieCarrier): boolean {
  return readCookie(req.headers.cookie, GUEST_SESSION_COOKIE) !== null;
}

/**
 * THE guard. Resolves the session cookie to one workspace and party.
 *
 * `pathWorkspaceId` is optional and exists only so a route that happens to carry
 * an id in its path can be REJECTED on mismatch — never so the id can select a
 * workspace. Passing a different id than the session's is an error, not a
 * lookup.
 */
export async function requireGuest(
  req: CookieCarrier,
  pathWorkspaceId?: number,
): Promise<GuestContext> {
  const raw = readCookie(req.headers.cookie, GUEST_SESSION_COOKIE);
  if (!raw) throw new GuestSessionMissingError();

  // Reject anything that cannot be a token before querying, the same way
  // acceptInvitation does.
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new GuestSessionMissingError();

  // Imported lazily to keep this module's import graph free of the invitation
  // service, which imports the mailer and therefore nodemailer.
  const { hashToken } = await import('./invitationService');

  const [guest] = await db
    .select()
    .from(workspaceGuests)
    .where(eq(workspaceGuests.sessionTokenHash, hashToken(raw)))
    .limit(1);
  if (!guest || !guest.sessionTokenHash) throw new GuestSessionMissingError();

  if (!guest.sessionExpiresAt || guest.sessionExpiresAt.getTime() <= Date.now()) {
    throw new GuestSessionExpiredError();
  }

  // Per-request revocation and expiry. This is what makes revoking take effect
  // mid-session rather than at the next acceptance.
  const [invitation] = await db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, guest.invitationId))
    .limit(1);
  if (!invitation) throw new GuestAccessRevokedError();
  if (invitation.revokedAt) throw new GuestAccessRevokedError();
  if (invitation.supersededById !== null) throw new GuestAccessRevokedError();
  if (invitation.expiresAt.getTime() <= Date.now()) throw new GuestSessionExpiredError();

  // AC18. A valid session presented against another workspace is refused, and
  // refusing is the ONLY thing the path id is ever used for.
  if (pathWorkspaceId !== undefined && pathWorkspaceId !== guest.workspaceId) {
    throw new GuestScopeMismatchError();
  }

  const [party] = await db
    .select()
    .from(workspaceParties)
    .where(eq(workspaceParties.id, guest.partyId))
    .limit(1);

  await db
    .update(workspaceGuests)
    .set({ lastSeenAt: new Date() })
    .where(eq(workspaceGuests.id, guest.id));

  return {
    guestId: guest.id,
    invitationId: guest.invitationId,
    workspaceId: guest.workspaceId,
    partyId: guest.partyId,
    partyRole: (party?.partyRole ?? 'other') as PartyRole,
    partyOrgName: party?.orgName ?? 'Unknown organization',
    protocolMode: (party?.protocolMode ?? 'local-only') as ProtocolMode,
    displayName: guest.displayName,
    expiresAt: guest.sessionExpiresAt,
  };
}

// ── The payload ───────────────────────────────────────────────────────────────

export interface GuestTimelineStep {
  state: ReferralState;
  reached: boolean;
  current: boolean;
}

export interface GuestWorkspacePayload {
  workspace: {
    referralState: ReferralState;
    patientName: string;
    patientDob: string;
    reasonForReferral: string | null;
    initiatingOrg: string;
    receivingOrg: string;
  };
  protocolTimeline: GuestTimelineStep[];
  party: { orgName: string; partyRole: PartyRole; protocolMode: ProtocolMode };
  guest: { displayName: string | null; expiresAt: string };
  /**
   * FILLED BY PRD-22. Shared, non-tombstoned comments only, and a narrower shape
   * than the internal `Comment` — no job role, no tombstone metadata, no
   * share-lock state. The narrowing is asserted against
   * `commentService.GUEST_COMMENT_KEYS`, so a field added to the internal shape
   * cannot reach an external reader by being carried along.
   */
  sharedComments: GuestSharedComment[];
  /**
   * FILLED BY PRD-23. Shared, REFERRAL-SCOPED documents only — two independent
   * gates, both applied in SQL. A patient-scoped claims attachment is withheld
   * whatever its visibility says, because it concerns a different episode of
   * care and one toggled flag must not be enough to disclose it.
   */
  sharedDocuments: GuestSharedDocument[];
  /**
   * FILLED BY PRD-29, which is what unblocked PRD-30's third deferred item.
   * Derived from the assertion catalog for this guest's party role and the
   * referral's current protocol state, so the guest is offered exactly what the
   * gateway would permit — and the gateway re-checks from the same catalog.
   */
  availableAssertions: {
    type: string;
    label: string;
    description: string;
    requiredContext: string[];
  }[];
}

/**
 * The exact key set a guest payload may contain, at the top level.
 *
 * Exported so a test can assert the payload against it rather than against a
 * list of forbidden fields. Naming what is ALLOWED fails for a leaked field
 * nobody anticipated; naming what is forbidden only fails for the ones somebody
 * already thought of.
 */
export const GUEST_PAYLOAD_KEYS: readonly string[] = [
  'workspace',
  'protocolTimeline',
  'party',
  'guest',
  'sharedComments',
  'sharedDocuments',
  'availableAssertions',
];

/** And the workspace slice, which is where an internal field would most plausibly land. */
export const GUEST_WORKSPACE_KEYS: readonly string[] = [
  'referralState',
  'patientName',
  'patientDob',
  'reasonForReferral',
  'initiatingOrg',
  'receivingOrg',
];

/**
 * Builds the guest's view from named fields.
 *
 * Takes a `GuestContext`, never a workspace id, so it cannot be called for a
 * workspace the caller has not been resolved to.
 */
export async function buildGuestPayload(
  guest: GuestContext,
): Promise<GuestWorkspacePayload | null> {
  const [workspace] = await db
    .select({ referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, guest.workspaceId))
    .limit(1);
  if (!workspace) return null;

  const [referral] = await db
    .select({
      state: referrals.state,
      reasonForReferral: referrals.reasonForReferral,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dateOfBirth: patients.dateOfBirth,
    })
    .from(referrals)
    .innerJoin(patients, eq(patients.id, referrals.patientId))
    .where(eq(referrals.id, workspace.referralId))
    .limit(1);
  if (!referral) return null;

  // Organization names come from the party rows, not from the raw referrer
  // address, so the guest sees the same names the internal page does.
  const parties = await db
    .select({
      orgName: workspaceParties.orgName,
      partyRole: workspaceParties.partyRole,
      directAddress: workspaceParties.directAddress,
    })
    .from(workspaceParties)
    .where(eq(workspaceParties.workspaceId, guest.workspaceId));

  const named = (role: string): string => {
    const found = parties.find((p) => p.partyRole === role);
    return found?.orgName ?? 'Unknown organization';
  };

  const state = referral.state as ReferralState;

  // What this guest may actually do, from the same catalog the gateway enforces.
  // Imported lazily for the same reason hashToken is: keeping this module's
  // import graph free of the gateway, which pulls in nodemailer via the mailer.
  const { assertionsAvailableFor } = await import('./protocolGateway');
  const available = await assertionsAvailableFor(guest.workspaceId, guest.partyId);

  // Lazily for a different reason: commentService imports this module for
  // formatGuestActor, so a static value import here would be a cycle. The
  // visibility filter lives inside listSharedComments' SQL — an internal comment
  // is never loaded into this process on a guest's behalf.
  const { listSharedComments } = await import('./commentService');
  const sharedComments = await listSharedComments(guest.workspaceId, guest.guestId);

  // Lazily for the same reason: documentService reaches commentService, which
  // imports this module.
  const { listSharedDocuments } = await import('./documentService');
  const sharedDocuments = await listSharedDocuments(guest.workspaceId, guest.guestId);

  return {
    workspace: {
      referralState: state,
      patientName: `${referral.firstName} ${referral.lastName}`.trim(),
      patientDob: referral.dateOfBirth,
      reasonForReferral: referral.reasonForReferral,
      initiatingOrg: named('initiating'),
      receivingOrg: named('receiving'),
    },
    protocolTimeline: buildGuestTimeline(state),
    party: {
      orgName: guest.partyOrgName,
      partyRole: guest.partyRole,
      protocolMode: guest.protocolMode,
    },
    guest: {
      displayName: guest.displayName,
      expiresAt: guest.expiresAt.toISOString(),
    },
    sharedComments,
    sharedDocuments,
    availableAssertions: available.available,
  };
}

/**
 * The protocol timeline, which is the one thing a guest genuinely needs to see
 * to know where the referral stands.
 *
 * Mirrors the branch logic the internal page already uses (`renderTimeline()` in
 * workspaceDetail.html) rather than inventing a linear ordering: a referral that
 * declined, no-showed or went to consult did not travel the happy path, and a
 * single canonical sequence would misreport all three. Computed here rather than
 * client-side because a guest payload is assembled server-side by design.
 *
 * Derived from the PROTOCOL state only. Work status is internal and appears
 * nowhere in this file.
 */
export function buildGuestTimeline(state: ReferralState): GuestTimelineStep[] {
  const base: ReferralState[] = [ReferralState.RECEIVED, ReferralState.ACKNOWLEDGED];

  let path: ReferralState[];
  if (state === ReferralState.DECLINED) {
    path = [...base, ReferralState.DECLINED];
  } else if (state === ReferralState.PENDING_INFORMATION) {
    path = [...base, ReferralState.PENDING_INFORMATION];
  } else if (state === ReferralState.CONSULT) {
    path = [
      ...base,
      ReferralState.ACCEPTED,
      ReferralState.CONSULT,
      ReferralState.CLOSED,
      ReferralState.CLOSED_CONFIRMED,
    ];
  } else if (state === ReferralState.NO_SHOW) {
    path = [...base, ReferralState.ACCEPTED, ReferralState.SCHEDULED, ReferralState.NO_SHOW];
  } else {
    path = [
      ...base,
      ReferralState.ACCEPTED,
      ReferralState.SCHEDULED,
      ReferralState.ENCOUNTER,
      ReferralState.CLOSED,
      ReferralState.CLOSED_CONFIRMED,
    ];
  }

  const idx = path.indexOf(state);
  return path.map((s, i) => ({
    state: s,
    reached: idx >= 0 && i <= idx,
    current: s === state,
  }));
}
