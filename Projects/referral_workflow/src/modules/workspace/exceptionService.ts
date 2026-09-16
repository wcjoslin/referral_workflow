/**
 * PRD-28 — the exception queue.
 *
 * Every inbound artifact this system could not place used to vanish into a log
 * line. This module is where it goes instead.
 *
 * ── THE ONE RULE THAT MATTERS MOST ──────────────────────────────────────────
 *
 * **Reassociation NEVER replays a protocol transition.** Attaching an orphaned
 * message to a workspace is a RECORDS operation; advancing `referrals.state` is
 * a PROTOCOL operation. Coupling them would let a mis-association corrupt the
 * authoritative external state — the single thing the epic's dual-status rule
 * exists to protect. So `reassociate()` writes a thread row and a document, and
 * touches `referrals.state` not at all. Advancing state stays an explicit,
 * separate action (AC14), and a test asserts the state is unchanged.
 *
 * ── RAISING IS FIRE-AND-FORGET, BUT NOT BEST-EFFORT ─────────────────────────
 *
 * Exceptions are raised from detecting code paths — ingest, ACK handling, the
 * gateway — so raising one must never fail the operation that detected it.
 * BUT unlike an audit event, an exception that fails to persist is DATA LOSS:
 * the row is frequently the only remaining copy of the artifact. So
 * `raiseExceptionSafely()` retries once and logs loudly, rather than swallowing
 * the way a `void emitEvent(...).catch()` does.
 */

import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  autoDeclinedReferrals,
  patients,
  referralWorkspaces,
  referrals,
  workspaceExceptions,
  workspaceParties,
} from '../../db/schema';
import { emitEvent } from '../analytics/eventService';
import { ReferralState } from '../../state/referralStateMachine';
import { WorkStatus } from '../../state/workStatusMachine';
import { WorkspaceEvents } from './eventCatalog';
import { ActingUser, formatActor } from './identityService';

export type ExceptionType =
  | 'unmatched-ack'
  | 'ack-error-code'
  | 'unmatched-message'
  | 'out-of-order'
  | 'duplicate-message'
  | 'auto-declined'
  | 'duplicate-patient'
  | 'delivery-failed'
  | 'counterparty-rejected'
  | 'unresolvable-address'
  | 'unlinked-attachment-request';

export const EXCEPTION_TYPES: readonly ExceptionType[] = [
  'unmatched-ack',
  'ack-error-code',
  'unmatched-message',
  'out-of-order',
  'duplicate-message',
  'auto-declined',
  'duplicate-patient',
  'delivery-failed',
  'counterparty-rejected',
  'unresolvable-address',
  'unlinked-attachment-request',
];

export function isExceptionType(value: string): value is ExceptionType {
  return (EXCEPTION_TYPES as readonly string[]).includes(value);
}

export type ExceptionResolution =
  | 'reassociated'
  | 'converted'
  | 'confirmed-distinct'
  | 'confirmed-same'
  | 'dismissed'
  | 'retried';

export const EXCEPTION_RESOLUTIONS: readonly ExceptionResolution[] = [
  'reassociated',
  'converted',
  'confirmed-distinct',
  'confirmed-same',
  'dismissed',
  'retried',
];

export function isExceptionResolution(value: string): value is ExceptionResolution {
  return (EXCEPTION_RESOLUTIONS as readonly string[]).includes(value);
}

/**
 * Raw content is capped and the truncation is RECORDED rather than silent.
 *
 * A C-CDA can be hundreds of kilobytes and this column is the only copy, so the
 * cap is generous. But an exception row that silently lost half its artifact is
 * worse than one that says it did — a coordinator needs to know the content is
 * partial before concluding the message was malformed.
 */
export const MAX_RAW_CONTENT = 256 * 1024;
const TRUNCATION_MARKER = '\n\n[... truncated by PRD-28: content exceeded 256 KB ...]';

export class ExceptionNotFoundError extends Error {
  constructor(id: number) {
    super(`No exception with id ${id}`);
    this.name = 'ExceptionNotFoundError';
  }
}

export class ExceptionAlreadyResolvedError extends Error {
  constructor(id: number) {
    super(`Exception ${id} is already resolved`);
    this.name = 'ExceptionAlreadyResolvedError';
  }
}

