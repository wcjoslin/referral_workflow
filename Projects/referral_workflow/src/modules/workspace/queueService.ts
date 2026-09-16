/**
 * PRD-20 — shared queues and the referral queue view.
 *
 * There was no queue entity before this. What looked like queues were view-level
 * filters, and the dashboard's department filter runs in the BROWSER — fine for a
 * demo table, useless as a work queue and impossible to scope.
 *
 * THIS MODULE IS THE ONLY WRITER OF `referral_workspaces.queue_id`, for the same
 * reason assignmentService owns `owner_user_id`: keeping the column out of every
 * other update statement is what makes "no queue change without an event" true
 * by construction rather than by convention.
 *
 * ── WHAT QUEUE SCOPING IS, AND WHAT IT IS NOT ───────────────────────────────
 *
 * Every read here resolves the acting user's visible queues FIRST and applies
 * that as a SQL predicate BEFORE any caller-supplied filter. A caller cannot
 * widen its own scope by editing a query parameter, and a slug outside scope is
 * refused rather than quietly filtered to nothing. That property is real, it is
 * tested, and it is what separates this from the dashboard's client-side filter.
 *
 * It is NOT authentication, and nothing in this file may imply that it is. The
 * identity being scoped against comes from `tryGetActingUser()`, which reads a
 * cookie anybody can set and otherwise falls back to the first active user. A
 * person who wants another queue's rows can claim to be a member of it. That gap
 * is deferred out of the epic by an explicit decision and tracked as PRD-31;
 * deploying this application to a publicly reachable host is gated on it.
 *
 * So: a server-side least-privilege DEFAULT, not a PHI boundary.
 *
 * ── ACTOR CONVENTION ────────────────────────────────────────────────────────
 *
 * Mixed on purpose, matching what each function needs. Reads take the whole
 * `ActingUser` because scope resolution needs the user's id and
 * `allQueuesAccess`, not a label. `routeWorkspace()` takes a pre-formatted
 * `actor: string` because it runs from `createWorkspace()` where the actor is
 * `system` and there is no user at all.
 */

import { and, asc, desc, eq, exists, gte, inArray, isNull, lte, sql, SQL } from 'drizzle-orm';
import { db } from '../../db';
import {
  patients,
  queueMembers,
  queues,
  referralWorkspaces,
  referrals,
  savedFilters,
  workspaceParties,
} from '../../db/schema';
import { emitEvent } from '../analytics/eventService';
import { ReferralState } from '../../state/referralStateMachine';
import { WorkStatus } from '../../state/workStatusMachine';
import { getDepartments } from '../prd03/resourceCalendar';
import { QueueEvents, WorkspaceEvents } from './eventCatalog';
import { ActingUser, formatActor, getUser } from './identityService';

// ── Tabs ─────────────────────────────────────────────────────────────────────

export type QueueTab = 'open' | 'waiting' | 'exception' | 'completed';

export const QUEUE_TABS: readonly QueueTab[] = ['open', 'waiting', 'exception', 'completed'];

/**
 * The ONE place the tab vocabulary is defined.
 *
 * Exported as a single constant so the rows query, the counts and any later
 * consumer cannot disagree about what "Waiting" means — a disagreement that
 * would show a count of 5 above a list of 3 and be very hard to spot.
 *
 * Covers all seven work statuses exactly once. A test asserts that, so adding an
 * eighth status without placing it fails rather than silently making workspaces
 * invisible in every tab.
 *
 * `Follow-up-Required` sits under Completed rather than in its own tab because
 * the protocol loop IS closed — the referral came back needing something more,
 * which is a distinct marker on a completed row (AC5), not a fifth tab.
 */
export const TAB_WORK_STATUSES: Record<QueueTab, readonly WorkStatus[]> = {
  open: [WorkStatus.TRIAGE, WorkStatus.IN_PROGRESS],
  waiting: [WorkStatus.WAITING_EXTERNAL, WorkStatus.WAITING_INTERNAL],
  exception: [WorkStatus.EXCEPTION],
  completed: [WorkStatus.RESOLVED, WorkStatus.FOLLOW_UP_REQUIRED],
};

