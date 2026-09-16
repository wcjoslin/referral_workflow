/**
 * PRD-07 overdue message checker, extended by PRD-26 to workspaces.
 *
 * Identifies outbound messages that have been in Pending status beyond a
 * configurable threshold (default: 48 hours), AND workspaces past their
 * `next_action_due_at`.
 *
 * ── WHY BOTH LIVE HERE ──────────────────────────────────────────────────────
 *
 * PRD-26 extends this module rather than adding a second checker, so there is
 * one place that knows what "overdue" means. The message-level behaviour is
 * unchanged and its exports keep their signatures: `getOverdueMessages()` and
 * `checkAndLogOverdue()` are untouched, because the message history view and
 * PRD-07's own semantics depend on them.
 *
 * THE TWO ARE NOT THE SAME THING. A message is overdue relative to when it was
 * SENT, against a fixed global threshold. A workspace is overdue relative to a
 * due date computed from its own state transition. Merging them into one
 * threshold would lose both meanings.
 *
 * Nothing here computes a next action or a due date. That happens synchronously
 * with each transition in nextActionService; this only notices that time has
 * passed.
 */

import { db } from '../../db';
import { outboundMessages, referralWorkspaces } from '../../db/schema';
import { eq, and, lt, isNull, isNotNull } from 'drizzle-orm';
import { emitEvent } from '../analytics/eventService';
import { WorkspaceEvents } from '../workspace/eventCatalog';
import { isOverdue } from '../workspace/nextActionService';

const DEFAULT_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

export interface OverdueMessage {
  id: number;
  referralId: number;
  messageControlId: string;
  messageType: string;
  sentAt: Date;
  hoursOverdue: number;
}

/**
 * Returns all outbound messages that are still Pending beyond the threshold.
 */
export async function getOverdueMessages(
  thresholdMs: number = DEFAULT_THRESHOLD_MS,
): Promise<OverdueMessage[]> {
  const cutoff = new Date(Date.now() - thresholdMs);

  const pending = await db
    .select()
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.status, 'Pending'),
        lt(outboundMessages.sentAt, cutoff),
        isNull(outboundMessages.acknowledgedAt),
      ),
    );

  return pending.map((m) => {
    const sentTime = m.sentAt instanceof Date ? m.sentAt.getTime() : Number(m.sentAt) * 1000;
    const hoursOverdue = Math.round((Date.now() - sentTime) / (60 * 60 * 1000));
    return {
      id: m.id,
      referralId: m.referralId,
      messageControlId: m.messageControlId,
      messageType: m.messageType,
      sentAt: m.sentAt instanceof Date ? m.sentAt : new Date(Number(m.sentAt) * 1000),
      hoursOverdue,
    };
  });
}

/**
 * Logs overdue messages to console. Intended to be called on a schedule.
 */
export async function checkAndLogOverdue(thresholdMs?: number): Promise<number> {
  const overdue = await getOverdueMessages(thresholdMs);
  if (overdue.length > 0) {
    console.warn(`[OverdueChecker] ${overdue.length} message(s) pending beyond threshold:`);
    for (const m of overdue) {
      console.warn(
        `  Referral #${m.referralId} | ${m.messageType} | ${m.hoursOverdue}h overdue | ${m.messageControlId.slice(0, 8)}...`,
      );
    }
  }
  return overdue.length;
}

// ── Workspace-level overdue (PRD-26) ────────────────────────────────────────

export interface OverdueWorkspace {
  workspaceId: number;
  referralId: number;
  nextAction: string;
  nextActionDueAt: Date;
  hoursOverdue: number;
  ownerUserId: number | null;
  queueId: number | null;
}

/**
 * Workspaces past their due date.
 *
 * Archived workspaces are excluded: an archived workspace is out of the working
 * set, and reporting it as overdue would put permanent noise in the sweep that
 * nobody can clear.
 */