export class ExceptionWorkspaceNotFoundError extends Error {
  constructor(workspaceId: number) {
    super(`No workspace with id ${workspaceId}`);
    this.name = 'ExceptionWorkspaceNotFoundError';
  }
}

export class WrongExceptionTypeError extends Error {
  constructor(id: number, actual: string, expected: string) {
    super(`Exception ${id} is ${actual}, not ${expected}`);
    this.name = 'WrongExceptionTypeError';
  }
}

export interface WorkspaceException {
  id: number;
  workspaceId: number | null;
  exceptionType: ExceptionType;
  summary: string;
  remediation: string | null;
  rawContent: string | null;
  rawContentType: string | null;
  senderAddress: string | null;
  messageControlId: string | null;
  relatedPatientName: string | null;
  metadata: Record<string, unknown> | null;
  priorWorkStatus: WorkStatus | null;
  resolvedAt: string | null;
  resolvedByActor: string | null;
  resolution: ExceptionResolution | null;
  resolutionNote: string | null;
  createdAt: string;
  /** Joined for the queue, so a coordinator sees who it is about. */
  patientName: string | null;
  referralId: number | null;
  /** Whole hours since it was raised — the "age" column of AC21. */
  ageHours: number;
}

type Row = typeof workspaceExceptions.$inferSelect;

/**
 * `decline_reasons` is a JSON ARRAY, not an object, so `parseJson()` above is
 * the wrong shape for it. The first version used `parseJson()` in a ternary that
 * discarded the value whenever it parsed successfully — backwards, and it would
 * have silently dropped the reasons from the conversion audit.
 */
function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A malformed metadata blob must not hide the whole exception — the
    // exception is the important part and the metadata is context.
    return null;
  }
}

function toException(
  row: Row,
  extra: { patientName?: string | null; referralId?: number | null } = {},
  now: Date = new Date(),
): WorkspaceException {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    exceptionType: row.exceptionType as ExceptionType,
    summary: row.summary,
    remediation: row.remediation,
    rawContent: row.rawContent,
    rawContentType: row.rawContentType,
    senderAddress: row.senderAddress,
    messageControlId: row.messageControlId,
    relatedPatientName: row.relatedPatientName,
    metadata: parseJson(row.metadata),
    priorWorkStatus: row.priorWorkStatus as WorkStatus | null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedByActor: row.resolvedByActor,
    resolution: row.resolution as ExceptionResolution | null,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt.toISOString(),
    patientName: extra.patientName ?? null,
    referralId: extra.referralId ?? null,
    ageHours: Math.floor((now.getTime() - row.createdAt.getTime()) / (60 * 60 * 1000)),
  };
}

export interface RaiseExceptionInput {
  workspaceId?: number | null;
  exceptionType: ExceptionType;
  summary: string;
  remediation?: string;
  rawContent?: string | null;
  rawContentType?: string;
  senderAddress?: string | null;
  messageControlId?: string | null;
  relatedPatientName?: string | null;
  metadata?: Record<string, unknown>;
}

function capRaw(content: string | null | undefined): {
  content: string | null;
  truncated: boolean;
} {
  if (content === null || content === undefined) return { content: null, truncated: false };
  if (content.length <= MAX_RAW_CONTENT) return { content, truncated: false };
  return { content: content.slice(0, MAX_RAW_CONTENT) + TRUNCATION_MARKER, truncated: true };
}

/**
 * Raises an exception and, when it names a workspace, moves that workspace to
 * `Exception` — capturing the status it came from so resolution can restore it.
 *
 * The work status write goes through `setWorkStatus()`, the single writer, so the
 * move is guarded and audited like any other. It is tolerated rather than
 * required: a workspace already in `Exception`, or one whose machine refuses the
 * transition, still gets its exception row. Losing the artifact to protect a
 * status field would be the wrong trade.
 */
