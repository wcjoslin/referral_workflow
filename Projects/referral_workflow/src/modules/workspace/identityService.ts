/**
 * Identity & Acting User Service (PRD-17)
 *
 * The smallest identity layer that unblocks the collaboration workspace epic:
 * a `users` table of real people, and an ambient "acting user" for any request.
 *
 * Deliberately NOT authentication. See getActingUser() for what the cookie is
 * and is not.
 */

import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema';

export type JobRole = 'coordinator' | 'clinician' | 'scheduler' | 'manager';

export const JOB_ROLES: readonly JobRole[] = ['coordinator', 'clinician', 'scheduler', 'manager'];

export interface ActingUser {
  id: number;
  displayName: string;
  email: string;
  /** This user's own Direct address, or null. Additive to the org intake address. */
  directAddress: string | null;
  /** Descriptive only — never an access check. */
  jobRole: JobRole;
  /** Historical referrals.clinician_id slug for this person, or null. */
  legacyClinicianId: string | null;
  /** The explicit see-all-queues grant PRD-20 reads. Never inferred from jobRole. */
  allQueuesAccess: boolean;
  /**
   * Whether this person is still in service (PRD-17 v1.2, added for PRD-21).
   *
   * The column shipped with the table; the type never surfaced it, so nothing
   * downstream could tell an active user from a deactivated one. PRD-21 needs it
   * twice: to refuse assigning work to an inactive user, and to render an owner
   * who was deactivated AFTER being assigned as inactive rather than as nobody.
   */
  active: boolean;
}

export const ACTING_USER_COOKIE = 'actingUserId';

/** Minimal structural shape of what we need from a request. An express Request satisfies it. */
export interface CookieCarrier {
  headers: { cookie?: string | undefined };
}

type UserRow = typeof users.$inferSelect;

function toActingUser(row: UserRow): ActingUser {
  return {
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    directAddress: row.directAddress,
    jobRole: row.jobRole as JobRole,
    legacyClinicianId: row.legacyClinicianId,
    allQueuesAccess: row.allQueuesAccess,
    active: row.active,
  };
}

export async function listUsers(includeInactive = false): Promise<ActingUser[]> {
  const rows = includeInactive
    ? await db.select().from(users).orderBy(asc(users.id))
    : await db.select().from(users).where(eq(users.active, true)).orderBy(asc(users.id));
  return rows.map(toActingUser);
}

/**
 * Looks up one user by id, ACTIVE OR NOT.
 *
 * The lack of an `active` filter here is deliberate and load-bearing. A
 * workspace can outlive its owner's employment; filtering would make that
 * owner's display name resolve to null, and the workspace header would then read
 * "Unassigned" for work somebody owns. A greyed-out name is honest, an empty
 * cell is not. Callers that must exclude inactive users check `.active` — see
 * assignmentService, which refuses to assign to one.
 *
 * `listUsers()` does filter by default, because a picker should not offer people
 * who have left.
 */
export async function getUser(id: number): Promise<ActingUser | null> {
  if (!Number.isInteger(id)) return null;
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ? toActingUser(row) : null;
}

/**
 * Resolves a historical `referrals.clinician_id` slug to a person.
 *
 * Returns null for the synthetic values that column also contains
 * (SYSTEM-SKILL-<name>, SYSTEM-TIMEOUT) and for any slug with no seeded user —
 * both are expected, not errors. Used to label the analytics Clinician filter.
 */
export async function getUserByLegacyClinicianId(slug: string): Promise<ActingUser | null> {
  if (!slug) return null;
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.legacyClinicianId, slug), eq(users.active, true)))
    .limit(1);
  return row ? toActingUser(row) : null;
}

/** Reads one cookie value out of a raw Cookie header. Returns null when absent. */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const sep = part.indexOf('=');
    if (sep === -1) continue;
    if (part.slice(0, sep).trim() === name) {
      return decodeURIComponent(part.slice(sep + 1).trim());
    }
  }
  return null;
}

/**
 * The acting user for a request.
 *
 * IMPORTANT — the actingUserId cookie is NOT a credential and nothing about it
 * is a security control. There is no authentication in this application, and the
 * navigation selector is the sanctioned way to act as someone else: anyone can
 * pick any user from the dropdown. Signing this cookie was considered and
 * rejected — it would protect nothing the dropdown does not already give away,
 * while implying a property that does not exist. This provides *attribution*,
 * never *authorization*. A simulation limitation, recorded as such.
 *
 * An absent, malformed, unknown or deactivated cookie value falls back to the
 * first active user by id, so callers may treat the acting user as always
 * present.
 *
 * On an UNSEEDED database there is no one to fall back to, and fabricating a
 * user would attribute real actions to a person who does not exist — so this
 * throws NoUsersSeededError. That is the one case PRD-17 AC9 ("never throws")
 * and its unseeded-install edge case ("pages still render, no route 500s")
 * cannot both have: read-only surfaces use tryGetActingUser() instead and render
 * an empty selector, while any path that records an actor uses this one and
 * fails loudly rather than writing an unattributable row.
 */
export async function getActingUser(req: CookieCarrier): Promise<ActingUser> {
  const user = await tryGetActingUser(req);
  if (!user) throw new NoUsersSeededError();
  return user;
}

/** Non-throwing variant for read-only surfaces: null on an unseeded database. */
export async function tryGetActingUser(req: CookieCarrier): Promise<ActingUser | null> {
  const raw = readCookie(req.headers.cookie, ACTING_USER_COOKIE);
  if (raw !== null) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) {
      const [row] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, id), eq(users.active, true)))
        .limit(1);
      if (row) return toActingUser(row);
    }
  }
  return getDefaultActingUser();
}

/** The deterministic fallback: first active user by id, or null if none exist. */
export async function getDefaultActingUser(): Promise<ActingUser | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.active, true))
    .orderBy(asc(users.id))
    .limit(1);
  return row ? toActingUser(row) : null;
}

export class NoUsersSeededError extends Error {
  constructor() {
    super('No active users exist. Run `npm run seed` to seed the staff roster.');
    this.name = 'NoUsersSeededError';
  }
}

/**
 * The audit actor string for a user.
 *
 * Extends the existing `workflow_events.actor` prefix convention
 * (`system`, `clinician:<id>`, `skill:<name>`, `payer:<name>`) rather than
 * replacing any of it. Must not contain the literal `skill:` or `payer:`,
 * because analyticsQueries.ts strips those with a substring REPLACE.
 */
export function formatActor(user: Pick<ActingUser, 'id'>): string {
  return `user:${user.id}`;
}

/**
 * The string to write into `referrals.clinician_id` for a user.
 *
 * Prefers the historical slug so the four seeded clinicians keep writing exactly
 * the values already in the demo data (`dr-chen`, …) — that continuity is what
 * keeps the analytics clinician filter and its tests unchanged. Staff with no
 * historical slug get a stable `user-<id>`.
 *
 * Note this column is NOT a foreign key and never will be: it also holds
 * SYSTEM-SKILL-<name> and SYSTEM-TIMEOUT written by automation.
 */
export function clinicianSlugFor(user: Pick<ActingUser, 'id' | 'legacyClinicianId'>): string {
  return user.legacyClinicianId ?? `user-${user.id}`;
}
