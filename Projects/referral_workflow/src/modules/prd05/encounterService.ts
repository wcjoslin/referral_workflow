/**
 * PRD-05 encounter service.
 *
 * Marks a scheduled referral as encountered and optionally sends
 * a plain-text interim update to the referring provider via SMTP.
 */

import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../../db';
import { referrals, patients, outboundMessages } from '../../db/schema';
import { config } from '../../config';
import { transition, ReferralState } from '../../state/referralStateMachine';
import { onEncounterComplete } from '../prd04/mockEhr';

export class ReferralNotFoundError extends Error {
  constructor(referralId: number) {
    super(`Referral #${referralId} not found`);
    this.name = 'ReferralNotFoundError';
  }
}

export interface EncounterOptions {
  referralId: number;
  sendInterimUpdate?: boolean; // default true
}

/**
 * Marks a scheduled referral as encounter-complete.
 * Optionally sends an interim Direct Secure Message to the referring provider.
 */
export async function markEncounterComplete(opts: EncounterOptions): Promise<void> {
  const { referralId, sendInterimUpdate = true } = opts;

  // 1. Load referral + patient
  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!referral) throw new ReferralNotFoundError(referralId);

  const [patient] = await db.select().from(patients).where(eq(patients.id, referral.patientId));

  // 2. Validate and apply state transition
  const currentState = referral.state as ReferralState;
  transition(currentState, ReferralState.ENCOUNTER);

  // 3. Update DB
  await db
    .update(referrals)
    .set({
      state: ReferralState.ENCOUNTER,
      updatedAt: new Date(),
    })
    .where(eq(referrals.id, referralId));

  console.log(`[EncounterService] Referral #${referralId} marked as Encounter`);

  // 4. Send optional interim update
  if (sendInterimUpdate) {
    const patientName = patient
      ? `${patient.firstName} ${patient.lastName}`
      : 'the patient';
    const encounterDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const messageText = [
      `Interim Update — Referral #${referralId}`,
      '',
      `Patient ${patientName} was seen for their initial consultation on ${encounterDate}.`,
      `Reason for referral: ${referral.reasonForReferral ?? 'N/A'}`,
      '',
      'A final consult note will follow upon completion of all evaluations.',
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
      subject: `Interim Update — Referral #${referralId}`,
      text: messageText,
    });

    await db.insert(outboundMessages).values({
      referralId,
      messageControlId,
      messageType: 'InterimUpdate',
      status: 'Pending',
      sentAt: new Date(),
    });

    console.log(
      `[EncounterService] Interim update sent for referral #${referralId} (control ID: ${messageControlId})`,
    );
  }

  // PRD-04: auto-trigger consult note generation (non-blocking)
  void onEncounterComplete(referralId).catch((err: Error) =>
    console.error(`[MockEHR] Failed for referral #${referralId}:`, err.message),
  );
}