export async function raiseException(input: RaiseExceptionInput): Promise<number> {
  const now = new Date();
  const { content, truncated } = capRaw(input.rawContent);

  let priorWorkStatus: WorkStatus | null = null;
  if (input.workspaceId) {
    const [ws] = await db
      .select({ workStatus: referralWorkspaces.workStatus })
      .from(referralWorkspaces)
      .where(eq(referralWorkspaces.id, input.workspaceId))
      .limit(1);
    // Only worth restoring if it was something else. Recording `Exception` as
    // the prior status would make resolution a no-op.
    if (ws && ws.workStatus !== WorkStatus.EXCEPTION) {
      priorWorkStatus = ws.workStatus as WorkStatus;
    }
  }

  const metadata = {
    ...(input.metadata ?? {}),
    ...(truncated ? { rawContentTruncated: true } : {}),
  };

  const [row] = await db
    .insert(workspaceExceptions)
    .values({
      workspaceId: input.workspaceId ?? null,
      exceptionType: input.exceptionType,
      summary: input.summary,
      remediation: input.remediation ?? null,
      rawContent: content,
      rawContentType: input.rawContentType ?? null,
      senderAddress: input.senderAddress ?? null,
      messageControlId: input.messageControlId ?? null,
      relatedPatientName: input.relatedPatientName ?? null,
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
      priorWorkStatus,
      createdAt: now,
    })
    .returning();

  // FIRE-AND-FORGET, deliberately, and this is the one place in this module
  // where that ordering is load-bearing.
  //
  // The exception ROW is the durable record — frequently the only copy of the
  // artifact. The audit event is a second, derived record. Awaiting the emit
  // (which the first version did) meant an audit failure THREW and lost the
  // exception, inverting the priority this module exists to defend. Caught and
  // logged so the failure is visible without being fatal.
  void emitEvent({
    eventType: WorkspaceEvents.EXCEPTION_RAISED,
    entityType: 'referral',
    // An orphan has no referral, so the exception id is the only identity it
    // has. Recorded in the metadata either way so the feed can always link.
    entityId: await referralIdFor(input.workspaceId ?? null).catch(() => 0),
    toState: WorkStatus.EXCEPTION,
    actor: 'system',
    metadata: {
      exceptionId: row.id,
      exceptionType: input.exceptionType,
      workspaceId: input.workspaceId ?? null,
      summary: input.summary,
      ...(input.messageControlId ? { messageControlId: input.messageControlId } : {}),
      ...(truncated ? { rawContentTruncated: true } : {}),
    },
  }).catch((err) => console.error('[ExceptionService] exception_raised audit failed', err));

  if (input.workspaceId && priorWorkStatus !== null) {
    try {
      const { setWorkStatus } = await import('./workspaceService');
      await setWorkStatus(
        input.workspaceId,
        WorkStatus.EXCEPTION,
        'system',
        `exception raised: ${input.exceptionType}`,
      );
    } catch (err) {
      // The exception row is what matters and it is already written. A machine
      // that refuses this transition is not a reason to lose the artifact.
      console.warn(
        `[ExceptionService] could not move workspace ${input.workspaceId} to Exception:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return row.id;
}

/**
 * Raise with one retry, for callers on a detecting code path.
 *
 * Returns null rather than throwing, so ingest and ACK handling cannot fail
 * because of the bookkeeping. But it retries once and logs loudly first,
 * because an exception that fails to persist is the artifact lost for good.
 */
export async function raiseExceptionSafely(input: RaiseExceptionInput): Promise<number | null> {
  try {
    return await raiseException(input);
  } catch (first) {
    console.error('[ExceptionService] raise failed, retrying once:', first);
    try {
      return await raiseException(input);
    } catch (second) {
      // Loudly, because this is data loss and nothing downstream will notice.
      console.error(
        '[ExceptionService] RAISE FAILED TWICE — the artifact is not retained:',
        JSON.stringify({
          exceptionType: input.exceptionType,
          summary: input.summary,
          messageControlId: input.messageControlId,
        }),
        second,
      );
      return null;
    }
  }
}

async function referralIdFor(workspaceId: number | null): Promise<number> {
  if (workspaceId === null) return 0;
  const [ws] = await db
    .select({ referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  return ws?.referralId ?? 0;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getException(id: number): Promise<WorkspaceException | null> {
  const [row] = await db
    .select()
    .from(workspaceExceptions)
    .where(eq(workspaceExceptions.id, id))
    .limit(1);
  if (!row) return null;
  return toException(row, await joinedFor(row.workspaceId));
}

async function joinedFor(
  workspaceId: number | null,
): Promise<{ patientName: string | null; referralId: number | null }> {
  if (workspaceId === null) return { patientName: null, referralId: null };
  const [row] = await db
    .select({
      referralId: referralWorkspaces.referralId,
      firstName: patients.firstName,
      lastName: patients.lastName,
    })
    .from(referralWorkspaces)
    .innerJoin(referrals, eq(referrals.id, referralWorkspaces.referralId))
    .innerJoin(patients, eq(patients.id, referrals.patientId))
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  if (!row) return { patientName: null, referralId: null };
  return { patientName: `${row.firstName} ${row.lastName}`.trim(), referralId: row.referralId };
}

export interface ExceptionFilters {
  exceptionType?: ExceptionType;
  workspaceId?: number;
  /** Default true. False lists resolved ones too, for the audit trail. */
  openOnly?: boolean;
  /** Restricts to these queue ids, or 'all'. Resolved by queueService. */
  queueIds?: number[] | 'all';
}

/**
 * The exception queue.
 *
 * ORPHANS ARE ALWAYS INCLUDED, whatever the queue scope. An exception with no
 * workspace is precisely the kind that used to vanish, and scoping it out of
 * every queue would recreate that: nobody would ever see it. So queue scope
 * narrows the workspace-attached ones and leaves orphans visible (AC24).
 */
export async function listExceptions(
  filters: ExceptionFilters = {},
  now: Date = new Date(),
): Promise<WorkspaceException[]> {
  const openOnly = filters.openOnly !== false;

  const clauses = [
    openOnly ? isNull(workspaceExceptions.resolvedAt) : undefined,
    filters.exceptionType ? eq(workspaceExceptions.exceptionType, filters.exceptionType) : undefined,
    filters.workspaceId ? eq(workspaceExceptions.workspaceId, filters.workspaceId) : undefined,
  ].filter((c): c is Exclude<typeof c, undefined> => c !== undefined);

  const rows = await db
    .select()
    .from(workspaceExceptions)
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(workspaceExceptions.createdAt));

  const scope = filters.queueIds;
  const out: WorkspaceException[] = [];
  for (const row of rows) {
    if (row.workspaceId !== null && scope !== undefined && scope !== 'all') {
      const [ws] = await db
        .select({ queueId: referralWorkspaces.queueId })
        .from(referralWorkspaces)
        .where(eq(referralWorkspaces.id, row.workspaceId))
        .limit(1);
      if (!ws || ws.queueId === null || !scope.includes(ws.queueId)) continue;
    }
    out.push(toException(row, await joinedFor(row.workspaceId), now));
  }
  return out;
}

/** Open exception count per workspace, for the workspace payload and PRD-18. */
export async function openExceptionCount(workspaceId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(workspaceExceptions)
    .where(
      and(eq(workspaceExceptions.workspaceId, workspaceId), isNull(workspaceExceptions.resolvedAt)),
    );
  return Number(row?.n ?? 0);
}

/**
 * Whether ANY workspace has an unresolved exception.
 *
 * This is the source PRD-18 reserved a slot for: `hasOpenInternalItems()` ORs
 * it in, so a protocol event that closes the loop while an exception is open
 * derives `Follow-up-Required` rather than `Resolved`.
 */
export async function hasOpenException(workspaceId: number): Promise<boolean> {
  return (await openExceptionCount(workspaceId)) > 0;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolves an exception and restores the workspace's work status.
 *
 * `prior_work_status` when it was captured, `Triage` when it was not — AC23's
 * "or to Triage when that is ambiguous". Triage is the right ambiguous default:
 * it means "somebody needs to look at this", which is exactly true of a
 * workspace whose pre-exception state is unknown.
 *
 * Only restores when the workspace is still IN `Exception`. If somebody moved it
 * on by hand in the meantime, that is a later decision than this one and
 * overwriting it would discard their judgement.
 */
export async function resolveException(
  exceptionId: number,
  resolution: ExceptionResolution,
  actor: ActingUser,
  note?: string,
): Promise<WorkspaceException> {
  const [row] = await db
    .select()
    .from(workspaceExceptions)
    .where(eq(workspaceExceptions.id, exceptionId))
    .limit(1);
  if (!row) throw new ExceptionNotFoundError(exceptionId);
  if (row.resolvedAt !== null) throw new ExceptionAlreadyResolvedError(exceptionId);

  const now = new Date();
  const [updated] = await db
    .update(workspaceExceptions)
    .set({
      resolvedAt: now,
      resolvedByActor: formatActor(actor),
      resolution,
      resolutionNote: note ?? null,
    })
    .where(eq(workspaceExceptions.id, exceptionId))
    .returning();

  await emitEvent({
    eventType: WorkspaceEvents.EXCEPTION_RESOLVED,
    entityType: 'referral',
    entityId: await referralIdFor(row.workspaceId),
    fromState: WorkStatus.EXCEPTION,
    actor: formatActor(actor),
    metadata: {
      exceptionId,
      exceptionType: row.exceptionType,
      workspaceId: row.workspaceId,
      resolution,
      ...(note ? { note } : {}),
      restoredTo: row.workspaceId
        ? ((await preEpisodeWorkStatus(row.workspaceId)) ?? WorkStatus.TRIAGE)
        : null,
    },
  });

  if (row.workspaceId !== null) await restoreWorkStatus(row.workspaceId);

  return toException(updated, await joinedFor(updated.workspaceId), now);
}

/**
 * The status the workspace held BEFORE it first entered Exception.
 *
 * NOT the prior status of the exception being resolved. With two exceptions open
 * at once, only the FIRST one captured a real prior status — the second was
 * raised against a workspace already in `Exception`, so its `prior_work_status`
 * is null by design. Resolving them in order and using the last one's value
 * therefore restored `Triage` and silently discarded the `In-Progress` the
 * workspace was actually in. A test caught exactly that.
 *
 * So: the EARLIEST recorded non-null prior status across this workspace's
 * exceptions, which is the status before the whole exception episode began.
 */
async function preEpisodeWorkStatus(workspaceId: number): Promise<WorkStatus | null> {
  const rows = await db
    .select({ prior: workspaceExceptions.priorWorkStatus })
    .from(workspaceExceptions)
    .where(
      and(
        eq(workspaceExceptions.workspaceId, workspaceId),
        isNotNull(workspaceExceptions.priorWorkStatus),
      ),
    )
    .orderBy(workspaceExceptions.createdAt, workspaceExceptions.id)
    .limit(1);
  return (rows[0]?.prior as WorkStatus | undefined) ?? null;
}

async function restoreWorkStatus(workspaceId: number): Promise<void> {
  const [ws] = await db
    .select({ workStatus: referralWorkspaces.workStatus })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  // Somebody moved it on themselves — that is a newer decision than this one.
  if (!ws || ws.workStatus !== WorkStatus.EXCEPTION) return;

  // Only when no OTHER exception is still open, or resolving one of several
  // would quietly clear the Exception status while work remains.
  if (await hasOpenException(workspaceId)) return;

  const target = (await preEpisodeWorkStatus(workspaceId)) ?? WorkStatus.TRIAGE;
  try {
    const { setWorkStatus } = await import('./workspaceService');
    await setWorkStatus(workspaceId, target, 'system', 'exception resolved');
  } catch (err) {
    console.warn(
      `[ExceptionService] could not restore workspace ${workspaceId} to ${target}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Reassociation ────────────────────────────────────────────────────────────

export class AlreadyAssociatedError extends Error {
  constructor(workspaceId: number, controlId: string) {
    super(`Workspace ${workspaceId} already carries message ${controlId}`);
    this.name = 'AlreadyAssociatedError';
  }
}

/**
 * Attaches an orphaned artifact to a workspace, then resolves the exception.
 *
 * DOES NOT TOUCH `referrals.state`. See the module header: this is a records
 * operation, and coupling it to a protocol transition would let a
 * mis-association corrupt the externally authoritative state. A test asserts
 * the state before and after are identical.
 */
export async function reassociate(
  exceptionId: number,
  workspaceId: number,
  actor: ActingUser,
  note: string,
): Promise<WorkspaceException> {
  const [row] = await db
    .select()
    .from(workspaceExceptions)
    .where(eq(workspaceExceptions.id, exceptionId))
    .limit(1);
  if (!row) throw new ExceptionNotFoundError(exceptionId);
  if (row.resolvedAt !== null) throw new ExceptionAlreadyResolvedError(exceptionId);

  const [ws] = await db
    .select({ id: referralWorkspaces.id, referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  if (!ws) throw new ExceptionWorkspaceNotFoundError(workspaceId);

  // Edge case from the test plan: reassociating a message the workspace already
  // has. Rejected rather than duplicating the thread row.
  if (row.messageControlId) {
    const { threadHasControlId } = await import('../messaging/threadService');
    if (await threadHasControlId(ws.referralId, row.messageControlId)) {
      throw new AlreadyAssociatedError(workspaceId, row.messageControlId);
    }
  }

  const { recordThreadMessage } = await import('../messaging/threadService');
  await recordThreadMessage({
    referralId: ws.referralId,
    direction: 'inbound',
    messageType: (row.metadata && (parseJson(row.metadata)?.messageType as string)) || 'InfoReply',
    subject: `Reassociated: ${row.summary.slice(0, 120)}`,
    summary: `Reassociated from exception #${exceptionId} by ${formatActor(actor)}`,
    senderAddress: row.senderAddress ?? undefined,
    contentBody: row.rawContent ?? undefined,
    messageControlId: row.messageControlId ?? undefined,
  });

  await emitEvent({
    eventType: WorkspaceEvents.REASSOCIATED,
    entityType: 'referral',
    entityId: ws.referralId,
    actor: formatActor(actor),
    metadata: {
      exceptionId,
      exceptionType: row.exceptionType,
      workspaceId,
      note,
      // The FULL audit AC13 asks for: what it was, where it went, who chose,
      // and why.
      originalSenderAddress: row.senderAddress,
      originalMessageControlId: row.messageControlId,
      originalSummary: row.summary,
      protocolStateReplayed: false,
    },
  });

  // Resolved with the association recorded, and the note carried through so the
  // reason is on both the reassociation event and the exception row.
  const resolved = await resolveException(exceptionId, 'reassociated', actor, note);

  // The exception was an orphan; now it belongs to a workspace. Recorded so the
  // audit trail points at the right place.
  await db
    .update(workspaceExceptions)
    .set({ workspaceId })
    .where(eq(workspaceExceptions.id, exceptionId));

  return { ...resolved, workspaceId };
}

/**
 * Ranked candidate workspaces for an orphaned artifact.
 *
 * DETERMINISTIC AND EXPLAINABLE. Every scoring contribution appends a reason, so
 * a coordinator can see WHY a workspace was suggested rather than trusting a
 * number. A candidate with a score and no reasons would be a bug, and a test
 * asserts every candidate carries at least one.
 */
export interface CorrelationCandidate {
  workspaceId: number;
  referralId: number;
  patientName: string;
  initiatingOrgName: string | null;
  score: number;
  reasons: string[];
}

export async function candidatesFor(
  exceptionId: number,
  now: Date = new Date(),
): Promise<CorrelationCandidate[]> {
  const [row] = await db
    .select()
    .from(workspaceExceptions)
    .where(eq(workspaceExceptions.id, exceptionId))
    .limit(1);
  if (!row) throw new ExceptionNotFoundError(exceptionId);

  const { rankCandidates } = await import('./correlationService');
  return rankCandidates(
    {
      senderAddress: row.senderAddress ?? undefined,
      patientLastName: lastNameOf(row.relatedPatientName),
      messageControlId: row.messageControlId ?? undefined,
    },
    now,
  );
}

/** The last word of a display name. Good enough, and honest about being so. */
export function lastNameOf(name: string | null): string | undefined {
  if (!name) return undefined;
  const parts = name.trim().replace(/,$/, '').split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  // "Alvarez, R." puts the surname first; "R. Alvarez" puts it last. Prefer the
  // longest token, which is right for both and wrong only for initials-only.
  return parts.reduce((a, b) => (b.length > a.length ? b : a));
}

// ── Auto-declined referrals ──────────────────────────────────────────────────

export interface RecordAutoDeclinedInput {
  sourceMessageId: string;
  referrerAddress: string;
  patientName?: string | null;
  patientDob?: string | null;
  declineReasons: string[];
  rawCcdaXml?: string | null;
}

/**
 * Persists an auto-declined referral and raises its exception.
 *
 * AC15–AC17. Today this content is sent back as an RRI and then DISCARDED, and
 * `referral.auto_declined` is emitted with `entityId: 0` — so the decision most
 * worth reviewing is the least visible. This is the durable record.
 *
 * Idempotent on `source_message_id`: a replayed inbound message must not create
 * a second record.
 */
export async function recordAutoDeclined(
  input: RecordAutoDeclinedInput,
): Promise<{ autoDeclinedId: number; exceptionId: number | null }> {
  const existing = await db
    .select({ id: autoDeclinedReferrals.id })
    .from(autoDeclinedReferrals)
    .where(eq(autoDeclinedReferrals.sourceMessageId, input.sourceMessageId))
    .limit(1);
  if (existing.length > 0) return { autoDeclinedId: existing[0].id, exceptionId: null };

  const now = new Date();
  const [row] = await db
    .insert(autoDeclinedReferrals)
    .values({
      sourceMessageId: input.sourceMessageId,
      referrerAddress: input.referrerAddress,
      patientName: input.patientName ?? null,
      patientDob: input.patientDob ?? null,
      declineReasons: JSON.stringify(input.declineReasons),
      rawCcdaXml: input.rawCcdaXml ?? null,
      createdAt: now,
    })
    .returning();

  await emitEvent({
    eventType: WorkspaceEvents.AUTO_DECLINED_RECORDED,
    entityType: 'referral',
    // AC16: associated with the durable record instead of entityId 0. Negative
    // so it cannot be mistaken for a referral id by a consumer that does not
    // read entityType — the auto-decline table is a different keyspace.
    entityId: -row.id,
    actor: 'system',
    metadata: {
      autoDeclinedId: row.id,
      sourceMessageId: input.sourceMessageId,
      referrerAddress: input.referrerAddress,
      reasons: input.declineReasons,
    },
  });

  const exceptionId = await raiseExceptionSafely({
    exceptionType: 'auto-declined',
    summary:
      `Referral from ${input.referrerAddress} was automatically declined at intake: ` +
      input.declineReasons.join('; '),
    remediation:
      'Review the inbound document. If the decline was wrong, convert this into a real referral ' +
      'and workspace; otherwise dismiss it.',
    rawContent: input.rawCcdaXml ?? null,
    rawContentType: 'application/xml',
    senderAddress: input.referrerAddress,
    relatedPatientName: input.patientName ?? null,
    metadata: {
      autoDeclinedId: row.id,
      sourceMessageId: input.sourceMessageId,
      declineReasons: input.declineReasons,
    },
  });

  return { autoDeclinedId: row.id, exceptionId };
}

/**
 * Turns an auto-declined record into a real referral and workspace (AC17).
 *
 * Creates the referral in `Received` — NOT in whatever state it might have
 * reached had it been accepted. The protocol has to run forward from intake,
 * because nothing was ever acknowledged to the counterparty.
 */
export async function convertAutoDeclined(
  exceptionId: number,
  actor: ActingUser,
  note: string,
): Promise<{ referralId: number; workspaceId: number }> {
  const exception = await getException(exceptionId);
  if (!exception) throw new ExceptionNotFoundError(exceptionId);
  if (exception.resolvedAt !== null) throw new ExceptionAlreadyResolvedError(exceptionId);
  if (exception.exceptionType !== 'auto-declined') {
    throw new WrongExceptionTypeError(exceptionId, exception.exceptionType, 'auto-declined');
  }

  const autoDeclinedId = Number(exception.metadata?.autoDeclinedId);
  const [record] = await db
    .select()
    .from(autoDeclinedReferrals)
    .where(eq(autoDeclinedReferrals.id, autoDeclinedId))
    .limit(1);
  if (!record) throw new ExceptionNotFoundError(exceptionId);

  const now = new Date();
  const name = (record.patientName ?? 'Unknown Unknown').trim().split(/\s+/);
  const firstName = name.length > 1 ? name.slice(0, -1).join(' ') : (name[0] ?? 'Unknown');
  const lastName = name.length > 1 ? name[name.length - 1] : 'Unknown';

  const [patient] = await db
    .insert(patients)
    .values({
      firstName,
      lastName,
      dateOfBirth: record.patientDob ?? '1900-01-01',
    })
    .returning();

  const [referral] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      // Suffixed so it cannot collide with the original inbound message id,
      // whose uniqueness still guards intake.
      sourceMessageId: `converted-${record.sourceMessageId}`,
      referrerAddress: record.referrerAddress,
      state: ReferralState.RECEIVED,
      routingDepartment: 'Unassigned',
      rawCcdaXml: record.rawCcdaXml,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const { createWorkspace } = await import('./workspaceService');
  const workspace = await createWorkspace(referral.id);

  await db
    .update(autoDeclinedReferrals)
    .set({ convertedReferralId: referral.id })
    .where(eq(autoDeclinedReferrals.id, autoDeclinedId));

  await emitEvent({
    eventType: WorkspaceEvents.AUTO_DECLINED_CONVERTED,
    entityType: 'referral',
    entityId: referral.id,
    actor: formatActor(actor),
    metadata: {
      autoDeclinedId,
      exceptionId,
      workspaceId: workspace.id,
      note,
      originalDeclineReasons: parseJsonArray(record.declineReasons),
      sourceMessageId: record.sourceMessageId,
    },
  });

  await resolveException(exceptionId, 'converted', actor, note);

  return { referralId: referral.id, workspaceId: workspace.id };
}

// ── Duplicate patients ──────────────────────────────────────────────────────

/**
 * Flags a potential duplicate patient. NEVER MERGES.
 *
 * Automatic patient merging in a clinical system is a patient-safety risk:
 * merging two people's records wrongly is materially worse than carrying two
 * records for one person. So this is deterministic detection and a human
 * decision, and `confirmed-same` records the decision WITHOUT moving any
 * clinical data — a limitation the UI states plainly rather than implying a
 * merge happened.
 */
export async function flagDuplicatePatient(input: {
  newPatientId: number;
  existingPatientIds: number[];
  patientName: string;
  patientDob: string;
  workspaceId?: number | null;
}): Promise<number | null> {
  const exceptionId = await raiseExceptionSafely({
    workspaceId: input.workspaceId ?? null,
    exceptionType: 'duplicate-patient',
    summary:
      `${input.patientName} (born ${input.patientDob}) matches ` +
      `${input.existingPatientIds.length} existing patient record(s) on surname and date of birth`,
    remediation:
      'Confirm whether these are the same person or different people. No records are merged ' +
      'either way — confirming "same person" records the decision only.',
    relatedPatientName: input.patientName,
    metadata: {
      newPatientId: input.newPatientId,
      existingPatientIds: input.existingPatientIds,
      patientDob: input.patientDob,
      mergePerformed: false,
    },
  });

  if (exceptionId !== null) {
    await emitEvent({
      eventType: WorkspaceEvents.DUPLICATE_PATIENT_FLAGGED,
      entityType: 'referral',
      entityId: await referralIdFor(input.workspaceId ?? null),
      actor: 'system',
      metadata: {
        exceptionId,
        newPatientId: input.newPatientId,
        existingPatientIds: input.existingPatientIds,
        patientName: input.patientName,
      },
    });
  }

  return exceptionId;
}

/** Party org names for the candidate list, one query rather than one per row. */
export async function orgNamesForWorkspaces(
  workspaceIds: number[],
): Promise<Map<number, string>> {
  const ids = [...new Set(workspaceIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ workspaceId: workspaceParties.workspaceId, orgName: workspaceParties.orgName })
    .from(workspaceParties)
    .where(eq(workspaceParties.partyRole, 'initiating'));
  const map = new Map<number, string>();
  for (const r of rows) {
    if (r.orgName && ids.includes(r.workspaceId)) map.set(r.workspaceId, r.orgName);
  }
  return map;
}
