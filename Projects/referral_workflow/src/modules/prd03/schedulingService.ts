/**
 * PRD-03 scheduling service.
 *
 * Core logic for scheduling an appointment on an accepted referral:
 *   1. Validates referral is in Accepted state
 *   2. Checks resource conflicts
 *   3. Updates DB with appointment details and transitions to Scheduled
 *   4. Builds and sends SIU^S12 via SMTP
 *   5. Logs outbound message
 */

import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../../db';
import { referrals, patients, outboundMessages } from '../../db/schema';
import { config } from '../../config';
import { transition, ReferralState } from '../../state/referralStateMachine';
import { checkConflicts, Resource } from './resourceCalendar';
import { buildSiu, isoToHl7 } from './siuBuilder';
import { onReferralScheduled } from '../prd05/mockEncounter';
import { autoAck } from '../prd06/mockReferrer';
import { emitEvent } from '../analytics/eventService';

export class ReferralNotFoundError extends Error {
  constructor(referralId: number) {
    super(`Referral #${referralId} not found`);
    this.name = 'ReferralNotFoundError';
  }
}

export class SchedulingConflictError extends Error {
  public conflicts: Resource[];
  constructor(conflicts: Resource[]) {
    const names = conflicts.map((c) => c.name).join(', ');
    super(`Scheduling conflict with: ${names}`);
    this.name = 'SchedulingConflictError';
    this.conflicts = conflicts;
  }
}

export interface AppointmentDetails {
  appointmentDatetime: string;  // ISO 8601 e.g. "2026-04-07T10:00:00"
  durationMinutes: number;
  locationName: string;
  scheduledProvider: string;
  resourceIds?: string[];       // optional resource IDs to check for conflicts
}

/**
 * Schedules an appointment for an accepted referral.
 * Called by both mockScheduler (auto) and the manual scheduling UI route.
 */
export async function scheduleReferral(
  referralId: number,
  details: AppointmentDetails,
): Promise<void> {
  // 1. Load referral + patient
  const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!referral) throw new ReferralNotFoundError(referralId);

  const [patient] = await db.select().from(patients).where(eq(patients.id, referral.patientId));

  // 2. Validate state
  const currentState = referral.state as ReferralState;
  transition(currentState, ReferralState.SCHEDULED);

  // 3. Check resource conflicts (if any resource IDs supplied)
  if (details.resourceIds && details.resourceIds.length > 0) {
    const conflicts = checkConflicts(
      details.resourceIds,
      new Date(details.appointmentDatetime),
      details.durationMinutes,
    );
    if (conflicts.length > 0) {
      throw new SchedulingConflictError(conflicts);
    }
  }

  // 4. Update referral record
  await db
    .update(referrals)
    .set({
      state: ReferralState.SCHEDULED,
      appointmentDate: details.appointmentDatetime,
      appointmentLocation: details.locationName,
      scheduledProvider: details.scheduledProvider,
      updatedAt: new Date(),
    })
    .where(eq(referrals.id, referralId));

  // 5. Build SIU^S12
  const messageControlId = randomUUID();
  const siuMessage = buildSiu({
    messageControlId,
    appointmentId: String(referralId),
    startDatetime: isoToHl7(details.appointmentDatetime),
    durationMinutes: details.durationMinutes,
    appointmentType: referral.reasonForReferral ?? 'Consultation',
    locationName: details.locationName,
    scheduledProvider: details.scheduledProvider,
    patientId: String(referral.patientId),
    patientFirstName: patient?.firstName ?? '',
    patientLastName: patient?.lastName ?? '',
    patientDob: patient?.dateOfBirth ? isoToHl7(patient.dateOfBirth) : '',
    referrerAddress: referral.referrerAddress,
    sendingFacility: config.receiving.directAddress,
  });

  // 6. Send via SMTP
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  });

  await transport.sendMail({
    from: config.receiving.directAddress,
    to: referral.referrerAddress,
    subject: `Appointment Scheduled — Referral #${referralId}`,
    text: [
      `APPOINTMENT SCHEDULED — Referral #${referralId}`,
      ``,
      `Patient: ${patient?.lastName ?? ''}, ${patient?.firstName ?? ''}`,
      `Date/Time: ${details.appointmentDatetime}`,
      `Location: ${details.locationName}`,
      `Provider: ${details.scheduledProvider}`,
      `Duration: ${details.durationMinutes} min`,
      ``,
      `--- HL7 SIU^S12 ---`,
      ``,
      siuMessage,
    ].join('\n'),
  });

  // 7. Log outbound message
  await db.insert(outboundMessages).values({
    referralId,
    messageControlId,
    messageType: 'SIU',
    status: 'Pending',
    sentAt: new Date(),
  });

  // Analytics: scheduled + message sent
  void emitEvent({
    eventType: 'referral.scheduled',
    entityType: 'referral',
    entityId: referralId,
    fromState: ReferralState.ACCEPTED,
    toState: ReferralState.SCHEDULED,
    actor: 'system',
    metadata: {
      appointmentDate: details.appointmentDatetime,
      locationName: details.locationName,
      scheduledProvider: details.scheduledProvider,
      durationMinutes: details.durationMinutes,
    },
  }).catch((err) => console.error('[EventService]', err));

  void emitEvent({
    eventType: 'message.sent',
    entityType: 'referral',
    entityId: referralId,
    actor: 'system',
    metadata: { messageControlId, messageType: 'SIU', recipientAddress: referral.referrerAddress },
  }).catch((err) => console.error('[EventService]', err));

  console.log(
    `[SchedulingService] Referral #${referralId} scheduled for ${details.appointmentDatetime} at ${details.locationName}. SIU sent (control ID: ${messageControlId})`,
  );

  // PRD-06: auto-ACK from mock referrer (non-blocking)
  void autoAck(messageControlId).catch((err: Error) =>
    console.error(`[MockReferrer] ACK failed for ${messageControlId}:`, err.message),
  );

  // PRD-05: auto-trigger encounter (non-blocking)
  void onReferralScheduled(referralId).catch((err: Error) =>
    console.error(`[MockEncounter] Failed for referral #${referralId}:`, err.message),
  );
}
