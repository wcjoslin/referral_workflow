/**
 * Unit tests for identityService.ts and userRoster.ts (PRD-17)
 *
 * Uses in-memory SQLite (via jest.mock) so the acting-user resolution, the
 * legacy-slug lookup and the roster invariants are exercised against a real
 * `users` table rather than a stub.
 */

jest.mock('../../../src/config', () => ({
  config: {
      // PRD-27. Without these the notification path silently no-ops and every
      // assignment or mention in this suite logs a failure.
      workspace: { notificationRetentionDays: 90, notificationCollapseWindowMinutes: 15 },
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct' },
    database: { url: ':memory:' },
  },
}));

jest.mock('../../../src/db', () => {
  const Database = require('better-sqlite3');
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const schema = require('../../../src/db/schema');

  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      direct_address TEXT,
      job_role TEXT NOT NULL,
      legacy_clinician_id TEXT,
      all_queues_access INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_users_legacy_clinician ON users (legacy_clinician_id);
  `);

  (global as Record<string, unknown>).__TEST_SQLITE__ = sqlite;

  return { db: drizzle(sqlite, { schema }) };
});

import {
  ACTING_USER_COOKIE,
  clinicianSlugFor,
  formatActor,
  getActingUser,
  getDefaultActingUser,
  getUser,
  getUserByLegacyClinicianId,
  listUsers,
  NoUsersSeededError,
  readCookie,
  tryGetActingUser,
} from '../../../src/modules/workspace/identityService';
import {
  CLINICIAN_SLUGS,
  PROVIDER_NAMES,
  seedUsers,
  USER_ROSTER,
} from '../../../src/modules/workspace/userRoster';

function sqlite(): import('better-sqlite3').Database {
  return (global as Record<string, unknown>).__TEST_SQLITE__ as import('better-sqlite3').Database;
}

function clearUsers(): void {
  sqlite().exec('DELETE FROM users;');
}

/** A request-shaped object carrying just the Cookie header. */
function reqWithCookie(cookie?: string): { headers: { cookie?: string } } {
  return { headers: cookie === undefined ? {} : { cookie } };
}

function cookieFor(id: number | string): string {
  return `${ACTING_USER_COOKIE}=${String(id)}`;
}

describe('identityService', () => {
  beforeEach(() => clearUsers());

  // ── readCookie ────────────────────────────────────────────────────────────

  describe('readCookie()', () => {
    it('reads a value from among several cookies', () => {
      expect(readCookie('a=1; actingUserId=7; z=9', ACTING_USER_COOKIE)).toBe('7');
    });

    it('returns null for an absent cookie or header', () => {
      expect(readCookie('a=1; z=9', ACTING_USER_COOKIE)).toBeNull();
      expect(readCookie(undefined, ACTING_USER_COOKIE)).toBeNull();
      expect(readCookie('', ACTING_USER_COOKIE)).toBeNull();
    });

    it('ignores malformed segments rather than throwing', () => {
      expect(readCookie('novalue; actingUserId=4', ACTING_USER_COOKIE)).toBe('4');
      expect(readCookie('novalue', ACTING_USER_COOKIE)).toBeNull();
    });

    it('does not match a cookie whose name merely contains the target', () => {
      expect(readCookie('xactingUserId=9', ACTING_USER_COOKIE)).toBeNull();
    });

    it('url-decodes the value', () => {
      expect(readCookie('actingUserId=a%20b', ACTING_USER_COOKIE)).toBe('a b');
    });
  });

  // ── formatActor / clinicianSlugFor ────────────────────────────────────────

  describe('formatActor()', () => {
    it('produces user:<id>', () => {
      expect(formatActor({ id: 42 })).toBe('user:42');
    });

    it('contains neither of the prefixes analyticsQueries strips with REPLACE', () => {
      const actor = formatActor({ id: 1 });
      expect(actor).not.toContain('skill:');
      expect(actor).not.toContain('payer:');
    });
  });

  describe('clinicianSlugFor()', () => {
    it('prefers the historical slug so analytics continuity is preserved', () => {
      expect(clinicianSlugFor({ id: 3, legacyClinicianId: 'dr-chen' })).toBe('dr-chen');
    });

    it('falls back to a stable user-<id> when there is no historical slug', () => {
      expect(clinicianSlugFor({ id: 3, legacyClinicianId: null })).toBe('user-3');
    });
  });

  // ── listUsers / getUser ───────────────────────────────────────────────────

  describe('listUsers()', () => {
    it('returns an empty array on an unseeded database', async () => {
      await expect(listUsers()).resolves.toEqual([]);
    });

    it('excludes inactive users unless asked for them', async () => {
      await seedUsers();
      sqlite().prepare(`UPDATE users SET active = 0 WHERE legacy_clinician_id = 'dr-kim'`).run();

      const active = await listUsers();
      const all = await listUsers(true);

      expect(active).toHaveLength(USER_ROSTER.length - 1);
      expect(all).toHaveLength(USER_ROSTER.length);
      expect(active.map((u) => u.legacyClinicianId)).not.toContain('dr-kim');
      expect(all.map((u) => u.legacyClinicianId)).toContain('dr-kim');
    });

    it('orders by id, so the first entry is the acting-user default', async () => {
      await seedUsers();
      const users = await listUsers();
      const ids = users.map((u) => u.id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    });
  });

  describe('getUser()', () => {
    it('returns null for an unknown or non-integer id', async () => {
      await seedUsers();
      await expect(getUser(99999)).resolves.toBeNull();
      await expect(getUser(1.5)).resolves.toBeNull();
      await expect(getUser(NaN)).resolves.toBeNull();
    });

    it('returns an inactive user (it is not an active-only lookup)', async () => {
      await seedUsers();
      const [kim] = await listUsers().then((us) => us.filter((u) => u.legacyClinicianId === 'dr-kim'));
      sqlite().prepare(`UPDATE users SET active = 0 WHERE id = ?`).run(kim.id);
      await expect(getUser(kim.id)).resolves.toMatchObject({ id: kim.id });
    });
  });

  // ── getUserByLegacyClinicianId ────────────────────────────────────────────

  describe('getUserByLegacyClinicianId()', () => {
    beforeEach(async () => {
      await seedUsers();
    });

    it('resolves every seeded clinician slug', async () => {
      for (const slug of CLINICIAN_SLUGS) {
        const user = await getUserByLegacyClinicianId(slug);
        expect(user).not.toBeNull();
        expect(user?.displayName).toBe(PROVIDER_NAMES[slug]);
      }
    });

    it('returns null for the automation values that column also holds', async () => {
      await expect(getUserByLegacyClinicianId('SYSTEM-TIMEOUT')).resolves.toBeNull();
      await expect(
        getUserByLegacyClinicianId('SYSTEM-SKILL-in-network-accept'),
      ).resolves.toBeNull();
    });

    it('returns null for a historical slug with no seeded person, and for empty input', async () => {
      await expect(getUserByLegacyClinicianId('demo-clinician')).resolves.toBeNull();
      await expect(getUserByLegacyClinicianId('dr-jones')).resolves.toBeNull();
      await expect(getUserByLegacyClinicianId('')).resolves.toBeNull();
    });

    it('does not resolve a deactivated person', async () => {
      sqlite().prepare(`UPDATE users SET active = 0 WHERE legacy_clinician_id = 'dr-chen'`).run();
      await expect(getUserByLegacyClinicianId('dr-chen')).resolves.toBeNull();
    });
  });

  // ── acting user resolution ────────────────────────────────────────────────

  describe('getActingUser()', () => {
    beforeEach(async () => {
      await seedUsers();
    });

    it('returns the user named by a valid cookie', async () => {
      const users = await listUsers();
      const target = users[3];
      await expect(getActingUser(reqWithCookie(cookieFor(target.id)))).resolves.toMatchObject({
        id: target.id,
        displayName: target.displayName,
      });
    });

    it('falls back to the first active user when no cookie is set', async () => {
      const users = await listUsers();
      await expect(getActingUser(reqWithCookie())).resolves.toMatchObject({ id: users[0].id });
    });

    it.each([
      ['a non-numeric value', 'not-a-number'],
      ['a negative id', '-4'],
      ['a fractional id', '2.5'],
      ['zero', '0'],
      ['an unknown id', '99999'],
      ['an empty value', ''],
    ])('falls back and does not throw for %s', async (_label, value) => {
      const users = await listUsers();
      await expect(getActingUser(reqWithCookie(cookieFor(value)))).resolves.toMatchObject({
        id: users[0].id,
      });
    });

    it('falls back when the cookie names a user deactivated since it was set', async () => {
      const users = await listUsers();
      const target = users[3];
      sqlite().prepare(`UPDATE users SET active = 0 WHERE id = ?`).run(target.id);

      const acting = await getActingUser(reqWithCookie(cookieFor(target.id)));
      expect(acting.id).toBe(users[0].id);
    });

    it('ignores unrelated cookies around it', async () => {
      const users = await listUsers();
      const target = users[2];
      const acting = await getActingUser({
        headers: { cookie: `theme=dark; ${cookieFor(target.id)}; other=1` },
      });
      expect(acting.id).toBe(target.id);
    });
  });

  describe('unseeded database', () => {
    it('tryGetActingUser() returns null so read-only pages can render an empty state', async () => {
      await expect(tryGetActingUser(reqWithCookie())).resolves.toBeNull();
    });

    it('getDefaultActingUser() returns null', async () => {
      await expect(getDefaultActingUser()).resolves.toBeNull();
    });

    it('getActingUser() throws rather than fabricating an unattributable actor', async () => {
      await expect(getActingUser(reqWithCookie())).rejects.toThrow(NoUsersSeededError);
    });
  });
});

// ── Roster invariants ───────────────────────────────────────────────────────

describe('userRoster', () => {
  beforeEach(() => clearUsers());

  describe('seedUsers()', () => {
    it('creates the whole roster on a fresh database', async () => {
      const result = await seedUsers();
      expect(result).toEqual({ created: USER_ROSTER.length, skipped: 0 });
      await expect(listUsers()).resolves.toHaveLength(USER_ROSTER.length);
    });

    it('is idempotent on email — a second run creates nothing', async () => {
      await seedUsers();
      const second = await seedUsers();
      expect(second).toEqual({ created: 0, skipped: USER_ROSTER.length });
      await expect(listUsers()).resolves.toHaveLength(USER_ROSTER.length);
    });

    it('does not overwrite a row an operator has since edited', async () => {
      await seedUsers();
      sqlite()
        .prepare(`UPDATE users SET display_name = 'Renamed Person' WHERE legacy_clinician_id = 'dr-chen'`)
        .run();

      await seedUsers();

      const renamed = await getUserByLegacyClinicianId('dr-chen');
      expect(renamed?.displayName).toBe('Renamed Person');
    });

    it('persists the roster fields faithfully', async () => {
      await seedUsers();
      const chen = await getUserByLegacyClinicianId('dr-chen');
      expect(chen).toMatchObject({
        displayName: 'Dr. Emily Chen, MD',
        jobRole: 'clinician',
        legacyClinicianId: 'dr-chen',
        directAddress: 'echen@specialist.direct',
        allQueuesAccess: false,
      });
    });
  });

  describe('roster invariants', () => {
    it('holds real people only — no automation identity (AC12)', () => {
      for (const entry of USER_ROSTER) {
        expect(entry.displayName).not.toMatch(/^SYSTEM-/);
        expect(entry.legacyClinicianId ?? '').not.toMatch(/^SYSTEM-/);
      }
    });

    it('grants allQueuesAccess to exactly one person', () => {
      expect(USER_ROSTER.filter((u) => u.allQueuesAccess)).toHaveLength(1);
    });

    it('leaves exactly one clinician without an individual Direct address (AC20)', () => {
      const clinicians = USER_ROSTER.filter((u) => u.jobRole === 'clinician');
      expect(clinicians.filter((u) => !u.directAddress)).toHaveLength(1);
    });

    it('puts every individual Direct address on the organisation domain (AC20)', () => {
      for (const entry of USER_ROSTER) {
        if (entry.directAddress) expect(entry.directAddress).toMatch(/@specialist\.direct$/);
      }
    });

    it('uses unique emails, so seeding can be idempotent on them', () => {
      const emails = USER_ROSTER.map((u) => u.email);
      expect(new Set(emails).size).toBe(emails.length);
    });

    it('covers every job role the workflow needs', () => {
      const roles = new Set(USER_ROSTER.map((u) => u.jobRole));
      expect([...roles].sort()).toEqual(['clinician', 'coordinator', 'manager', 'scheduler']);
    });

    it('derives PROVIDER_NAMES and CLINICIAN_SLUGS from the roster, with no duplication', () => {
      const withSlugs = USER_ROSTER.filter((u) => u.legacyClinicianId);
      expect(Object.keys(PROVIDER_NAMES)).toHaveLength(withSlugs.length);
      expect(CLINICIAN_SLUGS).toHaveLength(withSlugs.length);
      for (const entry of withSlugs) {
        expect(PROVIDER_NAMES[entry.legacyClinicianId as string]).toBe(entry.displayName);
      }
    });

    it('keeps the four historical slugs the demo data already uses', () => {
      expect([...CLINICIAN_SLUGS].sort()).toEqual(
        ['dr-chen', 'dr-kim', 'dr-patel', 'dr-rodriguez'].sort(),
      );
    });
  });
});
