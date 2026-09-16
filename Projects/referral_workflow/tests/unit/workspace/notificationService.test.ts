/**
 * Unit tests for notificationService.ts (PRD-27)
 *
 * The property that carries the most weight by a wide margin:
 *
 *   **NO INTERNAL EVENT EVER REACHES A GUEST.** `GUEST_ELIGIBLE_TYPES` is an
 *   ALLOW list, and the test below iterates every type in the system asserting
 *   that anything outside it is refused. That shape matters: a deny list only
 *   protects against the cases somebody already imagined, so adding an internal
 *   type later would leak by omission. Here it fails loudly instead.
 *
 * Then, in order of how bad getting them wrong would be:
 *
 *   - **email bodies carry no clinical content** — patient name, organization,
 *     a link. The content lives behind the link.
 *   - **muting prevents CREATION**, not display. A hidden row still shows in a
 *     count, and the count is the only thing a bell is for.
 *   - **nobody is notified of their own action**, or the bell is worthless.
 *   - **recipients resolve at SEND time**, so a reassignment between the event
 *     and delivery reaches the person who holds the work now.
 */

jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct', orgName: 'Specialist Care Group' },
    database: { url: ':memory:' },
    workspace: {
      publicBaseUrl: 'http://localhost:3000',
      notificationRetentionDays: 90,
      notificationCollapseWindowMinutes: 15,
      overdueSweepIntervalMs: 900000,
    },
  },
}));

/** Captures what would have gone out, so the no-clinical-content rule is testable. */
const sentMail: Array<{ to: string; subject: string; text: string }> = [];
jest.mock('../../../src/modules/messaging/mailer', () => ({
  sendMail: jest.fn(async (mail: { to: string; subject: string; text: string }) => {
    sentMail.push(mail);
    return true;
  }),
  buildTransport: jest.fn(),
}));

jest.mock('../../../src/db', () => {
  const Database = require('better-sqlite3');
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const schema = require('../../../src/db/schema');

  const sqlite = new Database(':memory:');
  sqlite.exec(require('../../helpers/testSchema').TEST_SCHEMA_DDL);

  (global as Record<string, unknown>).__TEST_SQLITE__ = sqlite;

  return { db: drizzle(sqlite, { schema }) };
});

import { ReferralState } from '../../../src/state/referralStateMachine';
import { ActingUser } from '../../../src/modules/workspace/identityService';
import {
  GUEST_ELIGIBLE_TYPES,
  GuestIneligibleTypeError,
  NOTIFICATION_TYPES,
  NotificationType,
  activeGuestIds,
  getUnreadCount,
  listNotifications,
  listPreferences,
  markAllRead,
  markRead,
  notify,
  notifyAssignment,
  notifyException,
  notifyGuestActivity,
  notifyMention,
  notifyOverdue,
  notifySharedActivity,
  notifyStateChange,
  notifyUnassignment,
  pruneOld,
  setPreference,
} from '../../../src/modules/workspace/notificationService';
import { createWorkspace } from '../../../src/modules/workspace/workspaceService';

function sqlite(): import('better-sqlite3').Database {
  return (global as Record<string, unknown>).__TEST_SQLITE__ as import('better-sqlite3').Database;
}

function clearTables(): void {
  sentMail.length = 0;
  sqlite().exec(
    `DELETE FROM notifications;
     DELETE FROM notification_preferences;
     DELETE FROM workflow_events;
     DELETE FROM workspace_guests;
     DELETE FROM workspace_invitations;
     DELETE FROM workspace_participants;
     DELETE FROM workspace_parties;
     DELETE FROM queue_members;
     DELETE FROM queues;
     DELETE FROM referral_workspaces;
     DELETE FROM referrals;
     DELETE FROM patients;
     DELETE FROM users;`,
  );
}

let seq = 0;

function insertUser(name = 'Dana Ruiz', directAddress: string | null = null): ActingUser {
  seq += 1;
  const email = `nt${seq}@example.test`;
  const r = sqlite()
    .prepare(
      `INSERT INTO users (display_name, email, direct_address, job_role, all_queues_access, active, created_at)
       VALUES (?, ?, ?, 'coordinator', 0, 1, 0)`,
    )
    .run(name, email, directAddress);
  return {
    id: Number(r.lastInsertRowid),
    displayName: name,
    email,
    directAddress,
    jobRole: 'coordinator',
    legacyClinicianId: null,
    allQueuesAccess: false,
    active: true,
  };
}

