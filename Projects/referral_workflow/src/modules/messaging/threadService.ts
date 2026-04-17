/**
 * Unified message thread service.
 *
 * Records every inbound/outbound exchange into the referral_messages table,
 * providing a chronological thread per referral.
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { referralMessages } from '../../db/schema';

export interface ThreadMessageInput {
  referralId: number;
  direction: 'inbound' | 'outbound';
  messageType: string;
  subject?: string;
  summary: string;
  senderAddress?: string;
  recipientAddress?: string;
  contentBody?: string;
  contentHl7?: string;
  contentXml?: string;
  messageControlId?: string;
  ackStatus?: string;
  relatedStateTransition?: string;
}

/**
 * Inserts a new entry into the referral message thread.
 */
export async function recordThreadMessage(input: ThreadMessageInput): Promise<void> {
  await db.insert(referralMessages).values({
    referralId: input.referralId,
    direction: input.direction,
    messageType: input.messageType,
    subject: input.subject ?? null,
    summary: input.summary,
    senderAddress: input.senderAddress ?? null,
    recipientAddress: input.recipientAddress ?? null,
    contentBody: input.contentBody ?? null,
    contentHl7: input.contentHl7 ?? null,
    contentXml: input.contentXml ?? null,
    messageControlId: input.messageControlId ?? null,
    ackStatus: input.ackStatus ?? null,
    ackAt: null,
    relatedStateTransition: input.relatedStateTransition ?? null,
    createdAt: new Date(),
  });
}

/**
 * Updates the ACK status on an outbound thread entry when an ACK is received.
 */
export async function updateThreadAckStatus(messageControlId: string): Promise<void> {
  await db
    .update(referralMessages)
    .set({ ackStatus: 'Acknowledged', ackAt: new Date() })
    .where(
      and(
        eq(referralMessages.messageControlId, messageControlId),
        eq(referralMessages.direction, 'outbound'),
      ),
    );
}
