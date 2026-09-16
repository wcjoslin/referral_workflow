import { ImapFlow } from 'imapflow';
import * as path from 'path';
import { config } from '../../config';
import { processInboundMessage } from './messageProcessor';
import { ingestReferral } from '../prd02/referralService';
import {
  importLegacyProcessedFile,
  isAlreadyProcessed,
  recordProcessed,
} from '../workspace/correlationService';

/**
 * The legacy idempotency file, imported ONCE and then ignored (PRD-28 AC3).
 *
 * WHY IT IS GONE. This file was the only thing preventing the whole mailbox
 * from being reprocessed, and it:
 *
 *   - did not survive a container rebuild, so a redeploy reprocessed everything
 *   - could not be shared across instances
 *   - was invisible to an operator, so nobody could see what had been seen
 *
 * `processed_messages` replaces it and records the OUTCOME of each message, not
 * merely that it was seen. Both are not maintained: the file is read once at
 * startup and never written again.
 *
 * What still actually prevents a duplicate referral is the unique constraint on
 * `referrals.source_message_id`. That has not changed, and this table does not
 * replace it.
 */
const LEGACY_PROCESSED_IDS_FILE = path.resolve('.processed_messages.json');

/**
 * Senders to ignore — system/bounce addresses and our own outbound address.
 * Prevents feedback loops when MDNs/RRIs land back in the same inbox.
 */
const IGNORED_SENDERS = [
  'mailer-daemon@',
  'no-reply@accounts.google.com',
  'noreply@',
];

/**
 * Subject prefixes used by our own outbound messages.
 * If a message from our own address has one of these subjects, it's system-generated.
 */
const OWN_OUTBOUND_SUBJECTS = [
  'rri^i12',         // disposition RRI
  'siu^s12',         // scheduling SIU
  'mdn',             // message disposition notification
  'interim update',  // encounter interim update
  'consultation note', // consult note C-CDA
];

function shouldIgnore(senderAddress: string, subject: string): boolean {
  const lower = senderAddress.toLowerCase();
  const subjectLower = subject.toLowerCase();
  // Ignore known system senders (bounce, Google alerts, etc.)
  if (IGNORED_SENDERS.some((prefix) => lower.includes(prefix))) return true;
  // Ignore our own outbound messages (matched by subject) to prevent feedback loops.
  // We only filter self-sent messages that look like system-generated ones — not all
  // mail from our address, since the PoC uses a single account for send+receive.
  const isOwnAddress =
    lower === config.imap.user.toLowerCase() ||
    lower === config.receiving.directAddress.toLowerCase();
  if (isOwnAddress && OWN_OUTBOUND_SUBJECTS.some((s) => subjectLower.includes(s))) return true;
  return false;
}

/**
 * Polls the IMAP inbox once and processes any new, unprocessed messages.
 */
async function pollOnce(client: ImapFlow): Promise<void> {
  await client.mailboxOpen(config.imap.mailbox);

  // Fetch all messages
  for await (const message of client.fetch('1:*', { envelope: true, source: true })) {
    const messageId = message.envelope?.messageId ?? `uid-${message.uid}`;

    // PRD-28 AC1/AC2: the durable check. A deliberate replay (AC4) rewrites the
    // row's outcome to 'replayed', which this does NOT skip — that is what makes
    // a replay take effect on the next sweep.
    if (await isAlreadyProcessed(messageId)) {
      continue;
    }

    // Skip system/bounce/self-generated emails to prevent feedback loops
    const senderAddress = message.envelope?.from?.[0]?.address ?? '';
    const subject = message.envelope?.subject ?? '';
    if (shouldIgnore(senderAddress, subject)) {
      // AC5: recorded as IGNORED rather than silently discarded. The ignore
      // rules are load-bearing — without them our own MDNs and RRIs land back
      // in the same inbox and loop — so an operator needs to see them firing.
      await recordProcessed({ messageId, senderAddress, subject, outcome: 'ignored' });
      continue;
    }

    if (!message.source) {
      // NOT recorded. A message with no source has not been processed, and
      // recording it would mean never retrying it after a transient fetch
      // failure.
      console.warn(`[InboxMonitor] Message ${messageId} has no source — skipping`);
      continue;
    }

    console.log(`[InboxMonitor] Processing new message: ${messageId}`);

    let outcome: 'referral-created' | 'duplicate' | 'exception' = 'exception';
    let referralId: number | null = null;
    try {
      const processed = await processInboundMessage(message.source);
      console.log('[InboxMonitor] ReferralData:', JSON.stringify(processed.referralData, null, 2));
      referralId = await ingestReferral(processed);
      if (referralId !== null) {
        outcome = 'referral-created';
        console.log(
          `[InboxMonitor] Referral #${referralId} ready for review at http://localhost:${config.server.port}/referrals/${referralId}/review`,
        );
      } else {
        // ingestReferral() returns null when it auto-declined. That is not an
        // error, and PRD-28 records it durably in auto_declined_referrals with
        // its own exception — so 'exception' is the honest outcome here.
        outcome = 'exception';
      }
    } catch (err) {
      console.error(`[InboxMonitor] Error processing message ${messageId}:`, err);
      // A UNIQUE violation on referrals.source_message_id means the referral
      // already exists — the constraint doing its job. Recorded as a duplicate
      // rather than an exception, because nothing is wrong.
      outcome =
        err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
          ? 'duplicate'
          : 'exception';
    }

    await recordProcessed({ messageId, senderAddress, subject, outcome, referralId });
  }
}

/**
 * Starts the inbox monitor. Polls the IMAP inbox on the configured interval.
 * Runs until the process is terminated (SIGINT/SIGTERM).
 */
export async function startInboxMonitor(): Promise<void> {
  console.log('[InboxMonitor] Starting...');

  // AC3: once, at startup, and then never read again.
  const imported = await importLegacyProcessedFile(LEGACY_PROCESSED_IDS_FILE);
  if (imported.fileFound) {
    console.log(
      `[InboxMonitor] Imported legacy .processed_messages.json: ${imported.imported} new, ` +
        `${imported.skipped} already known. The file is no longer read or written.`,
    );
  }

  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.port === 993,
    auth: {
      user: config.imap.user,
      pass: config.imap.password,
    },
    logger: false,
  });

  const shutdown = (): void => {
    // Nothing to flush any more: each message's outcome is written to
    // `processed_messages` as it is processed, so a hard kill loses at most the
    // message in flight rather than the whole session's progress.
    console.log('[InboxMonitor] Shutting down...');
    void client.logout();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.connect();
  console.log(`[InboxMonitor] Connected to ${config.imap.host}. Polling every ${config.imap.pollIntervalMs}ms`);

  await pollOnce(client);

  setInterval(() => {
    pollOnce(client).catch((err) => {
      console.error('[InboxMonitor] Poll error:', err);
    });
  }, config.imap.pollIntervalMs);
}