async function makeWorkspace(
  opts: { lastName?: string; orgName?: string | null } = {},
): Promise<{ workspaceId: number; referralId: number }> {
  seq += 1;
  const patient = sqlite()
    .prepare(`INSERT INTO patients (first_name, last_name, date_of_birth) VALUES (?, ?, ?)`)
    .run('Rosa', opts.lastName ?? 'Alvarez', '1962-03-04');
  const ref = sqlite()
    .prepare(
      `INSERT INTO referrals (patient_id, source_message_id, referrer_address, state,
                              routing_department, created_at, updated_at)
       VALUES (?, ?, 'dr.ofori@northside.direct', ?, 'Cardiology', 0, 0)`,
    )
    .run(patient.lastInsertRowid, `nt-${seq}`, ReferralState.RECEIVED);
  const ws = await createWorkspace(Number(ref.lastInsertRowid));
  if (opts.orgName !== undefined) {
    sqlite()
      .prepare(
        `UPDATE workspace_parties SET org_name = ? WHERE workspace_id = ? AND party_role = 'initiating'`,
      )
      .run(opts.orgName, ws.id);
  }
  return { workspaceId: ws.id, referralId: Number(ref.lastInsertRowid) };
}

function setOwner(workspaceId: number, userId: number | null): void {
  sqlite()
    .prepare(`UPDATE referral_workspaces SET owner_user_id = ? WHERE id = ?`)
    .run(userId, workspaceId);
}

function addParticipant(workspaceId: number, userId: number, inviter: number): void {
  sqlite()
    .prepare(
      `INSERT INTO workspace_participants (workspace_id, user_id, role, added_at, added_by_user_id)
       VALUES (?, ?, 'Collaborator', 0, ?)`,
    )
    .run(workspaceId, userId, inviter);
}

function makeQueueWithManager(workspaceId: number, managerId: number): number {
  const q = sqlite()
    .prepare(
      `INSERT INTO queues (name, slug, is_default, active, created_at) VALUES ('Q', 'q-${++seq}', 0, 1, 0)`,
    )
    .run();
  const queueId = Number(q.lastInsertRowid);
  sqlite()
    .prepare(
      `INSERT INTO queue_members (queue_id, user_id, access_level, added_at) VALUES (?, ?, 'manager', 0)`,
    )
    .run(queueId, managerId);
  sqlite().prepare(`UPDATE referral_workspaces SET queue_id = ? WHERE id = ?`).run(queueId, workspaceId);
  return queueId;
}

/** A guest with a live invitation, so notifyGuest() can reach them. */
function makeGuest(
  workspaceId: number,
  inviter: number,
  opts: { revoked?: boolean; expired?: boolean; email?: string } = {},
): number {
  const partyId = (
    sqlite()
      .prepare(`SELECT id FROM workspace_parties WHERE workspace_id = ? AND party_role = 'initiating'`)
      .get(workspaceId) as { id: number }
  ).id;
  seq += 1;
  const future = Math.floor(Date.now() / 1000) + 86400;
  const past = Math.floor(Date.now() / 1000) - 86400;
  const inv = sqlite()
    .prepare(
      `INSERT INTO workspace_invitations
         (workspace_id, party_id, recipient_email, token_hash, invited_by_user_id,
          expires_at, revoked_at, email_delivered, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`,
    )
    .run(
      workspaceId,
      partyId,
      opts.email ?? `guest${seq}@northside.example.org`,
      `hash-${seq}`,
      inviter,
      opts.expired ? past : future,
      opts.revoked ? past : null,
    );
  const guest = sqlite()
    .prepare(
      `INSERT INTO workspace_guests (invitation_id, workspace_id, party_id, display_name, created_at)
       VALUES (?, ?, ?, 'Dr. Ofori', 0)`,
    )
    .run(inv.lastInsertRowid, workspaceId, partyId);
  return Number(guest.lastInsertRowid);
}

function rows(): Array<Record<string, unknown>> {
  return sqlite().prepare(`SELECT * FROM notifications ORDER BY id`).all() as Array<
    Record<string, unknown>
  >;
}