export async function getOverdueWorkspaces(now: Date = new Date()): Promise<OverdueWorkspace[]> {
  const rows = await db
    .select({
      workspaceId: referralWorkspaces.id,
      referralId: referralWorkspaces.referralId,
      nextAction: referralWorkspaces.nextAction,
      nextActionDueAt: referralWorkspaces.nextActionDueAt,
      ownerUserId: referralWorkspaces.ownerUserId,
      queueId: referralWorkspaces.queueId,
    })
    .from(referralWorkspaces)
    .where(
      and(
        isNull(referralWorkspaces.archivedAt),
        isNotNull(referralWorkspaces.nextActionDueAt),
        lt(referralWorkspaces.nextActionDueAt, now),
      ),
    );

  return rows
    // Filtered through isOverdue() as well as the SQL, so the boundary
    // definition lives in exactly one function and the two cannot disagree by a
    // second at the due instant.
    .filter((r) => isOverdue({ nextActionDueAt: r.nextActionDueAt }, now))
    .map((r) => ({
      workspaceId: r.workspaceId,
      referralId: r.referralId,
      nextAction: r.nextAction ?? 'Review this referral and decide the next step',
      nextActionDueAt: r.nextActionDueAt as Date,
      hoursOverdue: Math.round(
        (now.getTime() - (r.nextActionDueAt as Date).getTime()) / (60 * 60 * 1000),
      ),
      ownerUserId: r.ownerUserId,
      queueId: r.queueId,
    }))
    .sort((a, b) => b.hoursOverdue - a.hoursOverdue);
}

/**
 * Emits `workspace.overdue` for each newly-overdue workspace. Returns the count
 * of events emitted, NOT the number of overdue workspaces.
 *
 * IDEMPOTENT ACROSS SWEEPS (AC14). `overdue_notified_at` records that the
 * current due date has been reported, so a workspace that has been overdue for
 * a week produces one event rather than one per sweep — the difference between
 * a useful signal and a notification channel nobody reads.
 *
 * The stamp is cleared whenever the due date MOVES (see nextActionService), so a
 * genuinely new breach notifies again.
 */
export async function checkAndFlagOverdueWorkspaces(now: Date = new Date()): Promise<number> {
  const rows = await db
    .select({
      workspaceId: referralWorkspaces.id,
      referralId: referralWorkspaces.referralId,
      nextAction: referralWorkspaces.nextAction,
      nextActionDueAt: referralWorkspaces.nextActionDueAt,
      overdueNotifiedAt: referralWorkspaces.overdueNotifiedAt,
      ownerUserId: referralWorkspaces.ownerUserId,
      queueId: referralWorkspaces.queueId,
      awaitedBy: referralWorkspaces.awaitedBy,
    })
    .from(referralWorkspaces)
    .where(
      and(
        isNull(referralWorkspaces.archivedAt),
        isNotNull(referralWorkspaces.nextActionDueAt),
        lt(referralWorkspaces.nextActionDueAt, now),
        // The idempotence gate, in SQL rather than in a loop.
        isNull(referralWorkspaces.overdueNotifiedAt),
      ),
    );

  let emitted = 0;
  for (const r of rows) {
    if (!isOverdue({ nextActionDueAt: r.nextActionDueAt }, now)) continue;

    const due = r.nextActionDueAt as Date;
    const hoursOverdue = Math.round((now.getTime() - due.getTime()) / (60 * 60 * 1000));

    // Stamped BEFORE the emit, so a failure to write the audit row cannot
    // produce an event every sweep forever. Under-notifying once is recoverable;
    // a permanent notification loop is not.
    await db
      .update(referralWorkspaces)
      .set({ overdueNotifiedAt: now })
      .where(eq(referralWorkspaces.id, r.workspaceId));

    await emitEvent({
      eventType: WorkspaceEvents.OVERDUE,
      entityType: 'referral',
      entityId: r.referralId,
      actor: 'system',
      metadata: {
        workspaceId: r.workspaceId,
        nextAction: r.nextAction,
        dueAt: due.toISOString(),
        hoursOverdue,
        ownerUserId: r.ownerUserId,
        queueId: r.queueId,
        awaitedBy: r.awaitedBy,
      },
    });
    emitted += 1;
  }

  return emitted;
}

/**
 * The scheduled entry point: sweeps messages and workspaces together.
 *
 * Registered on an interval from src/index.ts, following the same pattern as the
 * pending-info and prior-auth checkers (AC13). PRD-07's checker was written but
 * never connected — nothing called it — so this is also the fix for that.
 */
export async function runOverdueSweep(): Promise<{ messages: number; workspaces: number }> {
  const messages = await checkAndLogOverdue();
  const workspaces = await checkAndFlagOverdueWorkspaces();
  if (workspaces > 0) {
    console.warn(`[OverdueChecker] ${workspaces} workspace(s) newly overdue.`);
  }
  return { messages, workspaces };
}
