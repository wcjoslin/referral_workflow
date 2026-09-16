/**
 * Unit tests for queueService.ts (PRD-20)
 *
 * The property that carries most of the weight: SCOPE IS APPLIED BEFORE ANY
 * CALLER FILTER, and an empty scope means nothing rather than everything.
 *
 * That second half is the bug worth fearing. "User belongs to no queue" and
 * "no queue filter requested" both look like an absent WHERE clause if you build
 * the query carelessly, and the failure is silent and maximally bad — every
 * patient in the system on one page. So it is asserted from several directions:
 * directly, through the `'all'` slug, through a filter that names another queue,
 * and through the counts.
 *
 * These tests do NOT assert an authentication property, because there is not
 * one. Scope here rests on a cookie-derived identity (PRD-31 owns that gap), so
 * a test named "a user cannot see another queue" would be claiming something
 * false. What is tested is the predicate: given an identity, the server decides
 * the scope and the caller cannot widen it.
 */

jest.mock('../../../src/config', () => ({
  config: {
      // PRD-27. Without these the notification path silently no-ops and every
      // assignment or mention in this suite logs a failure.
      workspace: { notificationRetentionDays: 90, notificationCollapseWindowMinutes: 15 },
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

  (global as Record<string, unknown>).__TEST_SQLITE__ = sqlite;

  return { db: drizzle(sqlite, { schema }) };
});

import { ReferralState } from '../../../src/state/referralStateMachine';
import { WorkStatus } from '../../../src/state/workStatusMachine';
import { getDepartments } from '../../../src/modules/prd03/resourceCalendar';
import { ActingUser } from '../../../src/modules/workspace/identityService';
import { createWorkspace, setWorkStatus } from '../../../src/modules/workspace/workspaceService';
import {
  DEFAULT_QUEUE_SLUG,
  NoDefaultQueueError,
  QUEUE_TABS,
  QueueNotFoundError,
  QueueNotVisibleError,
  SavedFilterNotFoundError,
  TAB_WORK_STATUSES,
  addQueueMember,
  backfillQueues,
  deactivateQueue,
  deleteSavedFilter,
  getDefaultQueue,
  getQueueBySlug,
  getQueueRows,
  getVisibleQueueIds,
  listQueueMembers,
  listQueues,
  listSavedFilters,
  moveWorkspace,
  parseFilters,
  removeQueueMember,
  resolveQueueForDepartment,
  resolveVisibleQueue,
  routeWorkspace,
  saveFilter,
  seedQueues,
  slugify,
  tabForStatus,
} from '../../../src/modules/workspace/queueService';

function sqlite(): import('better-sqlite3').Database {
  return (global as Record<string, unknown>).__TEST_SQLITE__ as import('better-sqlite3').Database;
}

function clearTables(): void {
  sqlite().exec(
    `DELETE FROM workflow_events;
     DELETE FROM saved_filters;
     DELETE FROM queue_members;
     DELETE FROM workspace_parties;
     DELETE FROM referral_workspaces;
     DELETE FROM referrals;
     DELETE FROM patients;
     DELETE FROM queues;
     DELETE FROM users;`,
  );
}

let seq = 0;

function insertUser(name: string, allQueuesAccess = false, active = true): ActingUser {
  seq += 1;
  const email = `q${seq}@example.test`;
  const r = sqlite()
    .prepare(
      `INSERT INTO users (display_name, email, job_role, all_queues_access, active, created_at)
       VALUES (?, ?, 'coordinator', ?, ?, 0)`,
    )
    .run(name, email, allQueuesAccess ? 1 : 0, active ? 1 : 0);
  return {
    id: Number(r.lastInsertRowid),
    displayName: name,
    email,
    directAddress: null,
    jobRole: 'coordinator',
    legacyClinicianId: null,
    allQueuesAccess,
    active,
  };
}

function insertReferral(department = 'Cardiology', state: ReferralState = ReferralState.RECEIVED): number {
  seq += 1;
  const patient = sqlite()
    .prepare(`INSERT INTO patients (first_name, last_name, date_of_birth) VALUES (?, ?, ?)`)
    .run('Test', `Patient${seq}`, '1980-01-01');
  const r = sqlite()
    .prepare(
      `INSERT INTO referrals (patient_id, source_message_id, referrer_address, state, routing_department, created_at, updated_at)
       VALUES (?, ?, 'ref@hospital.direct', ?, ?, 0, 0)`,
    )
    .run(patient.lastInsertRowid, `queue-${seq}`, state, department);
  return Number(r.lastInsertRowid);
}

async function makeWorkspace(
  department = 'Cardiology',
  status: WorkStatus = WorkStatus.TRIAGE,
): Promise<number> {
  const referralId = insertReferral(department);
  const ws = await createWorkspace(referralId);
  if (status !== WorkStatus.TRIAGE) await setWorkStatus(ws.id, status, 'system');
  return ws.id;
}

function events(type?: string): Array<Record<string, unknown>> {
  const rows = sqlite()
    .prepare(`SELECT event_type, entity_id, from_state, to_state, actor, metadata FROM workflow_events`)
    .all() as Array<Record<string, unknown>>;
  return type ? rows.filter((r) => r.event_type === type) : rows;
}

/**
 * Waits for a fire-and-forget audit event to land.
 *
 * `getDefaultQueue()` and `resolveQueueForDepartment()` emit their
 * misconfiguration events with `void emitEvent(...).catch(...)`, matching the
 * codebase convention for audit that must not fail the caller. A single
 * `setImmediate` tick was enough locally and NOT enough under load — it failed
 * once when the full suite ran alongside the smoke check. Polling with a bound
 * asserts the same property without racing the scheduler.
 */
async function waitForEvent(type: string, timeoutMs = 2000): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events(type);
    if (found.length > 0) return found;
    if (Date.now() > deadline) return found;
    await new Promise((r) => setImmediate(r));
  }
}