beforeEach(() => clearTables());

// ── THE GUEST BOUNDARY ───────────────────────────────────────────────────────

describe('the guest allow list (AC17)', () => {
  /**
   * The test this whole module is shaped around. Iterating EVERY type rather
   * than listing the forbidden ones is the point: a type added later is covered
   * automatically, and a deny list could not give that.
   */
  it('refuses every notification type that is not guest-eligible', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    const guestId = makeGuest(workspaceId, owner.id);

    const internalTypes = NOTIFICATION_TYPES.filter((t) => !GUEST_ELIGIBLE_TYPES.includes(t));
    // Sanity: if this ever hits zero the assertion below becomes vacuous.
    expect(internalTypes.length).toBeGreaterThan(5);

    for (const type of internalTypes) {
      await expect(
        notify({
          workspaceId,
          type,
          title: 't',
          body: 'b',
          linkPath: '/x',
          audience: { kind: 'guest', guestId },
        }),
      ).rejects.toThrow(GuestIneligibleTypeError);
    }

    // Nothing was written and nothing was mailed for any of them.
    expect(rows()).toHaveLength(0);
    expect(sentMail).toHaveLength(0);
  });

  it('names assignment, work status, mention, routing and exception as internal', () => {
    for (const t of ['assignment', 'unassignment', 'state_change', 'mention', 'exception'] as const) {
      expect(GUEST_ELIGIBLE_TYPES).not.toContain(t);
    }
    expect([...GUEST_ELIGIBLE_TYPES].sort()).toEqual(['guest_invited', 'shared_activity']);
  });

  /** AC18: revoked or expired means nothing further, checked at SEND time. */
  it.each([
    ['revoked', { revoked: true }],
    ['expired', { expired: true }],
  ])('sends nothing to a %s guest', async (_label, opts) => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    const guestId = makeGuest(workspaceId, owner.id, opts);

    await notifySharedActivity(workspaceId, guestId, 'A comment', '/guest/workspace');
    expect(rows()).toHaveLength(0);
    expect(sentMail).toHaveLength(0);
  });

  /** A guest is bound to ONE workspace; a notification for another is a bug. */
  it('refuses to notify a guest about a workspace they are not bound to', async () => {
    const owner = insertUser();
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const guestId = makeGuest(a.workspaceId, owner.id);

    await notifySharedActivity(b.workspaceId, guestId, 'A comment', '/guest/workspace');
    expect(rows()).toHaveLength(0);
  });

  it('excludes a revoked guest from activeGuestIds', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    const live = makeGuest(workspaceId, owner.id);
    makeGuest(workspaceId, owner.id, { revoked: true });
    makeGuest(workspaceId, owner.id, { expired: true });

    expect(await activeGuestIds(workspaceId)).toEqual([live]);
  });
});

// ── Email content ────────────────────────────────────────────────────────────

describe('email bodies carry no clinical content', () => {
  it('names the patient and organization and links, and nothing else', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace({ orgName: 'Northside Primary Care' });
    const guestId = makeGuest(workspaceId, owner.id, { email: 'dr.ofori@northside.example.org' });

    await notifySharedActivity(workspaceId, guestId, 'A comment', '/guest/workspace');

    expect(sentMail).toHaveLength(1);
    const mail = sentMail[0];
    expect(mail.to).toBe('dr.ofori@northside.example.org');
    expect(mail.text).toContain('Rosa Alvarez');
    expect(mail.text).toContain('Northside Primary Care');
    expect(mail.text).toContain('http://localhost:3000/guest/workspace');
    // The comment TEXT is not in the body — the content lives behind the link.
    expect(mail.text).not.toMatch(/diagnos|chest pain|problem list/i);
    expect(mail.subject).not.toMatch(/diagnos/i);
  });

  it('records when the email was accepted', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    const guestId = makeGuest(workspaceId, owner.id);
    await notifySharedActivity(workspaceId, guestId, 'A document', '/guest/workspace');
    expect(rows()[0].email_sent_at).not.toBeNull();
  });

  it('does not email an internal user by default', async () => {
    const owner = insertUser('Dana', 'dana@specialist.direct');
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);

    await notifyStateChange(workspaceId, 'Acknowledged', 'user:99');
    expect(rows()).toHaveLength(1);
    // A bell, not an inbox — email is opt-in per type for internal users.
    expect(sentMail).toHaveLength(0);
  });

  it('emails an internal user once they enable it for that type', async () => {
    const owner = insertUser('Dana', 'dana@specialist.direct');
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await setPreference(owner.id, 'state_change', { emailEnabled: true });

    await notifyStateChange(workspaceId, 'Acknowledged', 'user:99');
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].to).toBe('dana@specialist.direct');
  });

  it('silently skips email for a user with no Direct address', async () => {
    const owner = insertUser('Dana', null);
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await setPreference(owner.id, 'state_change', { emailEnabled: true });

    await notifyStateChange(workspaceId, 'Acknowledged', 'user:99');
    // The notification exists; only the email is absent. Most non-clinical
    // staff have no Direct address, so this is the normal case.
    expect(rows()).toHaveLength(1);
    expect(sentMail).toHaveLength(0);
  });
});

