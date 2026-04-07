/**
 * PRD-11 consult service.
 *
 * Manages the Consult state: a post-encounter hold where the specialist
 * requests further consultation with the referring provider before the
 * referral loop can be closed.
 *
 * Flow: Encounter → Consult → Closed
 */

import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../../db';
import { referrals, patients, outboundMessages } from '../../db/schema';
import { config } from '../../config';
import { transition, ReferralState, InvalidStateTransitionError } from '../../state/referralStateMachine';

export class ReferralNotFoundError extends Error {
  constructor(referralId: number) {
    super(`Referral #${referralId} not found`);
    this.name = 'ReferralNotFoundError';
  }
}

/**
 * Transitions a referral from Encounter → Consult and notifies the
 * referring provider that the specialist has requested consultation.
 */
export async function markConsult(referralId: number): Promise<void> {
  // 1. Load referral + patient
  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!referral) throw new ReferralNotFoundError(referralId);

  const [patient] = await db.select().from(patients).where(eq(patients.id, referral.patientId));

  // 2. Validate and apply state transition
  const currentState = referral.state as ReferralState;
  transition(currentState, ReferralState.CONSULT);

  // 3. Update DB
  await db
    .update(referrals)
    .set({
      state: ReferralState.CONSULT,
      updatedAt: new Date(),
    })
    .where(eq(referrals.id, referralId));

  console.log(`[ConsultService] Referral #${referralId} entered Consult state`);

  // 4. Notify referring provider
  const patientName = patient ? `${patient.firstName} ${patient.lastName}` : 'the patient';

  const messageText = [
    `Consultation Request — Referral #${referralId}`,
    '',
    `The specialist has reviewed the case for patient ${patientName} and requires`,
    `further consultation before this referral can be closed.`,
    '',
    `Reason for original referral: ${referral.reasonForReferral ?? 'N/A'}`,
    `Specialist: ${referral.scheduledProvider ?? 'N/A'}`,
    '',
    'Please log in to review the referral and confirm the consultation to proceed.',
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
    subject: `Consultation Request — Referral #${referralId}`,
    text: messageText,
  });

  // 5. Log outbound message
  await db.insert(outboundMessages).values({
    referralId,
    messageControlId,
    messageType: 'ConsultRequest',
    status: 'Pending',
    sentAt: new Date(),
  });

  console.log(
    `[ConsultService] Consult request sent for referral #${referralId} (control ID: ${messageControlId})`,
  );
}

/**
 * Transitions a referral from Consult → Closed after the referring clinician
 * confirms the consultation.
 */
export async function resolveConsult(referralId: number, clinicianId: string): Promise<void> {
  // 1. Load referral
  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!referral) throw new ReferralNotFoundError(referralId);

  // 2. Validate that we are specifically in the Consult state before transitioning.
  // We can't rely solely on transition() here because Encounter → Closed is also
  // a valid path (used by the normal consult-note ACK flow), so we guard explicitly.
  const currentState = referral.state as ReferralState;
  if (currentState !== ReferralState.CONSULT) {
    throw new InvalidStateTransitionError(currentState, ReferralState.CLOSED);
  }
  transition(currentState, ReferralState.CLOSED);

  // 3. Update DB
  await db
    .update(referrals)
    .set({
      state: ReferralState.CLOSED,
      clinicianId,
      updatedAt: new Date(),
    })
    .where(eq(referrals.id, referralId));

  console.log(
    `[ConsultService] Referral #${referralId} consultation resolved by clinician ${clinicianId} — state → Closed`,
  );
}
