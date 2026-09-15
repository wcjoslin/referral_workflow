/**
 * Unified message thread service.
 *
 * Records every inbound/outbound exchange into the referral_messages table,
 * providing a chronological thread per referral.
 */

import { eq, and } from 'drizzle-orm';
import { db } from '../../db';
import { referralMessages, referralWorkspaces } from '../../db/schema';
import { recordPartyAddress } from '../workspace/partyService';

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
 *
 * Also the single place where PRD-24 learns a party's Direct addresses. This
 * function is the funnel every one of the nine messaging services already calls,
 * so hooking the observation here means no individual service has to know that
 * parties exist — and a new service gets the behaviour for free.
 */
export async function recordThreadMessage(input: ThreadMessageInput): Promise<void> {
  const [row] = await db.insert(referralMessages).values({
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
  }).returning();

  // Only INBOUND senders teach us anything: an outbound sender address is our
  // own, which we already hold as the receiving party's intake address.
  //
  // Deliberately fire-and-forget. Party bookkeeping must never fail the thread
  // write that triggered it — losing the audit record of a message because we
  // could not file its sender address would be a strictly worse outcome.
  if (input.direction === 'inbound' && input.senderAddress) {
    void observeSenderAddress(input.referralId, input.senderAddress, row.id).catch((err) =>
      console.error('[ThreadService] party address observation failed', err),
    );
  }
}

/** Resolves the referral's workspace, then files the address against its party. */
async function observeSenderAddress(
  referralId: number,
  senderAddress: string,
  messageId: number,
): Promise<void> {
  const [workspace] = await db
    .select({ id: referralWorkspaces.id })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.referralId, referralId))
    .limit(1);
  if (!workspace) return; // no workspace yet, nothing to attach a party to
  await recordPartyAddress(workspace.id, senderAddress, messageId);
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