// ── Recipients ───────────────────────────────────────────────────────────────

describe('recipient resolution', () => {
  it('notifies the owner for an owner-audience type', async () => {
    const owner = insertUser();
    const other = insertUser('Someone Else');
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);

    await notify({
      workspaceId,
      type: 'pending_response',
      title: 't',
      body: 'b',
      linkPath: '/x',
      audience: { kind: 'owner' },
    });
    expect(rows().map((r) => r.recipient_user_id)).toEqual([owner.id]);
    expect(await getUnreadCount(other.id)).toBe(0);
  });

  it('notifies the owner AND every participant for a participants audience (AC5)', async () => {
    const owner = insertUser('Owner');
    const p1 = insertUser('P1');
    const p2 = insertUser('P2');
    const stranger = insertUser('Stranger');
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    addParticipant(workspaceId, p1.id, owner.id);
    addParticipant(workspaceId, p2.id, owner.id);

    await notifyStateChange(workspaceId, 'Scheduled', 'system');
    const recipients = rows().map((r) => r.recipient_user_id);
    expect(recipients.sort()).toEqual([owner.id, p1.id, p2.id].sort());
    expect(recipients).not.toContain(stranger.id);
  });

  /** AC9/AC10: the queue's managers when nobody holds it. */
  it('falls back to queue managers when the workspace is unowned', async () => {
    const manager = insertUser('Manager');
    const plainMember = insertUser('Member');
    const { workspaceId } = await makeWorkspace();
    const queueId = makeQueueWithManager(workspaceId, manager.id);
    sqlite()
      .prepare(
        `INSERT INTO queue_members (queue_id, user_id, access_level, added_at) VALUES (?, ?, 'member', 0)`,
      )
      .run(queueId, plainMember.id);
    setOwner(workspaceId, null);

    await notifyException(workspaceId, 'unmatched-ack', 'an ACK arrived we could not place');
    // The MANAGER only — a plain member is not who an unowned exception escalates to.
    expect(rows().map((r) => r.recipient_user_id)).toEqual([manager.id]);
  });

  it('prefers the owner over the queue managers when there is one', async () => {
    const owner = insertUser('Owner');
    const manager = insertUser('Manager');
    const { workspaceId } = await makeWorkspace();
    makeQueueWithManager(workspaceId, manager.id);
    setOwner(workspaceId, owner.id);

    await notifyOverdue(workspaceId, 'Schedule the patient', 51);
    expect(rows().map((r) => r.recipient_user_id)).toEqual([owner.id]);
  });

  it('notifies nobody for an unowned workspace with no queue', async () => {
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, null);
    await notifyOverdue(workspaceId, 'Something', 5);
    // Honest: there is nobody to tell. Broadcasting would be worse.
    expect(rows()).toHaveLength(0);
  });

  /**
   * Resolved at SEND time, not captured with the event. A reassignment between
   * the two must reach whoever holds the work now.
   */
  it('resolves the owner at send time, not when the event happened', async () => {
    const first = insertUser('First');
    const second = insertUser('Second');
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, first.id);
    setOwner(workspaceId, second.id); // reassigned before the notification runs

    await notifyOverdue(workspaceId, 'Something', 5);
    expect(rows().map((r) => r.recipient_user_id)).toEqual([second.id]);
  });
});

