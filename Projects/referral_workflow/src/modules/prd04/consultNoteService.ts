/**
 * PRD-04 consult note service.
 *
 * Orchestrates the full pipeline: structure clinical text via Gemini,
 * build Consult Note C-CDA, send to referrer via SMTP, log to
 * outbound_messages, and transition state from Encounter → Closed.
 */

import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../../db';
import { referrals, patients, outboundMessages } from '../../db/schema';
import { config } from '../../config';
import { transition, ReferralState } from '../../state/referralStateMachine';
import { structureNote } from './geminiConsultNote';
import { buildConsultNoteCcda } from './ccdaBuilder';

export class ReferralNotFoundError extends Error {
  constructor(referralId: number) {
    super(`Referral #${referralId} not found`);
    this.name = 'ReferralNotFoundError';
  }
}

export interface ConsultNoteOptions {
  referralId: number;
  noteText: string;
}

/**
 * Generates a Consult Note C-CDA from clinical text and sends it to the referrer.
 *
 * Steps:
 * 1. Load referral + patient
 * 2. Validate state transition (Encounter → Closed)
 * 3. Structure clinical text via Gemini
 * 4. Build C-CDA XML
 * 5. Send via SMTP
 * 6. Log outbound message
 * 7. Update referral state to Closed
 */
export async function generateAndSend(opts: ConsultNoteOptions): Promise<void> {
  const { referralId, noteText } = opts;

  // 1. Load referral + patient
  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!referral) throw new ReferralNotFoundError(referralId);

  const [patient] = await db.select().from(patients).where(eq(patients.id, referral.patientId));

  // 2. Validate state transition
  const currentState = referral.state as ReferralState;
  transition(currentState, ReferralState.CLOSED);

  // 3. Structure clinical text via Gemini
  const patientName = patient
    ? { firstName: patient.firstName, lastName: patient.lastName }
    : { firstName: 'Unknown', lastName: 'Patient' };

  const sections = await structureNote(noteText, {
    ...patientName,
    reasonForReferral: referral.reasonForReferral ?? '',
  });

  // 4. Build C-CDA
  const documentId = randomUUID();
  const effectiveTime = new Date();

  const ccdaXml = buildConsultNoteCcda({
    patient: {
      ...patientName,
      dateOfBirth: patient?.dateOfBirth ?? '',
    },
    referral: {
      reasonForReferral: referral.reasonForReferral ?? '',
      referrerAddress: referral.referrerAddress,
    },
    sections,
    documentId,
    effectiveTime,
  });

  // 5. Send via SMTP
  const messageControlId = randomUUID();

  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  });

  await transport.sendMail({
    from: config.receiving.directAddress,
    to: referral.referrerAddress,
    subject: `Consultation Note — Referral #${referralId} — ${patientName.lastName}, ${patientName.firstName}`,
    text: `Consultation Note for ${patientName.firstName} ${patientName.lastName} (Referral #${referralId}). C-CDA document attached.`,
    attachments: [
      {
        filename: `consult-note-${referralId}.xml`,
        content: ccdaXml,
        contentType: 'application/xml',
      },
    ],
  });

  // 6. Log outbound message
  await db.insert(outboundMessages).values({
    referralId,
    messageControlId,
    messageType: 'ConsultNote',
    status: 'Pending',
    sentAt: new Date(),
  });

  // 7. Update state to Closed
  await db
    .update(referrals)
    .set({
      state: ReferralState.CLOSED,
      updatedAt: new Date(),
    })
    .where(eq(referrals.id, referralId));

  console.log(
    `[ConsultNoteService] Consult note sent for referral #${referralId} (control ID: ${messageControlId}). State → Closed`,
  );
}
