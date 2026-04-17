/**
 * Info Request Service — PRD-09
 *
 * Generates and sends outbound info request messages to the referring provider
 * when a skill determines additional information is needed.
 * Transitions referral to Pending-Information state.
 */

import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import nodemailer from 'nodemailer';
import { db } from '../../db';
import { referrals, outboundMessages } from '../../db/schema';
import { config } from '../../config';
import { transition, ReferralState } from '../../state/referralStateMachine';
import { autoAck } from '../prd06/mockReferrer';
import { emitEvent } from '../analytics/eventService';
import { recordThreadMessage } from '../messaging/threadService';

/**
 * Send an info request to the referring provider and transition to Pending-Information.
 */
export async function sendInfoRequest(
  referralId: number,
  explanation: string,
  skillName: string,
): Promise<void> {
  // Load referral
  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!referral) {
    console.error(`[InfoRequestService] Referral #${referralId} not found`);
    return;
  }

  // Validate state transition
  const currentState = referral.state as ReferralState;
  transition(currentState, ReferralState.PENDING_INFORMATION);

  // Build email body
  const emailBody = buildInfoRequestEmail(referralId, explanation, skillName);

  // Send via SMTP
  const messageControlId = randomUUID();
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  });

  await transport.sendMail({
    from: config.receiving.directAddress,
    to: referral.referrerAddress,
    subject: `Information Request — Referral #${referralId}`,
    text: emailBody,
  });

  // Log outbound message
  await db.insert(outboundMessages).values({
    referralId,
    messageControlId,
    messageType: 'InfoRequest',
    status: 'Pending',
    sentAt: new Date(),
  });

  await recordThreadMessage({
    referralId,
    direction: 'outbound',
    messageType: 'InfoRequest',
    subject: `Information Request — Referral #${referralId}`,
    summary: `Information request: ${explanation.slice(0, 120)}${explanation.length > 120 ? '...' : ''}`,
    senderAddress: config.receiving.directAddress,
    recipientAddress: referral.referrerAddress,
    contentBody: emailBody,
    messageControlId,
    ackStatus: 'Pending',
    relatedStateTransition: `${currentState}->Pending-Information`,
  });

  // Update referral state
  await db
    .update(referrals)
    .set({
      state: ReferralState.PENDING_INFORMATION,
      updatedAt: new Date(),
    })
    .where(eq(referrals.id, referralId));

  // Analytics: pending info + message sent
  void emitEvent({
    eventType: 'referral.pending_info',
    entityType: 'referral',
    entityId: referralId,
    fromState: currentState,
    toState: ReferralState.PENDING_INFORMATION,
    actor: `skill:${skillName}`,
    metadata: { skillName, explanation },
  }).catch((err) => console.error('[EventService]', err));

  void emitEvent({
    eventType: 'message.sent',
    entityType: 'referral',
    entityId: referralId,
    actor: 'system',
    metadata: { messageControlId, messageType: 'InfoRequest', recipientAddress: referral.referrerAddress },
  }).catch((err) => console.error('[EventService]', err));

  console.log(
    `[InfoRequestService] Info request sent for referral #${referralId}. Skill: ${skillName}. State → Pending-Information`,
  );

  // PRD-06: auto-ACK from mock referrer (non-blocking)
  void autoAck(messageControlId).catch((err: Error) =>
    console.error(`[MockReferrer] ACK failed for ${messageControlId}:`, err.message),
  );
}

// ── Email Builder ────────────────────────────────────────────────────────────

function buildInfoRequestEmail(
  referralId: number,
  explanation: string,
  skillName: string,
): string {
  return `INFORMATION REQUEST — Referral #${referralId}

Our automated review has identified that additional information is needed before this referral can proceed.

Details:
${explanation}

Rule: ${skillName}

Please reply to this message with the requested information. If no response is received within the configured timeout period, the referral may be automatically declined or escalated.

This is an automated message from the 360X Referral Workflow System.`;
}