// ── Nobody hears about their own action ──────────────────────────────────────

describe('self-notification', () => {
  /** AC2. A bell that tells you what you just did is worthless. */
  it('does not notify a self-assignment', async () => {
    const me = insertUser('Me');
    const { workspaceId } = await makeWorkspace();
    await notifyAssignment(workspaceId, me.id, me.id, me.displayName);
    expect(rows()).toHaveLength(0);
  });

  it('does notify an assignment made by somebody else (AC1)', async () => {
    const me = insertUser('Me');
    const boss = insertUser('Alex Whitfield');
    const { workspaceId } = await makeWorkspace({ orgName: 'Northside Primary Care' });

    await notifyAssignment(workspaceId, me.id, boss.id, boss.displayName);
    const [n] = rows();
    expect(n.recipient_user_id).toBe(me.id);
    // AC1: names the patient, the referral and who assigned it.
    expect(String(n.title)).toContain('Rosa Alvarez');
    expect(String(n.body)).toContain('Alex Whitfield');
    expect(String(n.body)).toContain('Northside Primary Care');
    // AC4: links straight to the workspace.
    expect(n.link_path).toBe(`/workspaces/${workspaceId}`);
  });

  /** AC3: the previous owner is told when somebody else takes it off them. */
  it('notifies the previous owner on an unassignment by somebody else', async () => {
    const previous = insertUser('Previous');
    const boss = insertUser('Boss');
    const { workspaceId } = await makeWorkspace();
    await notifyUnassignment(workspaceId, previous.id, boss.id, boss.displayName);
    expect(rows().map((r) => r.recipient_user_id)).toEqual([previous.id]);
  });

  it('does not notify somebody who released their own work', async () => {
    const me = insertUser('Me');
    const { workspaceId } = await makeWorkspace();
    await notifyUnassignment(workspaceId, me.id, me.id, me.displayName);
    expect(rows()).toHaveLength(0);
  });

  /** AC8: the mentioned user ONLY, never the participant list. */
  it('notifies only the mentioned user, not the participants', async () => {
    const owner = insertUser('Owner');
    const mentioned = insertUser('Mentioned');
    const bystander = insertUser('Bystander');
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    addParticipant(workspaceId, bystander.id, owner.id);
    addParticipant(workspaceId, mentioned.id, owner.id);

    await notifyMention(workspaceId, mentioned.id, 'Owner', owner.id);
    expect(rows().map((r) => r.recipient_user_id)).toEqual([mentioned.id]);
  });
});

// ── Muting ───────────────────────────────────────────────────────────────────

describe('muting (AC12)', () => {
  /** Prevents CREATION. A hidden row still shows in a count. */
  it('creates nothing at all for a muted type', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await setPreference(owner.id, 'overdue', { muted: true });

    await notifyOverdue(workspaceId, 'Something', 5);
    expect(rows()).toHaveLength(0);
    expect(await getUnreadCount(owner.id)).toBe(0);
  });

  it('mutes only the named type', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await setPreference(owner.id, 'overdue', { muted: true });

    await notifyOverdue(workspaceId, 'Something', 5);
    await notifyException(workspaceId, 'delivery-failed', 'a send failed');
    expect(rows().map((r) => r.notification_type)).toEqual(['exception']);
  });

  it('mutes per user, not globally', async () => {
    const muted = insertUser('Muted');
    const other = insertUser('Other');
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, muted.id);
    addParticipant(workspaceId, other.id, muted.id);
    await setPreference(muted.id, 'state_change', { muted: true });

    await notifyStateChange(workspaceId, 'Scheduled', 'system');
    expect(rows().map((r) => r.recipient_user_id)).toEqual([other.id]);
  });

  it('upserts rather than duplicating a preference row', async () => {
    const user = insertUser();
    await setPreference(user.id, 'overdue', { muted: true });
    await setPreference(user.id, 'overdue', { emailEnabled: true });
    const stored = sqlite()
      .prepare(`SELECT * FROM notification_preferences WHERE user_id = ?`)
      .all(user.id) as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    // A partial patch keeps the other field rather than resetting it.
    expect(stored[0]).toMatchObject({ muted: 1, email_enabled: 1 });
  });

  it('lists every type, not only the ones with a stored row', async () => {
    const user = insertUser();
    const prefs = await listPreferences(user.id);
    expect(prefs).toHaveLength(NOTIFICATION_TYPES.length);
    // Guest-addressed types default to email on, because a guest has no bell.
    expect(prefs.find((p) => p.notificationType === 'shared_activity')?.emailEnabled).toBe(true);
    expect(prefs.find((p) => p.notificationType === 'assignment')?.emailEnabled).toBe(false);
  });
});

