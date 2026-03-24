/**
 * PRD-07 overdue message checker.
 *
 * Identifies outbound messages that have been in Pending status
 * beyond a configurable threshold (default: 48 hours).
 */

import { db } from '../../db';
import { outboundMessages } from '../../db/schema';
import { eq, and, lt, isNull } from 'drizzle-orm';

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
