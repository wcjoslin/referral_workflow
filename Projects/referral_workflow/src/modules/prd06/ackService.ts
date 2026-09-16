/**
 * PRD-06 acknowledgment service.
 *
 * Correlates inbound ACK messages to outbound_messages rows,
 * updates their status to Acknowledged, and transitions the referral
 * to Closed-Confirmed when the ConsultNote ACK is received.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { referrals, outboundMessages } from '../../db/schema';
import { transition, ReferralState } from '../../state/referralStateMachine';
import { AckData } from './ackParser';
import { emitEvent } from '../analytics/eventService';
import { proposeForReferral } from '../workspace/workspaceService';
import { recordThreadMessage, updateThreadAckStatus } from '../messaging/threadService';

export interface AckResult {
  matched: boolean;
  messageType?: string;
  referralId?: number;
  stateTransitioned?: boolean;
  /**
   * PRD-28: the exception raised when this ACK could not be applied.
   *
   * Added rather than changing `matched`, because `matched` is what existing
   * callers branch on and its meaning has not changed. An unmatched ACK is
   * still unmatched; it is now also RETAINED.
   */
  exceptionId?: number | null;
}

/**
 * PRD-28: what the parser cannot tell us.
 *
 * `AckData` is the parsed MSH/MSA and carries no raw text and no sender, but an
 * exception without the original message is not workable — and on this path the
 * exception row is the ONLY copy, because today the ACK is logged and dropped.
 * Optional, so every existing caller keeps working.
 */
export interface AckContext {
  raw?: string;
  senderAddress?: string;
}

/**
 * Processes an inbound ACK by correlating its MSA-2 to an outbound message.
 *
 * - Updates outbound_messages.status → 'Acknowledged' and sets acknowledgedAt
 * - If the acknowledged message is a ConsultNote and the referral is in Closed
 *   state, transitions to Closed-Confirmed
 */