// ── Collapsing ───────────────────────────────────────────────────────────────

describe('collapsing (AC13)', () => {
  it('collapses a burst for the same recipient, workspace and type into one row', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);

    for (let i = 0; i < 4; i += 1) {
      await notifyStateChange(workspaceId, `State${i}`, 'system');
    }
    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].collapsed_count).toBe(4);
    // The latest wording wins, so the row is not stale.
    expect(String(all[0].title)).toContain('State3');
  });

  it('does not collapse across types', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await notifyOverdue(workspaceId, 'a', 1);
    await notifyException(workspaceId, 'delivery-failed', 'b');
    expect(rows()).toHaveLength(2);
  });

  it('does not collapse across workspaces', async () => {
    const owner = insertUser();
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    setOwner(a.workspaceId, owner.id);
    setOwner(b.workspaceId, owner.id);
    await notifyOverdue(a.workspaceId, 'x', 1);
    await notifyOverdue(b.workspaceId, 'x', 1);
    expect(rows()).toHaveLength(2);
  });

  /**
   * Once read, a new event deserves a NEW notification rather than silently
   * bumping a count on something already dismissed.
   */
  it('does not collapse into an already-read notification', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);

    await notifyOverdue(workspaceId, 'x', 1);
    const [first] = rows();
    await markRead(Number(first.id), owner.id);

    await notifyOverdue(workspaceId, 'x', 2);
    expect(rows()).toHaveLength(2);
  });

  it('does not collapse outside the window', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await notifyOverdue(workspaceId, 'x', 1);

    // Push the existing row well outside the 15-minute window.
    sqlite()
      .prepare(`UPDATE notifications SET created_at = ?`)
      .run(Math.floor(Date.now() / 1000) - 3600);

    await notifyOverdue(workspaceId, 'x', 2);
    expect(rows()).toHaveLength(2);
  });
});

// ── Reading ──────────────────────────────────────────────────────────────────

describe('reading (AC11)', () => {
  it('counts unread and lists with the patient joined', async () => {
    const owner = insertUser();
    const { workspaceId, referralId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await notifyOverdue(workspaceId, 'Schedule the patient', 51);

    expect(await getUnreadCount(owner.id)).toBe(1);
    const [n] = await listNotifications(owner.id);
    expect(n).toMatchObject({
      notificationType: 'overdue',
      read: false,
      patientName: 'Rosa Alvarez',
      referralId,
    });
  });

  /** Listing is a read of the list, not of the notifications. */
  it('listing does not mark anything read', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await notifyOverdue(workspaceId, 'x', 1);

    await listNotifications(owner.id);
    await listNotifications(owner.id);
    expect(await getUnreadCount(owner.id)).toBe(1);
  });

  it('marks one read, then all', async () => {
    const owner = insertUser();
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    setOwner(a.workspaceId, owner.id);
    setOwner(b.workspaceId, owner.id);
    await notifyOverdue(a.workspaceId, 'x', 1);
    await notifyOverdue(b.workspaceId, 'y', 2);
    expect(await getUnreadCount(owner.id)).toBe(2);

    const [first] = rows();
    expect(await markRead(Number(first.id), owner.id)).toBe(true);
    expect(await getUnreadCount(owner.id)).toBe(1);

    expect(await markAllRead(owner.id)).toBe(1);
    expect(await getUnreadCount(owner.id)).toBe(0);
  });

  /** Scoped to the recipient: marking somebody else's read is a miss. */
  it('refuses to mark another user notification read', async () => {
    const owner = insertUser('Owner');
    const stranger = insertUser('Stranger');
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await notifyOverdue(workspaceId, 'x', 1);
    const [n] = rows();

    expect(await markRead(Number(n.id), stranger.id)).toBe(false);
    expect(await getUnreadCount(owner.id)).toBe(1);
  });

  it('returns false for an already-read notification', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await notifyOverdue(workspaceId, 'x', 1);
    const [n] = rows();
    expect(await markRead(Number(n.id), owner.id)).toBe(true);
    expect(await markRead(Number(n.id), owner.id)).toBe(false);
  });

  it('filters to unread only when asked', async () => {
    const owner = insertUser();
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    setOwner(a.workspaceId, owner.id);
    setOwner(b.workspaceId, owner.id);
    await notifyOverdue(a.workspaceId, 'x', 1);
    await notifyOverdue(b.workspaceId, 'y', 2);
    await markRead(Number(rows()[0].id), owner.id);

    expect(await listNotifications(owner.id, { unreadOnly: true })).toHaveLength(1);
    expect(await listNotifications(owner.id)).toHaveLength(2);
  });
});