function setDue(workspaceId: number, iso: string | null): void {
  sqlite()
    .prepare(`UPDATE referral_workspaces SET next_action_due_at = ? WHERE id = ?`)
    .run(iso === null ? null : Math.floor(new Date(iso).getTime() / 1000), workspaceId);
}

beforeEach(async () => {
  clearTables();
  await seedQueues();
});

// ── The tab vocabulary ───────────────────────────────────────────────────────

describe('TAB_WORK_STATUSES', () => {
  it('covers every work status exactly once across the four tabs', () => {
    const placed = QUEUE_TABS.flatMap((t) => [...TAB_WORK_STATUSES[t]]);
    const all = Object.values(WorkStatus);
    expect([...placed].sort()).toEqual([...all].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('maps each status back to exactly one tab', () => {
    for (const status of Object.values(WorkStatus)) {
      expect(tabForStatus(status)).not.toBeNull();
    }
  });

  it('puts Follow-up-Required under completed, not in a tab of its own', () => {
    expect(tabForStatus(WorkStatus.FOLLOW_UP_REQUIRED)).toBe('completed');
    expect(QUEUE_TABS).toHaveLength(4);
  });
});

// ── Seeding ──────────────────────────────────────────────────────────────────

describe('seedQueues', () => {
  it('creates one queue per catalogue department plus the default', async () => {
    const all = await listQueues(insertUser('mgr', true));
    expect(all).toHaveLength(getDepartments().length + 1);
    for (const dept of getDepartments()) {
      expect(all.find((q) => q.departmentFilter === dept)).toBeDefined();
    }
  });

  it('is idempotent', async () => {
    const again = await seedQueues();
    expect(again.created).toBe(0);
    expect(again.existing).toBe(getDepartments().length + 1);
  });

  it('creates exactly one default queue', async () => {
    const rows = sqlite().prepare(`SELECT slug FROM queues WHERE is_default = 1`).all();
    expect(rows).toHaveLength(1);
    expect((await getDefaultQueue()).slug).toBe(DEFAULT_QUEUE_SLUG);
  });

  /**
   * The two departments PRD-20 reconciled into the catalogue. Both had real
   * referrals in `seed-analytics-demo.ts` and no queue to route to, so they
   * piled into default triage and made the needsTriage flag meaningless on the
   * dataset people actually look at.
   */
  it.each([
    ['Oncology', 'oncology'],
    ['General Surgery', 'general-surgery'],
  ])('routes %s, reconciled into the catalogue by PRD-20', async (dept, slug) => {
    expect(getDepartments()).toContain(dept);
    expect(await getQueueBySlug(slug)).not.toBeNull();

    const resolution = await resolveQueueForDepartment(dept);
    expect(resolution.matched).toBe(true);
    expect(resolution.reason).toBe('department-match');
    expect(resolution.queueId).not.toBe((await getDefaultQueue()).id);
  });

  /** `General Surgery` is a specialty; `General` is generic exam rooms. */
  it('keeps General and General Surgery as separate queues', async () => {
    const general = await getQueueBySlug('general');
    const surgery = await getQueueBySlug('general-surgery');
    expect(general).not.toBeNull();
    expect(surgery).not.toBeNull();
    expect(general!.id).not.toBe(surgery!.id);
    expect((await resolveQueueForDepartment('General')).queueId).toBe(general!.id);
    expect((await resolveQueueForDepartment('General Surgery')).queueId).toBe(surgery!.id);
  });

  /**
   * The measured claim behind the reconciliation decision: every department the
   * seed scripts actually use has its own queue, so nothing lands in default
   * triage because of a catalogue omission. `Unassigned` is excluded — that is
   * the genuine no-match case the default queue is FOR.
   */
  it('gives every department the seeds use a queue of its own', async () => {
    const seeded = ['Cardiology', 'Neurology', 'Orthopedics', 'Oncology',
                    'Gastroenterology', 'General Surgery'];
    const fallbackId = (await getDefaultQueue()).id;
    for (const dept of seeded) {
      const r = await resolveQueueForDepartment(dept);
      expect({ dept, matched: r.matched, fellBack: r.queueId === fallbackId })
        .toEqual({ dept, matched: true, fellBack: false });
    }
  });

  it('throws rather than guessing when no default queue exists', async () => {
    sqlite().exec(`UPDATE queues SET is_default = 0`);
    await expect(getDefaultQueue()).rejects.toThrow(NoDefaultQueueError);
  });

  it('resolves several defaults deterministically and reports the misconfiguration', async () => {
    sqlite().exec(`UPDATE queues SET is_default = 1 WHERE slug IN ('cardiology','neurology')`);
    const chosen = await getDefaultQueue();
    const ids = (
      sqlite().prepare(`SELECT id FROM queues WHERE is_default = 1 ORDER BY id`).all() as Array<{
        id: number;
      }>
    ).map((r) => r.id);
    expect(chosen.id).toBe(ids[0]);
    expect((await waitForEvent('queue.misconfigured')).length).toBeGreaterThan(0);
  });
});

describe('slugify', () => {
  it('turns a two-word department into a single slug', () => {
    expect(slugify('Physical Therapy')).toBe('physical-therapy');
  });
});

// ── Scope resolution ─────────────────────────────────────────────────────────

describe('getVisibleQueueIds', () => {
  it('returns the queues a user belongs to', async () => {
    const user = insertUser('coord');
    const admin = insertUser('admin', true);
    const cardio = await getQueueBySlug('cardiology');
    await addQueueMember(cardio!.id, user.id, admin);

    expect(await getVisibleQueueIds(user)).toEqual([cardio!.id]);
  });

  it("returns 'all' for a user holding the explicit allQueuesAccess grant", async () => {
    expect(await getVisibleQueueIds(insertUser('mgr', true))).toBe('all');
  });

  /**
   * The bug this whole module is shaped around. An empty membership list is the
   * empty state, NOT a licence to see everything.
   */
  it('returns an empty array — not all — for a user in no queue', async () => {
    expect(await getVisibleQueueIds(insertUser('nobody'))).toEqual([]);
  });

  it('never infers the grant from jobRole', async () => {
    const manager = insertUser('boss');
    sqlite().prepare(`UPDATE users SET job_role = 'manager' WHERE id = ?`).run(manager.id);
    // jobRole is descriptive; the grant is the column, and it is still false.
    expect(await getVisibleQueueIds(manager)).toEqual([]);
  });

  it('does not duplicate a queue id when membership is re-added', async () => {
    const user = insertUser('coord');
    const admin = insertUser('admin', true);
    const cardio = await getQueueBySlug('cardiology');
    await addQueueMember(cardio!.id, user.id, admin);
    await addQueueMember(cardio!.id, user.id, admin, 'manager');
    expect(await getVisibleQueueIds(user)).toEqual([cardio!.id]);
  });
});

// ── Slug resolution ──────────────────────────────────────────────────────────

describe('resolveVisibleQueue', () => {
  it('resolves a queue the user belongs to', async () => {
    const user = insertUser('coord');
    const admin = insertUser('admin', true);
    const cardio = await getQueueBySlug('cardiology');
    await addQueueMember(cardio!.id, user.id, admin);
    expect((await resolveVisibleQueue(user, 'cardiology')).slug).toBe('cardiology');
  });

  it('refuses a queue outside the user scope', async () => {
    const user = insertUser('coord');
    const admin = insertUser('admin', true);
    await addQueueMember((await getQueueBySlug('cardiology'))!.id, user.id, admin);
    await expect(resolveVisibleQueue(user, 'neurology')).rejects.toThrow(QueueNotVisibleError);
  });

  /**
   * One error for "not yours" and "does not exist", deliberately: telling them
   * apart would let a caller enumerate the queues that exist.
   */
  it('gives the same error for an unknown slug as for an out-of-scope one', async () => {
    const user = insertUser('coord');
    const a = await resolveVisibleQueue(user, 'neurology').catch((e) => e);
    const b = await resolveVisibleQueue(user, 'no-such-queue').catch((e) => e);
    expect(a).toBeInstanceOf(QueueNotVisibleError);
    expect(b).toBeInstanceOf(QueueNotVisibleError);
    expect(a.name).toBe(b.name);
  });

  it('resolves any queue for a user with the grant', async () => {
    const mgr = insertUser('mgr', true);
    expect((await resolveVisibleQueue(mgr, 'neurology')).slug).toBe('neurology');
  });
});

// ── Routing ──────────────────────────────────────────────────────────────────

describe('resolveQueueForDepartment', () => {
  it('matches a department to its queue', async () => {
    const r = await resolveQueueForDepartment('Cardiology');
    expect(r.matched).toBe(true);
    expect(r.reason).toBe('department-match');
    expect(r.queueId).toBe((await getQueueBySlug('cardiology'))!.id);
  });

  it('falls back to the default queue for Unassigned', async () => {
    const r = await resolveQueueForDepartment('Unassigned');
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('department-unassigned');
    expect(r.queueId).toBe((await getDefaultQueue()).id);
  });

  it('falls back to the default queue for a department with no queue', async () => {
    const r = await resolveQueueForDepartment('Dermatology');
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('department-no-queue');
    expect(r.queueId).toBe((await getDefaultQueue()).id);
  });

  it('resolves two queues claiming one department by lowest id, and reports it', async () => {
    const now = Math.floor(Date.now() / 1000);
    sqlite()
      .prepare(
        `INSERT INTO queues (name, slug, department_filter, is_default, active, created_at)
         VALUES ('Cardiology Overflow', 'cardio-overflow', 'Cardiology', 0, 1, ?)`,
      )
      .run(now);
    const cardio = await getQueueBySlug('cardiology');
    const r = await resolveQueueForDepartment('Cardiology');
    expect(r.queueId).toBe(cardio!.id);
    expect(r.reason).toBe('department-ambiguous');
    const emitted = await waitForEvent('queue.misconfigured');
    expect(emitted.length).toBeGreaterThan(0);
    const meta = JSON.parse(emitted[0].metadata as string) as Record<string, unknown>;
    expect(meta.problem).toBe('duplicate-department-filter');
    expect(meta.department).toBe('Cardiology');
    expect(meta.resolvedTo).toBe(cardio!.id);
  });

  it('ignores an inactive queue when matching', async () => {
    sqlite().exec(`UPDATE queues SET active = 0 WHERE slug = 'neurology'`);
    const r = await resolveQueueForDepartment('Neurology');
    expect(r.matched).toBe(false);
    expect(r.queueId).toBe((await getDefaultQueue()).id);
  });
});

describe('routeWorkspace', () => {
  it('routes a new workspace to its department queue at creation', async () => {
    const wsId = await makeWorkspace('Neurology');
    const row = sqlite()
      .prepare(`SELECT queue_id FROM referral_workspaces WHERE id = ?`)
      .get(wsId) as { queue_id: number };
    expect(row.queue_id).toBe((await getQueueBySlug('neurology'))!.id);
  });

  it('emits queue_changed with the resolved queue and the reason', async () => {
    await makeWorkspace('Neurology');
    const emitted = events('workspace.queue_changed');
    expect(emitted).toHaveLength(1);
    const meta = JSON.parse(emitted[0].metadata as string);
    expect(meta.reason).toBe('department-match');
    expect(meta.matched).toBe(true);
    expect(meta.fromQueueId).toBeNull();
    expect(meta.department).toBe('Neurology');
  });

  it('is idempotent for an already-routed workspace', async () => {
    const wsId = await makeWorkspace('Neurology');
    expect(events('workspace.queue_changed')).toHaveLength(1);
    const again = await routeWorkspace(wsId, 'system');
    expect(again).toBe((await getQueueBySlug('neurology'))!.id);
    expect(events('workspace.queue_changed')).toHaveLength(1);
  });

  /**
   * AC18. Routing does not re-run, so a department change cannot silently move
   * an owned workspace — the move is offered in the UI instead.
   */
  it('does not re-queue when the department changes after creation', async () => {
    const wsId = await makeWorkspace('Neurology');
    const referral = sqlite()
      .prepare(`SELECT referral_id FROM referral_workspaces WHERE id = ?`)
      .get(wsId) as { referral_id: number };
    sqlite()
      .prepare(`UPDATE referrals SET routing_department = 'Cardiology' WHERE id = ?`)
      .run(referral.referral_id);

    await routeWorkspace(wsId, 'system');
    const row = sqlite()
      .prepare(`SELECT queue_id FROM referral_workspaces WHERE id = ?`)
      .get(wsId) as { queue_id: number };
    expect(row.queue_id).toBe((await getQueueBySlug('neurology'))!.id);
  });

  it('routes an Unassigned referral to the default queue', async () => {
    const wsId = await makeWorkspace('Unassigned');
    const row = sqlite()
      .prepare(`SELECT queue_id FROM referral_workspaces WHERE id = ?`)
      .get(wsId) as { queue_id: number };
    expect(row.queue_id).toBe((await getDefaultQueue()).id);
  });

  it('returns null for a workspace that does not exist', async () => {
    expect(await routeWorkspace(9999, 'system')).toBeNull();
  });
});

describe('moveWorkspace', () => {
  it('moves a workspace and audits the previous queue', async () => {
    const mgr = insertUser('mgr', true);
    const wsId = await makeWorkspace('Neurology');
    const from = (await getQueueBySlug('neurology'))!.id;
    const to = (await getQueueBySlug('cardiology'))!.id;

    await moveWorkspace(wsId, to, mgr, 'wrong department');

    const emitted = events('workspace.queue_changed');
    expect(emitted).toHaveLength(2);
    const meta = JSON.parse(emitted[1].metadata as string);
    expect(meta.fromQueueId).toBe(from);
    expect(meta.toQueueId).toBe(to);
    expect(meta.reason).toBe('wrong department');
    expect(meta.manual).toBe(true);
    expect(emitted[1].actor).toBe(`user:${mgr.id}`);
  });

  it('emits nothing when the target is the queue it is already in', async () => {
    const mgr = insertUser('mgr', true);
    const wsId = await makeWorkspace('Neurology');
    await moveWorkspace(wsId, (await getQueueBySlug('neurology'))!.id, mgr);
    expect(events('workspace.queue_changed')).toHaveLength(1);
  });

  it('refuses an unknown queue', async () => {
    const mgr = insertUser('mgr', true);
    const wsId = await makeWorkspace('Neurology');
    await expect(moveWorkspace(wsId, 9999, mgr)).rejects.toThrow(QueueNotFoundError);
  });
});

describe('deactivateQueue', () => {
  it('moves held workspaces to the default queue, auditing each', async () => {
    const mgr = insertUser('mgr', true);
    const a = await makeWorkspace('Neurology');
    const b = await makeWorkspace('Neurology');
    const neuro = (await getQueueBySlug('neurology'))!.id;
    const fallback = (await getDefaultQueue()).id;

    const moved = await deactivateQueue(neuro, mgr);
    expect(moved).toBe(2);

    for (const id of [a, b]) {
      const row = sqlite()
        .prepare(`SELECT queue_id FROM referral_workspaces WHERE id = ?`)
        .get(id) as { queue_id: number };
      expect(row.queue_id).toBe(fallback);
    }
    // Two routings plus two moves — each workspace individually audited.
    expect(events('workspace.queue_changed')).toHaveLength(4);
    expect(
      (sqlite().prepare(`SELECT active FROM queues WHERE id = ?`).get(neuro) as { active: number })
        .active,
    ).toBe(0);
  });

  it('refuses to deactivate the default queue', async () => {
    const mgr = insertUser('mgr', true);
    await expect(deactivateQueue((await getDefaultQueue()).id, mgr)).rejects.toThrow(
      /default queue cannot be deactivated/,
    );
  });
});

// ── Rows and scope ───────────────────────────────────────────────────────────

describe('getQueueRows scope', () => {
  it('shows a member only their queue rows', async () => {
    const admin = insertUser('admin', true);
    const user = insertUser('coord');
    await makeWorkspace('Cardiology');
    await makeWorkspace('Neurology');
    await addQueueMember((await getQueueBySlug('cardiology'))!.id, user.id, admin);

    const { rows } = await getQueueRows(user, 'all');
    expect(rows).toHaveLength(1);
    expect(rows[0].department).toBe('Cardiology');
  });

  it('shows a user with the grant every queue', async () => {
    const mgr = insertUser('mgr', true);
    await makeWorkspace('Cardiology');
    await makeWorkspace('Neurology');
    const { rows } = await getQueueRows(mgr, 'all');
    expect(rows).toHaveLength(2);
  });

  /** AC2, and the failure mode this module is built to avoid. */
  it('shows a user in no queue NOTHING, not everything', async () => {
    await makeWorkspace('Cardiology');
    await makeWorkspace('Neurology');
    const { rows, counts } = await getQueueRows(insertUser('nobody'), 'all');
    expect(rows).toEqual([]);
    expect(counts).toEqual({ open: 0, waiting: 0, exception: 0, completed: 0 });
  });

  it('refuses a slug outside scope rather than returning its rows', async () => {
    const admin = insertUser('admin', true);
    const user = insertUser('coord');
    await makeWorkspace('Neurology');
    await addQueueMember((await getQueueBySlug('cardiology'))!.id, user.id, admin);
    await expect(getQueueRows(user, 'neurology')).rejects.toThrow(QueueNotVisibleError);
  });

  /**
   * AC4 from the other direction: scope resolves before the filter, so a filter
   * that names an out-of-scope department yields nothing rather than that
   * department's rows.
   */
  it('applies scope before a caller filter', async () => {
    const admin = insertUser('admin', true);
    const user = insertUser('coord');
    await makeWorkspace('Neurology');
    await addQueueMember((await getQueueBySlug('cardiology'))!.id, user.id, admin);

    const { rows } = await getQueueRows(user, 'all', { department: 'Neurology' });
    expect(rows).toEqual([]);
  });

  it('counts within scope', async () => {
    const admin = insertUser('admin', true);
    const user = insertUser('coord');
    await makeWorkspace('Cardiology');
    await makeWorkspace('Neurology');
    await makeWorkspace('Neurology');
    await addQueueMember((await getQueueBySlug('cardiology'))!.id, user.id, admin);

    const scoped = await getQueueRows(user, 'all');
    expect(scoped.counts.open).toBe(1);
    const all = await getQueueRows(insertUser('mgr2', true), 'all');
    expect(all.counts.open).toBe(3);
  });
});

describe('getQueueRows filters', () => {
  it('filters by tab', async () => {
    const mgr = insertUser('mgr', true);
    await makeWorkspace('Cardiology', WorkStatus.TRIAGE);
    await makeWorkspace('Cardiology', WorkStatus.WAITING_EXTERNAL);
    await makeWorkspace('Cardiology', WorkStatus.EXCEPTION);

    expect((await getQueueRows(mgr, 'all', { tab: 'open' })).rows).toHaveLength(1);
    expect((await getQueueRows(mgr, 'all', { tab: 'waiting' })).rows).toHaveLength(1);
    expect((await getQueueRows(mgr, 'all', { tab: 'exception' })).rows).toHaveLength(1);
    expect((await getQueueRows(mgr, 'all', { tab: 'completed' })).rows).toHaveLength(0);
  });

  /** Counts ignore the tab so the tab strip stays usable, but honour the rest. */
  it('reports every tab count while a tab is selected', async () => {
    const mgr = insertUser('mgr', true);
    await makeWorkspace('Cardiology', WorkStatus.TRIAGE);
    await makeWorkspace('Cardiology', WorkStatus.WAITING_EXTERNAL);

    const { counts, rows } = await getQueueRows(mgr, 'all', { tab: 'open' });
    expect(rows).toHaveLength(1);
    expect(counts.open).toBe(1);
    expect(counts.waiting).toBe(1);
  });

  it('narrows counts by a non-tab filter', async () => {
    const mgr = insertUser('mgr', true);
    await makeWorkspace('Cardiology', WorkStatus.TRIAGE);
    await makeWorkspace('Neurology', WorkStatus.WAITING_EXTERNAL);

    const { counts } = await getQueueRows(mgr, 'all', { department: 'Cardiology' });
    expect(counts.open).toBe(1);
    expect(counts.waiting).toBe(0);
  });

  it('filters by owner unassigned and me', async () => {
    const mgr = insertUser('mgr', true);
    const a = await makeWorkspace('Cardiology');
    await makeWorkspace('Cardiology');
    sqlite().prepare(`UPDATE referral_workspaces SET owner_user_id = ? WHERE id = ?`).run(mgr.id, a);

    expect((await getQueueRows(mgr, 'all', { ownerUserId: 'unassigned' })).rows).toHaveLength(1);
    expect((await getQueueRows(mgr, 'all', { ownerUserId: 'me' })).rows).toHaveLength(1);
    expect((await getQueueRows(mgr, 'all', { ownerUserId: mgr.id })).rows).toHaveLength(1);
    expect((await getQueueRows(mgr, 'all', { ownerUserId: 'any' })).rows).toHaveLength(2);
  });

  it('filters by protocol state', async () => {
    const mgr = insertUser('mgr', true);
    const wsId = await makeWorkspace('Cardiology');
    const ref = sqlite()
      .prepare(`SELECT referral_id FROM referral_workspaces WHERE id = ?`)
      .get(wsId) as { referral_id: number };
    sqlite()
      .prepare(`UPDATE referrals SET state = ? WHERE id = ?`)
      .run(ReferralState.SCHEDULED, ref.referral_id);
    await makeWorkspace('Cardiology');

    const { rows } = await getQueueRows(mgr, 'all', { referralState: [ReferralState.SCHEDULED] });
    expect(rows).toHaveLength(1);
  });

  it('filters by party organization, case-insensitively', async () => {
    const mgr = insertUser('mgr', true);
    const wsId = await makeWorkspace('Cardiology');
    await makeWorkspace('Cardiology');
    sqlite()
      .prepare(
        `UPDATE workspace_parties SET org_name = 'Northside Primary Care'
         WHERE workspace_id = ? AND party_role = 'initiating'`,
      )
      .run(wsId);

    const hit = await getQueueRows(mgr, 'all', { partyOrgName: 'northside primary care' });
    expect(hit.rows).toHaveLength(1);
    expect(hit.rows[0].initiatingOrgName).toBe('Northside Primary Care');
  });

  it('filters by due-date range and overdue', async () => {
    const mgr = insertUser('mgr', true);
    const past = await makeWorkspace('Cardiology');
    const future = await makeWorkspace('Cardiology');
    await makeWorkspace('Cardiology'); // no due date
    setDue(past, '2026-09-10T00:00:00Z');
    setDue(future, '2026-09-30T00:00:00Z');
    const now = new Date('2026-09-16T00:00:00Z');

    expect((await getQueueRows(mgr, 'all', { overdueOnly: true }, now)).rows).toHaveLength(1);
    expect(
      (await getQueueRows(mgr, 'all', { dueAfter: new Date('2026-09-20T00:00:00Z') }, now)).rows,
    ).toHaveLength(1);
    expect(
      (await getQueueRows(mgr, 'all', { dueBefore: new Date('2026-09-20T00:00:00Z') }, now)).rows,
    ).toHaveLength(1);
  });

  /** A null due date is "no commitment made", never "late". */
  it('does not treat a workspace with no due date as overdue', async () => {
    const mgr = insertUser('mgr', true);
    await makeWorkspace('Cardiology');
    const { rows } = await getQueueRows(mgr, 'all', {}, new Date('2026-09-16T00:00:00Z'));
    expect(rows[0].nextActionDueAt).toBeNull();
    expect(rows[0].overdue).toBe(false);
    expect((await getQueueRows(mgr, 'all', { overdueOnly: true })).rows).toHaveLength(0);
  });

  it('composes filters', async () => {
    const mgr = insertUser('mgr', true);
    const target = await makeWorkspace('Cardiology', WorkStatus.WAITING_EXTERNAL);
    await makeWorkspace('Cardiology', WorkStatus.TRIAGE);
    await makeWorkspace('Neurology', WorkStatus.WAITING_EXTERNAL);
    setDue(target, '2026-09-10T00:00:00Z');

    const { rows } = await getQueueRows(
      mgr,
      'all',
      { tab: 'waiting', department: 'Cardiology', overdueOnly: true },
      new Date('2026-09-16T00:00:00Z'),
    );
    expect(rows.map((r) => r.workspaceId)).toEqual([target]);
  });

  /** An explicit status outside the tab intersects to nothing, honestly. */
  it('intersects tab and explicit work status rather than letting one win', async () => {
    const mgr = insertUser('mgr', true);
    await makeWorkspace('Cardiology', WorkStatus.TRIAGE);
    const { rows } = await getQueueRows(mgr, 'all', {
      tab: 'open',
      workStatus: [WorkStatus.EXCEPTION],
    });
    expect(rows).toEqual([]);
  });

  it('excludes archived workspaces', async () => {
    const mgr = insertUser('mgr', true);
    const wsId = await makeWorkspace('Cardiology');
    sqlite().prepare(`UPDATE referral_workspaces SET archived_at = 1 WHERE id = ?`).run(wsId);
    expect((await getQueueRows(mgr, 'all')).rows).toEqual([]);
  });
});

describe('getQueueRows ordering', () => {
  /** AC8: due date ascending with NULLS LAST, then created date descending. */
  it('orders by due date ascending with nulls last', async () => {
    const mgr = insertUser('mgr', true);
    const noDue = await makeWorkspace('Cardiology');
    const late = await makeWorkspace('Cardiology');
    const soon = await makeWorkspace('Cardiology');
    setDue(late, '2026-09-30T00:00:00Z');
    setDue(soon, '2026-09-18T00:00:00Z');

    const { rows } = await getQueueRows(mgr, 'all');
    expect(rows.map((r) => r.workspaceId)).toEqual([soon, late, noDue]);
  });

  it('breaks a due-date tie by created date descending', async () => {
    const mgr = insertUser('mgr', true);
    const older = await makeWorkspace('Cardiology');
    const newer = await makeWorkspace('Cardiology');
    setDue(older, '2026-09-18T00:00:00Z');
    setDue(newer, '2026-09-18T00:00:00Z');
    sqlite().prepare(`UPDATE referral_workspaces SET created_at = 100 WHERE id = ?`).run(older);
    sqlite().prepare(`UPDATE referral_workspaces SET created_at = 200 WHERE id = ?`).run(newer);

    const { rows } = await getQueueRows(mgr, 'all');
    expect(rows.map((r) => r.workspaceId)).toEqual([newer, older]);
  });
});

describe('getQueueRows row content', () => {
  it('carries the fields the queue view renders (AC7)', async () => {
    const mgr = insertUser('mgr', true);
    const wsId = await makeWorkspace('Cardiology');
    const { rows } = await getQueueRows(mgr, 'all');
    expect(rows[0]).toMatchObject({
      workspaceId: wsId,
      workStatus: WorkStatus.TRIAGE,
      referralState: ReferralState.RECEIVED,
      department: 'Cardiology',
      queueName: 'Cardiology',
      ownerDisplayName: null,
      overdue: false,
      needsTriage: false,
    });
    expect(rows[0].patientName).toMatch(/Test Patient/);
    expect(rows[0].patientDob).toBe('1980-01-01');
  });

  it('names an owner who was deactivated after being assigned', async () => {
    const mgr = insertUser('mgr', true);
    const owner = insertUser('leaver');
    const wsId = await makeWorkspace('Cardiology');
    sqlite()
      .prepare(`UPDATE referral_workspaces SET owner_user_id = ? WHERE id = ?`)
      .run(owner.id, wsId);
    sqlite().prepare(`UPDATE users SET active = 0 WHERE id = ?`).run(owner.id);

    const { rows } = await getQueueRows(mgr, 'all');
    expect(rows[0].ownerDisplayName).toBe('leaver');
    expect(rows[0].ownerInactive).toBe(true);
  });

  /** AC15: flagged only when the department genuinely matched nothing. */
  it('flags needsTriage for a department with no queue', async () => {
    const mgr = insertUser('mgr', true);
    sqlite().exec(`DELETE FROM queues WHERE slug = 'neurology'`);
    await makeWorkspace('Neurology');
    const { rows } = await getQueueRows(mgr, 'all');
    expect(rows[0].needsTriage).toBe(true);
  });

  /**
   * The case the first implementation got wrong. The flag was derived from the
   * resource catalogue, so a department that still EXISTS but whose queue is
   * gone read as fine. What matters is whether a queue would have claimed it.
   */
  it('flags needsTriage when the department is in the catalogue but its queue is deactivated', async () => {
    const mgr = insertUser('mgr', true);
    sqlite().exec(`UPDATE queues SET active = 0 WHERE slug = 'neurology'`);
    await makeWorkspace('Neurology');
    const { rows } = await getQueueRows(mgr, 'all');
    expect(getDepartments()).toContain('Neurology');
    expect(rows[0].needsTriage).toBe(true);
  });

  it('flags needsTriage for an Unassigned referral', async () => {
    const mgr = insertUser('mgr', true);
    await makeWorkspace('Unassigned');
    const { rows } = await getQueueRows(mgr, 'all');
    expect(rows[0].needsTriage).toBe(true);
  });

  it('does not flag needsTriage for a workspace moved to default by hand', async () => {
    const mgr = insertUser('mgr', true);
    const wsId = await makeWorkspace('Cardiology');
    await moveWorkspace(wsId, (await getDefaultQueue()).id, mgr, 'by hand');
    const { rows } = await getQueueRows(mgr, 'all');
    expect(rows[0].needsTriage).toBe(false);
  });
});

// ── Membership ───────────────────────────────────────────────────────────────

describe('queue membership', () => {
  it('adds, lists and removes a member with audit', async () => {
    const admin = insertUser('admin', true);
    const user = insertUser('coord');
    const cardio = (await getQueueBySlug('cardiology'))!.id;

    await addQueueMember(cardio, user.id, admin);
    expect(await listQueueMembers(cardio)).toEqual([
      { userId: user.id, displayName: 'coord', accessLevel: 'member', active: true },
    ]);
    expect(events('queue.member_added')).toHaveLength(1);

    await removeQueueMember(cardio, user.id, admin);
    expect(await listQueueMembers(cardio)).toEqual([]);
    expect(events('queue.member_removed')).toHaveLength(1);
  });

  it('revives rather than duplicating on re-add, and can change access level', async () => {
    const admin = insertUser('admin', true);
    const user = insertUser('coord');
    const cardio = (await getQueueBySlug('cardiology'))!.id;
    await addQueueMember(cardio, user.id, admin);
    await addQueueMember(cardio, user.id, admin, 'manager');
    const members = await listQueueMembers(cardio);
    expect(members).toHaveLength(1);
    expect(members[0].accessLevel).toBe('manager');
  });

  it('emits nothing when removing somebody who was not a member', async () => {
    const admin = insertUser('admin', true);
    const cardio = (await getQueueBySlug('cardiology'))!.id;
    await removeQueueMember(cardio, insertUser('stranger').id, admin);
    expect(events('queue.member_removed')).toHaveLength(0);
  });

  it('refuses membership changes on an unknown queue', async () => {
    const admin = insertUser('admin', true);
    await expect(addQueueMember(9999, admin.id, admin)).rejects.toThrow(QueueNotFoundError);
  });
});

// ── Saved filters ────────────────────────────────────────────────────────────

describe('saved filters', () => {
  it('saves, lists and reapplies a filter set identically (AC12)', async () => {
    const mgr = insertUser('mgr', true);
    const target = await makeWorkspace('Cardiology', WorkStatus.WAITING_EXTERNAL);
    await makeWorkspace('Neurology', WorkStatus.TRIAGE);

    const filters = { tab: 'waiting' as const, department: 'Cardiology' };
    const before = await getQueueRows(mgr, 'all', filters);

    await saveFilter(mgr.id, 'Cardio waiting', filters);
    const [saved] = await listSavedFilters(mgr.id);
    expect(saved.name).toBe('Cardio waiting');

    const after = await getQueueRows(mgr, 'all', saved.filters);
    expect(after.rows.map((r) => r.workspaceId)).toEqual(before.rows.map((r) => r.workspaceId));
    expect(after.rows.map((r) => r.workspaceId)).toEqual([target]);
  });

  it('replaces rather than duplicating when saving over a name', async () => {
    const mgr = insertUser('mgr', true);
    await saveFilter(mgr.id, 'Mine', { tab: 'open' });
    await saveFilter(mgr.id, 'Mine', { tab: 'exception' });
    const all = await listSavedFilters(mgr.id);
    expect(all).toHaveLength(1);
    expect(all[0].filters.tab).toBe('exception');
  });

  it('round-trips a date filter through JSON', async () => {
    const mgr = insertUser('mgr', true);
    await saveFilter(mgr.id, 'Due soon', { dueBefore: new Date('2026-09-20T00:00:00Z') });
    const [saved] = await listSavedFilters(mgr.id);
    expect(saved.filters.dueBefore?.toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('keeps each user filters separate and refuses a cross-user delete', async () => {
    const a = insertUser('a', true);
    const b = insertUser('b', true);
    const mine = await saveFilter(a.id, 'Mine', { tab: 'open' });

    expect(await listSavedFilters(b.id)).toEqual([]);
    await expect(deleteSavedFilter(b.id, mine.id)).rejects.toThrow(SavedFilterNotFoundError);
    expect(await listSavedFilters(a.id)).toHaveLength(1);

    await deleteSavedFilter(a.id, mine.id);
    expect(await listSavedFilters(a.id)).toEqual([]);
  });

  it('refuses a blank name', async () => {
    const mgr = insertUser('mgr', true);
    await expect(saveFilter(mgr.id, '   ', { tab: 'open' })).rejects.toThrow(/needs a name/);
  });
});

// ── Filter parsing ───────────────────────────────────────────────────────────

describe('parseFilters', () => {
  it('accepts the recognised vocabulary', () => {
    expect(
      parseFilters({
        tab: 'waiting',
        workStatus: 'Exception',
        referralState: 'Scheduled',
        ownerUserId: '7',
        department: 'Cardiology',
        overdueOnly: '1',
        dueBefore: '2026-09-20T00:00:00Z',
      }),
    ).toEqual({
      tab: 'waiting',
      workStatus: [WorkStatus.EXCEPTION],
      referralState: [ReferralState.SCHEDULED],
      ownerUserId: 7,
      department: 'Cardiology',
      overdueOnly: true,
      dueBefore: new Date('2026-09-20T00:00:00Z'),
    });
  });

  /** An allow-list: an unrecognised value is DROPPED, never passed through. */
  it('drops values outside the vocabulary', () => {
    expect(
      parseFilters({
        tab: 'nonsense',
        workStatus: "'; DROP TABLE referrals; --",
        referralState: 'NotAState',
        department: 'Astrology',
        dueBefore: 'not-a-date',
        ownerUserId: 'somebody',
      }),
    ).toEqual({});
  });

  it('never accepts a queue id — the slug in the path is the only queue selector', () => {
    expect(parseFilters({ queueId: 3, queue: 'neurology' } as Record<string, unknown>)).toEqual({});
  });

  it('tolerates malformed JSON rather than throwing', () => {
    expect(parseFilters('{not json')).toEqual({});
    expect(parseFilters(null)).toEqual({});
  });

  it('splits a comma-separated multi-value filter', () => {
    expect(parseFilters({ workStatus: 'Triage,Exception' }).workStatus).toEqual([
      WorkStatus.TRIAGE,
      WorkStatus.EXCEPTION,
    ]);
  });
});

// ── Backfill ─────────────────────────────────────────────────────────────────

describe('backfillQueues', () => {
  it('routes workspaces that predate queues and counts the rest as already routed', async () => {
    await makeWorkspace('Cardiology');
    const orphan = await makeWorkspace('Neurology');
    sqlite().prepare(`UPDATE referral_workspaces SET queue_id = NULL WHERE id = ?`).run(orphan);

    const result = await backfillQueues();
    expect(result).toEqual({ routed: 1, alreadyRouted: 1 });

    const row = sqlite()
      .prepare(`SELECT queue_id FROM referral_workspaces WHERE id = ?`)
      .get(orphan) as { queue_id: number };
    expect(row.queue_id).toBe((await getQueueBySlug('neurology'))!.id);
  });

  it('is idempotent', async () => {
    await makeWorkspace('Cardiology');
    await backfillQueues();
    expect(await backfillQueues()).toEqual({ routed: 0, alreadyRouted: 1 });
  });
});