export async function processAck(
  ackData: AckData,
  context: AckContext = {},
): Promise<AckResult> {
  const { acknowledgedControlId, ackCode } = ackData;

  // Find the outbound message matching this ACK
  const [message] = await db
    .select()
    .from(outboundMessages)
    .where(eq(outboundMessages.messageControlId, acknowledgedControlId));

  if (!message) {
    // PRD-28 AC6. Before this the ACK was logged and DROPPED: an
    // acknowledgement arriving with a mangled control id simply never happened,
    // and the counterparty had no way to know we had not seen it.
    //
    // The exception retains the raw message, because this row is now the only
    // copy. Reassociation can then attach it to the right referral.
    console.warn(
      `[AckService] No outbound message found for control ID ${acknowledgedControlId} — raising an exception`,
    );
    const exceptionId = await (async (): Promise<number | null> => {
      try {
        const { raiseExceptionSafely } = await import('../workspace/exceptionService');
        return await raiseExceptionSafely({
          exceptionType: 'unmatched-ack',
          summary: `ACK received for control id ${acknowledgedControlId}, which matches no outbound message`,
          remediation:
            'Attach this to the correct referral if the control id was mangled in transit, or ' +
            'dismiss it if the counterparty sent it in error.',
          rawContent: context.raw ?? null,
          rawContentType: 'application/hl7-v2',
          senderAddress: context.senderAddress ?? null,
          messageControlId: acknowledgedControlId,
          metadata: { ackCode, ackOwnControlId: ackData.messageControlId },
        });
      } catch (err) {
        console.error('[AckService] could not record the unmatched-ACK exception:', err);
        return null;
      }
    })();
    return { matched: false, exceptionId };
  }

  // Only process positive ACKs (AA)
  if (ackCode !== 'AA') {
    // PRD-28 AC7. Still not updating the status — an AE or AR genuinely is not
    // an acknowledgement — but no longer silently. A rejection from the
    // counterparty is one of the most important things that can happen to a
    // referral and it used to be a console.warn.
    console.warn(
      `[AckService] Non-positive ACK (${ackCode}) for control ID ${acknowledgedControlId} — raising an exception`,
    );
    // The WHOLE block is tolerant, not just the raise.
    //
    // The first version wrapped only raiseExceptionSafely(), leaving the
    // workspace lookup outside it — so a failure there threw straight out of
    // processAck() and broke ACK handling, which is exactly what "raising an
    // exception must never fail the operation that detected it" forbids. An ACK
    // is protocol traffic; bookkeeping around it must not be able to reject it.
    const exceptionId = await (async (): Promise<number | null> => {
      try {
        const { raiseExceptionSafely } = await import('../workspace/exceptionService');
        const { getWorkspaceByReferralId } = await import('../workspace/workspaceService');
        const workspace = await getWorkspaceByReferralId(message.referralId).catch(() => null);
        return await raiseExceptionSafely({
          workspaceId: workspace?.id ?? null,
          exceptionType: 'ack-error-code',
          summary:
            `The counterparty returned ${ackCode} for our ${message.messageType} ` +
            `(control id ${acknowledgedControlId}) instead of AA`,
          remediation:
            `${ackCode === 'AR' ? 'The counterparty REJECTED the message' : 'The counterparty reported an ERROR'}. ` +
            'Review the artifact, correct it and retransmit, or dismiss if the rejection was expected.',
          rawContent: context.raw ?? null,
          rawContentType: 'application/hl7-v2',
          senderAddress: context.senderAddress ?? null,
          messageControlId: acknowledgedControlId,
          metadata: {
            ackCode,
            messageType: message.messageType,
            referralId: message.referralId,
            outboundMessageId: message.id,
          },
        });
      } catch (err) {
        console.error('[AckService] could not record the non-AA ACK exception:', err);
        return null;
      }
    })();
    return {
      matched: true,
      messageType: message.messageType,
      referralId: message.referralId,
      exceptionId,
    };
  }

  // Update outbound message status
  await db
    .update(outboundMessages)
    .set({
      status: 'Acknowledged',
      acknowledgedAt: new Date(),
    })
    .where(eq(outboundMessages.id, message.id));

  // Update thread entry ACK status + record ACK as inbound thread message
  await updateThreadAckStatus(acknowledgedControlId);
  await recordThreadMessage({
    referralId: message.referralId,
    direction: 'inbound',
    messageType: 'ACK',
    summary: `ACK received for ${message.messageType} (control ID: ${acknowledgedControlId.slice(0, 8)}...)`,
    relatedStateTransition: message.messageType === 'ConsultNote' ? 'Closed->Closed-Confirmed' : undefined,
  });

  // Analytics: message acknowledged
  void emitEvent({
    eventType: 'message.acknowledged',
    entityType: 'referral',
    entityId: message.referralId,
    actor: 'system',
    metadata: { messageControlId: acknowledgedControlId, messageType: message.messageType, ackCode },
  }).catch((err) => console.error('[EventService]', err));

  console.log(
    `[AckService] Message ${acknowledgedControlId} (${message.messageType}) acknowledged for referral #${message.referralId}`,
  );

  // If this is a ConsultNote ACK, try to transition referral to Closed-Confirmed
  let stateTransitioned = false;
  if (message.messageType === 'ConsultNote') {
    const [referral] = await db
      .select()
      .from(referrals)
      .where(eq(referrals.id, message.referralId));

    if (referral && referral.state === ReferralState.CLOSED) {
      transition(referral.state as ReferralState, ReferralState.CLOSED_CONFIRMED);

      await db
        .update(referrals)
        .set({
          state: ReferralState.CLOSED_CONFIRMED,
          updatedAt: new Date(),
        })
        .where(eq(referrals.id, message.referralId));

      // PRD-18: advise the workspace immediately after the protocol state is
      // written and BEFORE any outbound send. The proposal follows from a transition
      // that is already guarded and committed, so it must not depend on mail
      // succeeding — after the send it would go stale whenever SMTP fails.
      await proposeForReferral(message.referralId, ReferralState.CLOSED_CONFIRMED);

      stateTransitioned = true;

      void emitEvent({
        eventType: 'referral.closed_confirmed',
        entityType: 'referral',
        entityId: message.referralId,
        fromState: ReferralState.CLOSED,
        toState: ReferralState.CLOSED_CONFIRMED,
        actor: 'system',
        metadata: { acknowledgedControlId },
      }).catch((err) => console.error('[EventService]', err));

      console.log(
        `[AckService] Referral #${message.referralId} transitioned to Closed-Confirmed`,
      );
    }
  }

  return {
    matched: true,
    messageType: message.messageType,
    referralId: message.referralId,
    stateTransitioned,
  };
}