// ── Guest activity, delivered internally ─────────────────────────────────────

describe('guest activity (AC19/AC20)', () => {
  it('notifies the participants and NAMES the organization and the guest', async () => {
    const owner = insertUser('Owner');
    const participant = insertUser('Participant');
    const { workspaceId } = await makeWorkspace({ orgName: 'Northside Primary Care' });
    setOwner(workspaceId, owner.id);
    addParticipant(workspaceId, participant.id, owner.id);

    await notifyGuestActivity(
      workspaceId,
      'Dr. Ofori',
      'Northside Primary Care',
      'posted a comment',
    );

    const all = rows();
    expect(all.map((r) => r.recipient_user_id).sort()).toEqual([owner.id, participant.id].sort());
    // AC20: the reader must know WHICH organization acted.
    expect(String(all[0].title)).toContain('Northside Primary Care');
    expect(String(all[0].body)).toContain('Dr. Ofori');
    // Delivered internally, never to a guest.
    expect(all.every((r) => r.recipient_guest_id === null)).toBe(true);
  });

  it('degrades to a generic label when the organization is unknown', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace({ orgName: null });
    setOwner(workspaceId, owner.id);
    await notifyGuestActivity(workspaceId, 'A guest', null, 'uploaded a document');
    expect(String(rows()[0].title)).toContain('The counterparty');
  });
});

// ── Retention ────────────────────────────────────────────────────────────────

describe('pruneOld (AC14)', () => {
  it('prunes read notifications past the retention period', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await notifyOverdue(workspaceId, 'x', 1);
    await markAllRead(owner.id);
    sqlite()
      .prepare(`UPDATE notifications SET created_at = ?`)
      .run(Math.floor(Date.now() / 1000) - 200 * 86400);

    expect(await pruneOld()).toBe(1);
    expect(rows()).toHaveLength(0);
  });

  /**
   * An unread notification is still outstanding work. Deleting it on age alone
   * would be the notification equivalent of losing a message.
   */
  it('never prunes an UNREAD notification, however old', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await notifyOverdue(workspaceId, 'x', 1);
    sqlite()
      .prepare(`UPDATE notifications SET created_at = ?`)
      .run(Math.floor(Date.now() / 1000) - 500 * 86400);

    expect(await pruneOld()).toBe(0);
    expect(rows()).toHaveLength(1);
  });

  it('keeps a read notification inside the retention period', async () => {
    const owner = insertUser();
    const { workspaceId } = await makeWorkspace();
    setOwner(workspaceId, owner.id);
    await notifyOverdue(workspaceId, 'x', 1);
    await markAllRead(owner.id);
    expect(await pruneOld()).toBe(0);
  });
});

// ── The schema constraint ────────────────────────────────────────────────────

describe('the recipient union constraint', () => {
  it('refuses a notification with both recipients, and with neither', () => {
    const insert = (u: number | null, g: number | null): void => {
      sqlite()
        .prepare(
          `INSERT INTO notifications (recipient_user_id, recipient_guest_id, workspace_id,
             notification_type, title, body, link_path, collapsed_count, created_at)
           VALUES (?, ?, 1, 'overdue', 't', 'b', '/x', 1, 0)`,
        )
        .run(u, g);
    };
    expect(() => insert(1, 1)).toThrow(/CHECK constraint failed/);
    expect(() => insert(null, null)).toThrow(/CHECK constraint failed/);
  });
});