export function isQueueTab(value: string): value is QueueTab {
  return (QUEUE_TABS as readonly string[]).includes(value);
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * A queue that exists but is outside the caller's scope, AND a queue that does
 * not exist at all, both raise this. Deliberately one error: distinguishing them
 * would tell a caller which queues exist, which is exactly the enumeration the
 * scope predicate is there to prevent. The route answers 403 for both.
 */
export class QueueNotVisibleError extends Error {
  constructor(slug: string) {
    super(`Queue ${slug} is not available to this user`);
    this.name = 'QueueNotVisibleError';
  }
}

export class QueueNotFoundError extends Error {
  constructor(queueId: number) {
    super(`No queue with id ${queueId}`);
    this.name = 'QueueNotFoundError';
  }
}

export class NoDefaultQueueError extends Error {
  constructor() {
    super('No default queue is configured; run seedQueues()');
    this.name = 'NoDefaultQueueError';
  }
}

export class SavedFilterNotFoundError extends Error {
  constructor(id: number) {
    super(`No saved filter with id ${id} for this user`);
    this.name = 'SavedFilterNotFoundError';
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface Queue {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  departmentFilter: string | null;
  isDefault: boolean;
  active: boolean;
}

export interface QueueSummary extends Queue {
  counts: Record<QueueTab, number>;
  /** True when `departmentFilter` names a department the catalogue no longer has. */
  misconfigured: boolean;
}

export type OwnerSelector = number | 'unassigned' | 'me' | 'any';

export interface QueueFilters {
  tab?: QueueTab;
  workStatus?: WorkStatus[];
  referralState?: ReferralState[];
  ownerUserId?: OwnerSelector;
  partyOrgName?: string;
  department?: string;
  dueBefore?: Date;
  dueAfter?: Date;
  overdueOnly?: boolean;
}

export interface QueueRow {
  workspaceId: number;
  referralId: number;
  patientName: string;
  patientDob: string;
  referralState: ReferralState;
  workStatus: WorkStatus;
  ownerUserId: number | null;
  ownerDisplayName: string | null;
  ownerInactive: boolean;
  initiatingOrgName: string | null;
  department: string;
  queueId: number | null;
  queueName: string | null;
  nextAction: string | null;
  nextActionDueAt: string | null;
  overdue: boolean;
  needsTriage: boolean;
  priorityFlag: boolean;
  createdAt: string;
}

export type QueueRoutingReason =
  | 'department-match'
  | 'department-unassigned'
  | 'department-no-queue'
  | 'department-ambiguous';

export interface QueueResolution {
  queueId: number;
  /** False when the department fell back to the default queue — drives `needsTriage`. */
  matched: boolean;
  reason: QueueRoutingReason;
}

function toQueue(row: typeof queues.$inferSelect): Queue {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    departmentFilter: row.departmentFilter,
    isDefault: row.isDefault,
    active: row.active,
  };
}

// ── Scope resolution ─────────────────────────────────────────────────────────

/**
 * The queues this user may read, resolved before any filter.
 *
 * Returns `'all'` for a user holding the explicit `allQueuesAccess` grant, and
 * `[]` for a user in no queue — which is the empty state (AC2), NOT a licence to
 * see everything. Getting that fallback backwards is the classic version of this
 * bug, so it is asserted directly in a test.
 *
 * `allQueuesAccess` is an explicit column (PRD-17). It is never inferred from
 * `jobRole`, and never from an empty membership list.
 */
export async function getVisibleQueueIds(user: ActingUser): Promise<number[] | 'all'> {
  if (user.allQueuesAccess) return 'all';

  const rows = await db
    .select({ queueId: queueMembers.queueId })
    .from(queueMembers)
    .where(eq(queueMembers.userId, user.id));

  // The unique index makes these already distinct; the Set is belt and braces
  // against a database that predates it.
  return [...new Set(rows.map((r) => r.queueId))];
}

/**
 * Turns resolved scope into a SQL predicate, or null when scope is `'all'`.
 *
 * An empty scope becomes `sql`1 = 0`` rather than `undefined`. That distinction
 * is the whole ballgame: returning `undefined` for "no queues" would drop the
 * WHERE clause and show the user every workspace in the system.
 */
function scopeClause(scope: number[] | 'all'): SQL | undefined {
  if (scope === 'all') return undefined;
  if (scope.length === 0) return sql`1 = 0`;
  return inArray(referralWorkspaces.queueId, scope);
}

// ── Queue reads ──────────────────────────────────────────────────────────────

export async function getQueueBySlug(slug: string): Promise<Queue | null> {
  const [row] = await db.select().from(queues).where(eq(queues.slug, slug)).limit(1);
  return row ? toQueue(row) : null;
}

export async function getDefaultQueue(): Promise<Queue> {
  const rows = await db
    .select()
    .from(queues)
    .where(eq(queues.isDefault, true))
    .orderBy(asc(queues.id));
  if (rows.length === 0) throw new NoDefaultQueueError();
  // More than one default is a configuration error. Resolve deterministically by
  // lowest id and report it rather than picking arbitrarily per call.
  if (rows.length > 1) {
    void emitEvent({
      eventType: QueueEvents.MISCONFIGURED,
      entityType: 'referral',
      entityId: rows[0].id,
      actor: 'system',
      metadata: {
        problem: 'multiple-default-queues',
        queueIds: rows.map((r) => r.id),
        resolvedTo: rows[0].id,
      },
    }).catch((err) => console.error('[QueueService]', err));
  }
  return toQueue(rows[0]);
}

/**
 * Resolves a queue by slug, refusing anything outside the caller's scope.
 *
 * THE single gate for a slug-addressed read. Both routes go through it, so "a
 * client cannot request a queue it does not belong to and receive data" (AC4) is
 * one function rather than a rule each route remembers.
 */
export async function resolveVisibleQueue(user: ActingUser, slug: string): Promise<Queue> {
  const queue = await getQueueBySlug(slug);
  if (!queue) throw new QueueNotVisibleError(slug);

  const scope = await getVisibleQueueIds(user);
  if (scope !== 'all' && !scope.includes(queue.id)) throw new QueueNotVisibleError(slug);

  return queue;
}

/** True when this queue's department filter names something the catalogue lost. */
function isMisconfigured(queue: Queue, departments: string[]): boolean {
  return queue.departmentFilter !== null && !departments.includes(queue.departmentFilter);
}

/**
 * The queues visible to this user, each with its per-tab counts.
 *
 * Counts are computed within scope (AC6) — a queue the user cannot read
 * contributes nothing, including to a total.
 */
export async function listQueues(user: ActingUser): Promise<QueueSummary[]> {
  const scope = await getVisibleQueueIds(user);
  if (scope !== 'all' && scope.length === 0) return [];

  const rows = await db
    .select()
    .from(queues)
    .where(scope === 'all' ? undefined : inArray(queues.id, scope))
    .orderBy(asc(queues.isDefault), asc(queues.name));

  const departments = getDepartments();

  // One grouped query for every queue's counts rather than one query per queue
  // per tab, which would be 4n round trips.
  const counted = await db
    .select({
      queueId: referralWorkspaces.queueId,
      workStatus: referralWorkspaces.workStatus,
      n: sql<number>`COUNT(*)`,
    })
    .from(referralWorkspaces)
    .where(and(isNull(referralWorkspaces.archivedAt), scopeClause(scope)))
    .groupBy(referralWorkspaces.queueId, referralWorkspaces.workStatus);

  return rows.map((row) => {
    const queue = toQueue(row);
    const counts = emptyCounts();
    for (const c of counted) {
      if (c.queueId !== queue.id) continue;
      const tab = tabForStatus(c.workStatus as WorkStatus);
      if (tab) counts[tab] += Number(c.n);
    }
    return { ...queue, counts, misconfigured: isMisconfigured(queue, departments) };
  });
}

function emptyCounts(): Record<QueueTab, number> {
  return { open: 0, waiting: 0, exception: 0, completed: 0 };
}

/** Inverse of TAB_WORK_STATUSES. Null for a status no tab claims. */
export function tabForStatus(status: WorkStatus): QueueTab | null {
  for (const tab of QUEUE_TABS) {
    if (TAB_WORK_STATUSES[tab].includes(status)) return tab;
  }
  return null;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/**
 * Builds the caller-supplied half of the WHERE clause.
 *
 * Separate from the scope predicate on purpose. The two are combined by
 * `getQueueRows()` with scope first, and keeping them in different functions
 * makes it impossible to write a filter that replaces scope rather than
 * narrowing it.
 */
function filterClauses(user: ActingUser, filters: QueueFilters, now: Date): (SQL | undefined)[] {
  const clauses: (SQL | undefined)[] = [];

  // Tab and explicit workStatus intersect rather than override: an explicit
  // status outside the tab yields nothing, which is the honest answer.
  if (filters.tab) {
    clauses.push(inArray(referralWorkspaces.workStatus, [...TAB_WORK_STATUSES[filters.tab]]));
  }
  if (filters.workStatus && filters.workStatus.length > 0) {
    clauses.push(inArray(referralWorkspaces.workStatus, filters.workStatus));
  }
  if (filters.referralState && filters.referralState.length > 0) {
    clauses.push(inArray(referrals.state, filters.referralState));
  }

  if (filters.ownerUserId === 'unassigned') {
    clauses.push(isNull(referralWorkspaces.ownerUserId));
  } else if (filters.ownerUserId === 'me') {
    clauses.push(eq(referralWorkspaces.ownerUserId, user.id));
  } else if (typeof filters.ownerUserId === 'number') {
    clauses.push(eq(referralWorkspaces.ownerUserId, filters.ownerUserId));
  }

  if (filters.department) {
    clauses.push(eq(referrals.routingDepartment, filters.department));
  }

  // Party organization (AC10). An EXISTS subquery rather than a join, because a
  // workspace has several parties and joining would multiply the row out — the
  // same referral appearing three times because it has three counterparties.
  // Matched case-insensitively: org names are observed from inbound addresses
  // and arrive with inconsistent casing (the reason PRD-24 added a lowercase
  // expression index on the address column).
  if (filters.partyOrgName) {
    const needle = filters.partyOrgName.toLowerCase();
    clauses.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(workspaceParties)
          .where(
            and(
              eq(workspaceParties.workspaceId, referralWorkspaces.id),
              sql`LOWER(${workspaceParties.orgName}) = ${needle}`,
            ),
          ),
      ),
    );
  }

  if (filters.dueAfter) clauses.push(gte(referralWorkspaces.nextActionDueAt, filters.dueAfter));
  if (filters.dueBefore) clauses.push(lte(referralWorkspaces.nextActionDueAt, filters.dueBefore));

  // Overdue means a due date strictly in the past. A workspace with no due date
  // is NOT overdue — PRD-26 owns the values and a null is "no commitment made",
  // not "late".
  if (filters.overdueOnly) {
    clauses.push(lte(referralWorkspaces.nextActionDueAt, now));
  }

  return clauses;
}

/**
 * The queue view's rows and tab counts.
 *
 * `queueSlug` of `'all'` means every queue in scope, not every queue — for a
 * user without `allQueuesAccess` it is still their memberships.
 *
 * SCOPE IS APPLIED FIRST, and the counts use the same scope as the rows so they
 * cannot disagree. The counts deliberately ignore `filters.tab` (so every tab
 * shows its own total) while honouring every other filter, which is what makes
 * the tab strip usable while a filter is active.
 */
export async function getQueueRows(
  user: ActingUser,
  /** A queue slug, or the reserved value `'all'` described above. */
  queueSlug: string,
  filters: QueueFilters = {},
  now: Date = new Date(),
): Promise<{ queue: Queue | null; counts: Record<QueueTab, number>; rows: QueueRow[] }> {
  const scope = await getVisibleQueueIds(user);

  let queue: Queue | null = null;
  let queueClause: SQL | undefined;

  if (queueSlug === 'all') {
    queueClause = scopeClause(scope);
  } else {
    // Throws for an out-of-scope or unknown slug. Never degrades to 'all'.
    queue = await resolveVisibleQueue(user, queueSlug);
    queueClause = eq(referralWorkspaces.queueId, queue.id);
  }

  const base = [isNull(referralWorkspaces.archivedAt), queueClause];
  const userClauses = filterClauses(user, filters, now);

  // Counts honour every filter EXCEPT the tab, so each tab shows its own total
  // while a filter is active. Copy-and-delete rather than destructuring, which
  // would leave an unused binding.
  const countFilters: QueueFilters = { ...filters };
  delete countFilters.tab;
  const countClauses = filterClauses(user, countFilters, now);

  const defaultQueue = await getDefaultQueue();

  const selection = {
    workspaceId: referralWorkspaces.id,
    referralId: referralWorkspaces.referralId,
    workStatus: referralWorkspaces.workStatus,
    ownerUserId: referralWorkspaces.ownerUserId,
    queueId: referralWorkspaces.queueId,
    nextAction: referralWorkspaces.nextAction,
    nextActionDueAt: referralWorkspaces.nextActionDueAt,
    createdAt: referralWorkspaces.createdAt,
    referralState: referrals.state,
    department: referrals.routingDepartment,
    priorityFlag: referrals.priorityFlag,
    firstName: patients.firstName,
    lastName: patients.lastName,
    dob: patients.dateOfBirth,
  };

  const rows = await db
    .select(selection)
    .from(referralWorkspaces)
    .innerJoin(referrals, eq(referrals.id, referralWorkspaces.referralId))
    .innerJoin(patients, eq(patients.id, referrals.patientId))
    .where(and(...base, ...userClauses))
    // AC8: due date ascending with NULLS LAST, then created date descending.
    // SQLite has no NULLS LAST, so sort on the null-ness first. Written as raw
    // SQL because drizzle has no NULLS LAST builder and a CASE expression here
    // is clearer than an ordered union.
    .orderBy(
      sql`CASE WHEN ${referralWorkspaces.nextActionDueAt} IS NULL THEN 1 ELSE 0 END`,
      asc(referralWorkspaces.nextActionDueAt),
      desc(referralWorkspaces.createdAt),
    );

  const counted = await db
    .select({ workStatus: referralWorkspaces.workStatus, n: sql<number>`COUNT(*)` })
    .from(referralWorkspaces)
    .innerJoin(referrals, eq(referrals.id, referralWorkspaces.referralId))
    .where(and(...base, ...countClauses))
    .groupBy(referralWorkspaces.workStatus);

  const counts = emptyCounts();
  for (const c of counted) {
    const t = tabForStatus(c.workStatus as WorkStatus);
    if (t) counts[t] += Number(c.n);
  }

  const orgNames = await initiatingOrgNames(rows.map((r) => r.workspaceId));
  const owners = await ownerLabels(rows.map((r) => r.ownerUserId));
  const queueNames = await queueNamesFor(rows.map((r) => r.queueId));

  // Departments that some ACTIVE QUEUE claims — not the resource catalogue.
  //
  // This distinction is the whole meaning of needsTriage and the first version
  // got it wrong. `getDepartments()` is the catalogue of departments that
  // EXIST; what the flag asks is whether anything would have CLAIMED this
  // referral. A department in the catalogue whose queue was deleted or
  // deactivated has to read as needing triage, and it did not when the flag was
  // derived from the catalogue.
  const claimedDepartments = new Set(
    (
      await db
        .select({ department: queues.departmentFilter })
        .from(queues)
        .where(eq(queues.active, true))
    )
      .map((q) => q.department)
      .filter((d): d is string => d !== null),
  );

  return {
    queue,
    counts,
    rows: rows.map((r) => ({
      workspaceId: r.workspaceId,
      referralId: r.referralId,
      patientName: `${r.firstName} ${r.lastName}`.trim(),
      patientDob: r.dob,
      referralState: r.referralState as ReferralState,
      workStatus: r.workStatus as WorkStatus,
      ownerUserId: r.ownerUserId,
      ownerDisplayName:
        r.ownerUserId === null ? null : (owners.get(r.ownerUserId)?.displayName ?? null),
      ownerInactive: r.ownerUserId !== null && owners.get(r.ownerUserId)?.active === false,
      initiatingOrgName: orgNames.get(r.workspaceId) ?? null,
      department: r.department,
      queueId: r.queueId,
      queueName: r.queueId === null ? null : (queueNames.get(r.queueId) ?? null),
      nextAction: r.nextAction,
      nextActionDueAt: r.nextActionDueAt ? r.nextActionDueAt.toISOString() : null,
      overdue: r.nextActionDueAt !== null && r.nextActionDueAt.getTime() < now.getTime(),
      // AC15: in the default queue BECAUSE nothing claimed its department.
      //
      // Both halves are needed. A referral whose department has its own queue
      // but was moved to default by hand is not "needs triage" — that was a
      // decision, and flagging it would train people to ignore the flag.
      needsTriage:
        r.queueId === defaultQueue.id &&
        !claimedDepartments.has(r.department) &&
        defaultQueue.departmentFilter !== r.department,
      priorityFlag: !!r.priorityFlag,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/** One query for the initiating party of every row, not one per row. */
async function initiatingOrgNames(workspaceIds: number[]): Promise<Map<number, string>> {
  const ids = [...new Set(workspaceIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ workspaceId: workspaceParties.workspaceId, orgName: workspaceParties.orgName })
    .from(workspaceParties)
    .where(
      and(inArray(workspaceParties.workspaceId, ids), eq(workspaceParties.partyRole, 'initiating')),
    );
  const map = new Map<number, string>();
  for (const r of rows) if (r.orgName) map.set(r.workspaceId, r.orgName);
  return map;
}

async function ownerLabels(
  ownerIds: (number | null)[],
): Promise<Map<number, { displayName: string; active: boolean }>> {
  const ids = [...new Set(ownerIds.filter((id): id is number => id !== null))];
  const map = new Map<number, { displayName: string; active: boolean }>();
  for (const id of ids) {
    // getUser() returns deactivated users deliberately, so a workspace held by
    // someone who has left reads as theirs-and-inactive, not as unassigned.
    const user = await getUser(id);
    if (user) map.set(id, { displayName: user.displayName, active: user.active });
  }
  return map;
}

async function queueNamesFor(queueIds: (number | null)[]): Promise<Map<number, string>> {
  const ids = [...new Set(queueIds.filter((id): id is number => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: queues.id, name: queues.name })
    .from(queues)
    .where(inArray(queues.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ── Routing ──────────────────────────────────────────────────────────────────

/**
 * Which queue a department belongs to.
 *
 * Returns the match reason, not just an id: AC15's `needsTriage` and AC16's
 * routing reason are both this fact, and re-deriving it by comparing the result
 * against the default queue is the kind of duplicated inference that drifts.
 *
 * Two queues claiming one department is a configuration error. Resolved
 * deterministically by lowest id and reported, rather than left to whichever row
 * the query happens to return first.
 */
export async function resolveQueueForDepartment(department: string): Promise<QueueResolution> {
  const fallback = await getDefaultQueue();

  if (!department || department === 'Unassigned') {
    return { queueId: fallback.id, matched: false, reason: 'department-unassigned' };
  }

  const matches = await db
    .select()
    .from(queues)
    .where(and(eq(queues.departmentFilter, department), eq(queues.active, true)))
    .orderBy(asc(queues.id));

  if (matches.length === 0) {
    return { queueId: fallback.id, matched: false, reason: 'department-no-queue' };
  }

  if (matches.length > 1) {
    void emitEvent({
      eventType: QueueEvents.MISCONFIGURED,
      entityType: 'referral',
      entityId: matches[0].id,
      actor: 'system',
      metadata: {
        problem: 'duplicate-department-filter',
        department,
        queueIds: matches.map((m) => m.id),
        resolvedTo: matches[0].id,
      },
    }).catch((err) => console.error('[QueueService]', err));
    return { queueId: matches[0].id, matched: true, reason: 'department-ambiguous' };
  }

  return { queueId: matches[0].id, matched: true, reason: 'department-match' };
}

/**
 * Routes a workspace from its referral's department. Called at creation.
 *
 * IDEMPOTENT: a workspace that already has a queue keeps it and no event is
 * emitted. That is what makes this safe to call from the backfill over a
 * database that has already been routed, and it is also what implements AC18 —
 * changing `routing_department` later does not silently re-queue, because
 * routing simply does not run again.
 */
export async function routeWorkspace(
  workspaceId: number,
  actor = 'system',
): Promise<number | null> {
  const [ws] = await db
    .select({ id: referralWorkspaces.id, queueId: referralWorkspaces.queueId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  if (!ws) return null;
  if (ws.queueId !== null) return ws.queueId;

  const [referral] = await db
    .select({ department: referrals.routingDepartment })
    .from(referrals)
    .innerJoin(referralWorkspaces, eq(referralWorkspaces.referralId, referrals.id))
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);

  const resolution = await resolveQueueForDepartment(referral?.department ?? 'Unassigned');

  await db
    .update(referralWorkspaces)
    .set({ queueId: resolution.queueId, updatedAt: new Date() })
    .where(eq(referralWorkspaces.id, workspaceId));

  await emitEvent({
    eventType: WorkspaceEvents.QUEUE_CHANGED,
    entityType: 'referral',
    entityId: workspaceId,
    toState: String(resolution.queueId),
    actor,
    metadata: {
      workspaceId,
      toQueueId: resolution.queueId,
      fromQueueId: null,
      department: referral?.department ?? null,
      reason: resolution.reason,
      matched: resolution.matched,
    },
  });

  return resolution.queueId;
}

/**
 * Moves a workspace to another queue by hand (AC17).
 *
 * Audited with the PREVIOUS queue in the metadata, because "which queue did this
 * come from" is the question anybody asks about a misrouted referral and it is
 * unrecoverable once overwritten.
 */
export async function moveWorkspace(
  workspaceId: number,
  toQueueId: number,
  actor: ActingUser,
  reason?: string,
): Promise<void> {
  const [ws] = await db
    .select({ id: referralWorkspaces.id, queueId: referralWorkspaces.queueId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw new QueueNotFoundError(workspaceId);

  const [target] = await db.select().from(queues).where(eq(queues.id, toQueueId)).limit(1);
  if (!target) throw new QueueNotFoundError(toQueueId);

  if (ws.queueId === toQueueId) return;

  await db
    .update(referralWorkspaces)
    .set({ queueId: toQueueId, updatedAt: new Date() })
    .where(eq(referralWorkspaces.id, workspaceId));

  await emitEvent({
    eventType: WorkspaceEvents.QUEUE_CHANGED,
    entityType: 'referral',
    entityId: workspaceId,
    fromState: ws.queueId === null ? undefined : String(ws.queueId),
    toState: String(toQueueId),
    actor: formatActor(actor),
    metadata: {
      workspaceId,
      fromQueueId: ws.queueId,
      toQueueId,
      reason: reason ?? null,
      manual: true,
    },
  });
}

/**
 * Deactivates a queue, moving its workspaces to the default queue.
 *
 * Each move is audited individually rather than as one bulk event: a workspace
 * that changed queue with no event against it is exactly the gap the
 * single-writer rule above exists to prevent.
 */
export async function deactivateQueue(queueId: number, actor: ActingUser): Promise<number> {
  const [queue] = await db.select().from(queues).where(eq(queues.id, queueId)).limit(1);
  if (!queue) throw new QueueNotFoundError(queueId);
  if (queue.isDefault) throw new Error('The default queue cannot be deactivated');

  const fallback = await getDefaultQueue();
  const held = await db
    .select({ id: referralWorkspaces.id })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.queueId, queueId));

  for (const ws of held) {
    await moveWorkspace(ws.id, fallback.id, actor, `queue ${queue.slug} deactivated`);
  }

  await db.update(queues).set({ active: false }).where(eq(queues.id, queueId));
  return held.length;
}

// ── Membership ───────────────────────────────────────────────────────────────

export async function addQueueMember(
  queueId: number,
  userId: number,
  actor: ActingUser,
  accessLevel: 'member' | 'manager' = 'member',
): Promise<void> {
  const [queue] = await db.select().from(queues).where(eq(queues.id, queueId)).limit(1);
  if (!queue) throw new QueueNotFoundError(queueId);

  // Revive rather than duplicate, which is what idx_queue_members_unique makes
  // possible. onConflictDoUpdate so re-adding can change the access level.
  await db
    .insert(queueMembers)
    .values({ queueId, userId, accessLevel, addedAt: new Date() })
    .onConflictDoUpdate({
      target: [queueMembers.queueId, queueMembers.userId],
      set: { accessLevel },
    });

  await emitEvent({
    eventType: QueueEvents.MEMBER_ADDED,
    entityType: 'referral',
    entityId: queueId,
    actor: formatActor(actor),
    metadata: { queueId, queueSlug: queue.slug, userId, accessLevel },
  });
}

export async function removeQueueMember(
  queueId: number,
  userId: number,
  actor: ActingUser,
): Promise<void> {
  const [queue] = await db.select().from(queues).where(eq(queues.id, queueId)).limit(1);
  if (!queue) throw new QueueNotFoundError(queueId);

  const result = await db
    .delete(queueMembers)
    .where(and(eq(queueMembers.queueId, queueId), eq(queueMembers.userId, userId)));

  // Only audit an actual removal. Emitting for a no-op would put a membership
  // change in the feed that never happened.
  if ((result as unknown as { changes?: number }).changes === 0) return;

  await emitEvent({
    eventType: QueueEvents.MEMBER_REMOVED,
    entityType: 'referral',
    entityId: queueId,
    actor: formatActor(actor),
    metadata: { queueId, queueSlug: queue.slug, userId },
  });
}

export interface QueueMemberSummary {
  userId: number;
  displayName: string;
  accessLevel: string;
  active: boolean;
}

export async function listQueueMembers(queueId: number): Promise<QueueMemberSummary[]> {
  const rows = await db
    .select({ userId: queueMembers.userId, accessLevel: queueMembers.accessLevel })
    .from(queueMembers)
    .where(eq(queueMembers.queueId, queueId));

  const out: QueueMemberSummary[] = [];
  for (const r of rows) {
    const user = await getUser(r.userId);
    if (!user) continue;
    out.push({
      userId: r.userId,
      displayName: user.displayName,
      accessLevel: r.accessLevel,
      active: user.active,
    });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ── Saved filters ────────────────────────────────────────────────────────────

export interface SavedFilter {
  id: number;
  name: string;
  surface: string;
  filters: QueueFilters;
  createdAt: string;
}

/**
 * Filters are stored as JSON and re-read through `parseFilters()`, never trusted
 * as-is. A saved set is caller-supplied data that has been sitting in a table,
 * so it goes through the same parsing as a fresh query string — it is not a
 * privileged path into the filter object.
 */
export async function listSavedFilters(userId: number, surface = 'queue'): Promise<SavedFilter[]> {
  const rows = await db
    .select()
    .from(savedFilters)
    .where(and(eq(savedFilters.userId, userId), eq(savedFilters.surface, surface)))
    .orderBy(asc(savedFilters.name));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    surface: r.surface,
    filters: parseFilters(r.filtersJson),
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function saveFilter(
  userId: number,
  name: string,
  filters: QueueFilters,
  surface = 'queue',
): Promise<SavedFilter> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A saved filter needs a name');

  const now = new Date();
  // Saving over a name replaces it — what idx_saved_filters_name is for.
  const [row] = await db
    .insert(savedFilters)
    .values({ userId, name: trimmed, surface, filtersJson: serialiseFilters(filters), createdAt: now })
    .onConflictDoUpdate({
      target: [savedFilters.userId, savedFilters.surface, savedFilters.name],
      set: { filtersJson: serialiseFilters(filters), createdAt: now },
    })
    .returning();

  return {
    id: row.id,
    name: row.name,
    surface: row.surface,
    filters: parseFilters(row.filtersJson),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function deleteSavedFilter(userId: number, id: number): Promise<void> {
  const result = await db
    .delete(savedFilters)
    .where(and(eq(savedFilters.id, id), eq(savedFilters.userId, userId)));
  // Scoped to the owner, so deleting somebody else's filter is a miss rather
  // than a cross-user delete.
  if ((result as unknown as { changes?: number }).changes === 0) {
    throw new SavedFilterNotFoundError(id);
  }
}

function serialiseFilters(filters: QueueFilters): string {
  return JSON.stringify({
    ...filters,
    dueBefore: filters.dueBefore ? filters.dueBefore.toISOString() : undefined,
    dueAfter: filters.dueAfter ? filters.dueAfter.toISOString() : undefined,
  });
}

/**
 * Parses a stored or query-string filter set, dropping anything unrecognised.
 *
 * An allow-list: every field is checked against the vocabulary it belongs to,
 * and a value that does not match is DROPPED rather than passed through. A
 * `workStatus` of `"'; DROP TABLE"` becomes absent, not a filter — drizzle
 * parameterises regardless, but a filter the caller can populate with arbitrary
 * strings is still a filter nobody can reason about.
 *
 * Deliberately does NOT parse a queue id. Queue selection is the slug in the
 * path, resolved through `resolveVisibleQueue()`; accepting one here would be a
 * second, unscoped way to choose a queue.
 */
export function parseFilters(raw: string | Record<string, unknown> | null): QueueFilters {
  let obj: Record<string, unknown>;
  if (raw === null) return {};
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  } else {
    obj = raw;
  }
  if (!obj || typeof obj !== 'object') return {};

  const out: QueueFilters = {};

  if (typeof obj.tab === 'string' && isQueueTab(obj.tab)) out.tab = obj.tab;

  const statuses = asStringArray(obj.workStatus).filter((s): s is WorkStatus =>
    (Object.values(WorkStatus) as string[]).includes(s),
  );
  if (statuses.length > 0) out.workStatus = statuses;

  const states = asStringArray(obj.referralState).filter((s): s is ReferralState =>
    (Object.values(ReferralState) as string[]).includes(s),
  );
  if (states.length > 0) out.referralState = states;

  if (obj.ownerUserId === 'unassigned' || obj.ownerUserId === 'me' || obj.ownerUserId === 'any') {
    out.ownerUserId = obj.ownerUserId;
  } else if (typeof obj.ownerUserId === 'number' && Number.isInteger(obj.ownerUserId)) {
    out.ownerUserId = obj.ownerUserId;
  } else if (typeof obj.ownerUserId === 'string' && /^\d+$/.test(obj.ownerUserId)) {
    out.ownerUserId = Number(obj.ownerUserId);
  }

  if (typeof obj.partyOrgName === 'string' && obj.partyOrgName.trim()) {
    out.partyOrgName = obj.partyOrgName.trim();
  }

  // Validated against the catalogue, matching what POST /api/referrals/:id/routing
  // already does. An unknown department is dropped, not queried for.
  if (typeof obj.department === 'string' && getDepartments().includes(obj.department)) {
    out.department = obj.department;
  }

  const before = asDate(obj.dueBefore);
  if (before) out.dueBefore = before;
  const after = asDate(obj.dueAfter);
  if (after) out.dueAfter = after;

  if (obj.overdueOnly === true || obj.overdueOnly === '1' || obj.overdueOnly === 'true') {
    out.overdueOnly = true;
  }

  return out;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') return value ? value.split(',').map((s) => s.trim()) : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function asDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// ── Seeding ──────────────────────────────────────────────────────────────────

/** Slug for the catch-all queue. Referenced by the seed and the backfill. */
export const DEFAULT_QUEUE_SLUG = 'general-intake';

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * One queue per catalogue department plus the catch-all, idempotent on slug.
 *
 * NOT in the migration, for the reason `seedUsers()` is not: seeding is
 * application logic that has to re-run against an existing database, and a
 * migration runs exactly once. A department added to the catalogue later gets
 * its queue on the next seed.
 */
export async function seedQueues(): Promise<{ created: number; existing: number }> {
  const now = new Date();
  let created = 0;
  let existing = 0;

  const wanted: Array<{ name: string; slug: string; department: string | null; isDefault: boolean }> =
    [
      {
        name: 'General Intake',
        slug: DEFAULT_QUEUE_SLUG,
        department: null,
        isDefault: true,
      },
      ...getDepartments().map((d) => ({
        name: d,
        slug: slugify(d),
        department: d,
        isDefault: false,
      })),
    ];

  for (const q of wanted) {
    const [found] = await db.select().from(queues).where(eq(queues.slug, q.slug)).limit(1);
    if (found) {
      existing += 1;
      continue;
    }
    await db.insert(queues).values({
      name: q.name,
      slug: q.slug,
      description:
        q.department === null
          ? 'Referrals whose department matches no other queue, and anything needing triage'
          : `${q.department} referrals`,
      departmentFilter: q.department,
      isDefault: q.isDefault,
      active: true,
      createdAt: now,
    });
    created += 1;
  }

  return { created, existing };
}

/**
 * Routes every unrouted workspace. Idempotent because `routeWorkspace()` is.
 *
 * Used by `scripts/backfill-queues.ts` for a database that predates this PRD.
 */
export async function backfillQueues(): Promise<{
  routed: number;
  alreadyRouted: number;
}> {
  const rows = await db
    .select({ id: referralWorkspaces.id, queueId: referralWorkspaces.queueId })
    .from(referralWorkspaces);

  let routed = 0;
  let alreadyRouted = 0;
  for (const ws of rows) {
    if (ws.queueId !== null) {
      alreadyRouted += 1;
      continue;
    }
    await routeWorkspace(ws.id, 'system');
    routed += 1;
  }
  return { routed, alreadyRouted };
}
