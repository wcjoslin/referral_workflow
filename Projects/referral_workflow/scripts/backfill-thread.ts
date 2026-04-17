/**
 * Backfill script — populates referral_messages from existing referrals + outbound_messages.
 *
 * Usage:  npx ts-node scripts/backfill-thread.ts
 *
 * Safe to run multiple times — checks for existing thread entries before inserting.
 */

import { db } from '../src/db';
import { referrals, outboundMessages, referralMessages } from '../src/db/schema';
import { eq, count } from 'drizzle-orm';

async function main(): Promise<void> {
  // Check if thread table already has data
  const [existing] = await db.select({ total: count() }).from(referralMessages);
  if (existing.total > 0) {
    console.log(`referral_messages already has ${existing.total} entries — skipping backfill.`);
    return;
  }

  // 1. Backfill inbound ReferralCCDA from referrals table
  const allReferrals = await db.select().from(referrals);
  let inboundCount = 0;

  for (const ref of allReferrals) {
    await db.insert(referralMessages).values({
      referralId: ref.id,
      direction: 'inbound',
      messageType: 'ReferralCCDA',
      subject: `Inbound Referral`,
      summary: `Inbound referral received from ${ref.referrerAddress}`,
      senderAddress: ref.referrerAddress,
      contentXml: ref.rawCcdaXml,
      relatedStateTransition: 'Received->Acknowledged',
      createdAt: ref.createdAt,
    });
    inboundCount++;
  }

  console.log(`Backfilled ${inboundCount} inbound ReferralCCDA entries.`);

  // 2. Backfill outbound messages
  const allOutbound = await db.select().from(outboundMessages);
  let outboundCount = 0;

  const summaryTemplates: Record<string, string> = {
    RRI: 'Referral response sent',
    SIU: 'Appointment notification sent',
    InterimUpdate: 'Interim update sent',
    ConsultNote: 'Consult note sent',
    NoShowNotification: 'No-show notification sent',
    ConsultRequest: 'Consultation request sent',
    InfoRequest: 'Information request sent',
  };

  for (const msg of allOutbound) {
    // Look up referrer address from the referral
    const [ref] = await db.select().from(referrals).where(eq(referrals.id, msg.referralId));
    const recipientAddress = ref?.referrerAddress ?? undefined;

    await db.insert(referralMessages).values({
      referralId: msg.referralId,
      direction: 'outbound',
      messageType: msg.messageType,
      summary: summaryTemplates[msg.messageType] ?? `${msg.messageType} sent`,
      recipientAddress,
      messageControlId: msg.messageControlId,
      ackStatus: msg.status,
      ackAt: msg.acknowledgedAt,
      createdAt: msg.sentAt,
    });
    outboundCount++;
  }

  console.log(`Backfilled ${outboundCount} outbound message entries.`);
  console.log(`Done. Total thread entries: ${inboundCount + outboundCount}`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
