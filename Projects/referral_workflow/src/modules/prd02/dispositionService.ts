/**
 * PRD-02 disposition service.
 *
 * Handles Accept and Decline decisions from the clinician review UI.
 * Each action:
 *   1. Loads the referral from DB and validates it is in Acknowledged state
 *   2. Transitions state via referralStateMachine
 *   3. Updates referrals table
 *   4. Builds and sends RRI^I12 via the Direct SMTP gateway
 *   5. Logs the outbound message to outbound_messages table
 *
 * Also exports sendRriMessage — used internally and by referralService for auto-decline.
 */

import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { referrals, outboundMessages } from '../../db/schema';
import { config } from '../../config';
import { transition, ReferralState, InvalidStateTransitionError } from '../../state/referralStateMachine';
import { buildRri } from './rriBuilder';
import { onReferralAccepted } from '../prd03/mockScheduler';
import { randomUUID } from 'crypto';

export class ReferralNotFoundError extends Error {
  constructor(referralId: number) {
    super(`Referral #${referralId} not found`);
    this.name = 'ReferralNotFoundError';
  }
}

/**
 * Sends the Accept disposition for a referral.
 * Transitions state: Acknowledged → Accepted
 */
export async function accept(referralId: number, clinicianId: string): Promise<void> {
  await applyDisposition(referralId, clinicianId, ReferralState.ACCEPTED, undefined);
}

/**
 * Sends the Decline disposition for a referral.
 * Transitions state: Acknowledged → Declined
 */
export async function decline(referralId: number, clinicianId: string, reason: string): Promise<void> {
  await applyDisposition(referralId, clinicianId, ReferralState.DECLINED, reason);
}

async function applyDisposition(
  referralId: number,
  clinicianId: string,
  nextState: ReferralState,
  declineReason: string | undefined,
): Promise<void> {
  // Load referral
  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!referral) throw new ReferralNotFoundError(referralId);

  // Validate and apply state transition (throws InvalidStateTransitionError if invalid)
  const currentState = referral.state as ReferralState;
  transition(currentState, nextState);

  // Update referrals table
  await db
    .update(referrals)
    .set({
      state: nextState,
      clinicianId,
      declineReason: declineReason ?? null,
      updatedAt: new Date(),
    })
    .where(eq(referrals.id, referralId));

  // Build RRI
  const messageControlId = randomUUID();
  const rriMessage = buildRri({
    messageControlId,
    sourceMessageId: referral.sourceMessageId,
    referrerAddress: referral.referrerAddress,
    sendingFacility: config.receiving.directAddress,
    acceptCode: nextState === ReferralState.ACCEPTED ? 'AA' : 'AR',
    declineReason,
  });

  // Send and log
  await sendRriMessage(rriMessage, referral.referrerAddress, messageControlId, referralId);

  console.log(
    `[DispositionService] Referral #${referralId} ${nextState} by ${clinicianId}. RRI sent (control ID: ${messageControlId})`,
  );

  // PRD-03: auto-schedule accepted referrals (non-blocking)
  if (nextState === ReferralState.ACCEPTED) {
    void onReferralAccepted(referralId).catch((err: Error) =>
      console.error(`[MockScheduler] Failed for referral #${referralId}:`, err.message),
    );
  }
}

/**
 * Sends an RRI^I12 message via the Direct SMTP gateway and logs it to outbound_messages.
 *
 * @param rriMessage       - The full HL7 V2 pipe-delimited RRI string
 * @param toAddress        - Recipient Direct address
 * @param messageControlId - UUID used as HL7 MSH-10, logged for ACK correlation
 * @param referralId       - DB referral ID; null for auto-declined referrals
 */
export async function sendRriMessage(
  rriMessage: string,
  toAddress: string,
  messageControlId: string,
  referralId: number | null,
): Promise<void> {
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  });

  await transport.sendMail({
    from: config.receiving.directAddress,
    to: toAddress,
    subject: 'Referral Disposition',
    text: rriMessage,
  });

  // Log to outbound_messages if this referral is in the DB
  if (referralId !== null) {
    await db.insert(outboundMessages).values({
      referralId,
      messageControlId,
      messageType: 'RRI',
      status: 'Pending',
      sentAt: new Date(),
    });
  }
}
