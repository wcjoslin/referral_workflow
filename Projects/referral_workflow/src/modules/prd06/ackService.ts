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

export interface AckResult {
  matched: boolean;
  messageType?: string;
  referralId?: number;
  stateTransitioned?: boolean;
}

/**
 * Processes an inbound ACK by correlating its MSA-2 to an outbound message.
 *
 * - Updates outbound_messages.status → 'Acknowledged' and sets acknowledgedAt
 * - If the acknowledged message is a ConsultNote and the referral is in Closed
 *   state, transitions to Closed-Confirmed
 */
export async function processAck(ackData: AckData): Promise<AckResult> {
  const { acknowledgedControlId, ackCode } = ackData;

  // Find the outbound message matching this ACK
  const [message] = await db
    .select()
    .from(outboundMessages)
    .where(eq(outboundMessages.messageControlId, acknowledgedControlId));

  if (!message) {
    console.warn(
      `[AckService] No outbound message found for control ID ${acknowledgedControlId} — ignoring`,
    );
    return { matched: false };
  }

  // Only process positive ACKs (AA)
  if (ackCode !== 'AA') {
    console.warn(
      `[AckService] Non-positive ACK (${ackCode}) for control ID ${acknowledgedControlId} — logged but not updating status`,
    );
    return { matched: true, messageType: message.messageType, referralId: message.referralId };
  }

  // Update outbound message status
  await db
    .update(outboundMessages)
    .set({
      status: 'Acknowledged',
      acknowledgedAt: new Date(),
    })
    .where(eq(outboundMessages.id, message.id));

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
