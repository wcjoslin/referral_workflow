/**
 * PRD-11 no-show service.
 *
 * Marks a scheduled referral as no-show and notifies the referring physician
 * via plain-text SMTP. The existing referral document remains the source of
 * truth for any subsequent rescheduling.
 */

import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../../db';
import { referrals, patients, outboundMessages } from '../../db/schema';
import { config } from '../../config';
import { transition, ReferralState } from '../../state/referralStateMachine';

export class ReferralNotFoundError extends Error {
  constructor(referralId: number) {
    super(`Referral #${referralId} not found`);
    this.name = 'ReferralNotFoundError';
  }
}

/**
 * Transitions a referral from Scheduled → No-Show and sends a notification
 * to the referring physician prompting them to follow up with the patient.
 */
export async function markNoShow(referralId: number): Promise<void> {
  // 1. Load referral + patient
  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!referral) throw new ReferralNotFoundError(referralId);

  const [patient] = await db.select().from(patients).where(eq(patients.id, referral.patientId));

  // 2. Validate and apply state transition
  const currentState = referral.state as ReferralState;
  transition(currentState, ReferralState.NO_SHOW);

  // 3. Update DB
  await db
    .update(referrals)
    .set({
      state: ReferralState.NO_SHOW,
      updatedAt: new Date(),
    })
    .where(eq(referrals.id, referralId));

  console.log(`[NoShowService] Referral #${referralId} marked as No-Show`);

  // 4. Send notification to referring physician
  const patientName = patient ? `${patient.firstName} ${patient.lastName}` : 'the patient';
  const originalDate = referral.appointmentDate
    ? new Date(referral.appointmentDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'the scheduled time';

  const messageText = [
    `No-Show Notification — Referral #${referralId}`,
    '',
    `Patient ${patientName} did not appear for their scheduled appointment on ${originalDate}.`,
    `Location: ${referral.appointmentLocation ?? 'N/A'}`,
    `Specialist: ${referral.scheduledProvider ?? 'N/A'}`,
    '',
    'Please follow up with the patient to arrange a new appointment.',
    'The original referral remains active and can be used to schedule a replacement visit.',
    '',
    `Reason for referral: ${referral.reasonForReferral ?? 'N/A'}`,
  ].join('\n');

  const messageControlId = randomUUID();

  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  });

  await transport.sendMail({
    from: config.receiving.directAddress,
    to: referral.referrerAddress,
    subject: `No-Show Notification — Referral #${referralId}`,
    text: messageText,
  });

  // 5. Log outbound message
  await db.insert(outboundMessages).values({
    referralId,
    messageControlId,
    messageType: 'NoShowNotification',
    status: 'Pending',
    sentAt: new Date(),
  });

  console.log(
    `[NoShowService] No-show notification sent for referral #${referralId} (control ID: ${messageControlId})`,
  );
}
