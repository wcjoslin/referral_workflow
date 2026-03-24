/**
 * Mock scheduling service for the PRD-03 happy-path demo.
 *
 * Automatically assigns an appointment 7 days from now at 10:00 AM
 * when a referral is accepted. Fires non-blocking from dispositionService.accept().
 *
 * In production this would be replaced by an EHR scheduling webhook.
 */

import { scheduleReferral } from './schedulingService';

/**
 * Called (non-blocking) after a referral is accepted.
 * Assigns default appointment details and delegates to schedulingService.
 */
export async function onReferralAccepted(referralId: number): Promise<void> {
  const appointmentDate = new Date();
  appointmentDate.setDate(appointmentDate.getDate() + 7);
  appointmentDate.setHours(10, 0, 0, 0);

  const appointmentDatetime = appointmentDate.toISOString().slice(0, 19); // strip Z

  await scheduleReferral(referralId, {
    appointmentDatetime,
    durationMinutes: 60,
    locationName: 'Exam Room 2',
    scheduledProvider: 'Dr. Sarah Chen',
  });

  console.log(`[MockScheduler] Auto-scheduled referral #${referralId} for ${appointmentDatetime}`);
}
