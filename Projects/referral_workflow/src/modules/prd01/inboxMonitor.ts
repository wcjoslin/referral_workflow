import { ImapFlow } from 'imapflow';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../config';
import { processInboundMessage } from './messageProcessor';
import { ingestReferral } from '../prd02/referralService';

const PROCESSED_IDS_FILE = path.resolve('.processed_messages.json');

/**
 * Loads the set of already-processed message IDs from disk.
 * Provides idempotency across service restarts.
 */
function loadProcessedIds(): Set<string> {
  try {
    if (fs.existsSync(PROCESSED_IDS_FILE)) {
      const raw = fs.readFileSync(PROCESSED_IDS_FILE, 'utf-8');
      const ids = JSON.parse(raw) as string[];
      return new Set(ids);
    }
  } catch {
    console.warn('[InboxMonitor] Could not load processed message IDs — starting fresh');
  }
  return new Set();
}

/**
 * Persists the current set of processed message IDs to disk.
 */
function saveProcessedIds(ids: Set<string>): void {
  try {
    fs.writeFileSync(PROCESSED_IDS_FILE, JSON.stringify([...ids]), 'utf-8');
  } catch (err) {
    console.error('[InboxMonitor] Failed to persist processed message IDs:', err);
  }
}

/**
 * Senders to ignore — system/bounce addresses and our own outbound address.
 * Prevents feedback loops when MDNs/RRIs land back in the same inbox.
 */
const IGNORED_SENDERS = [
  'mailer-daemon@',
  'no-reply@accounts.google.com',
  'noreply@',
];

function shouldIgnore(senderAddress: string): boolean {
  const lower = senderAddress.toLowerCase();
  // Ignore known system senders
  if (IGNORED_SENDERS.some((prefix) => lower.includes(prefix))) return true;
  // Ignore emails from our own address (outbound MDNs, RRIs, SIUs)
  if (lower === config.imap.user.toLowerCase()) return true;
  if (lower === config.receiving.directAddress.toLowerCase()) return true;
  return false;
}

/**
 * Polls the IMAP inbox once and processes any new, unprocessed messages.
 */
async function pollOnce(client: ImapFlow, processedIds: Set<string>): Promise<void> {
  await client.mailboxOpen(config.imap.mailbox);

  // Fetch all messages
  for await (const message of client.fetch('1:*', { envelope: true, source: true })) {
    const messageId = message.envelope?.messageId ?? `uid-${message.uid}`;

    if (processedIds.has(messageId)) {
      continue; // already processed
    }

    // Skip system/bounce/self emails to prevent feedback loops
    const senderAddress = message.envelope?.from?.[0]?.address ?? '';
    if (shouldIgnore(senderAddress)) {
      processedIds.add(messageId);
      continue;
    }

    if (!message.source) {
      console.warn(`[InboxMonitor] Message ${messageId} has no source — skipping`);
      continue;
    }

    console.log(`[InboxMonitor] Processing new message: ${messageId}`);

    try {
      const processed = await processInboundMessage(message.source);
      console.log('[InboxMonitor] ReferralData:', JSON.stringify(processed.referralData, null, 2));
      const referralId = await ingestReferral(processed);
      if (referralId !== null) {
        console.log(
          `[InboxMonitor] Referral #${referralId} ready for review at http://localhost:${config.server.port}/referrals/${referralId}/review`,
        );
      }
    } catch (err) {
      console.error(`[InboxMonitor] Error processing message ${messageId}:`, err);
    }

    processedIds.add(messageId);
    saveProcessedIds(processedIds);
  }
}

/**
 * Starts the inbox monitor. Polls the IMAP inbox on the configured interval.
 * Runs until the process is terminated (SIGINT/SIGTERM).
 */
export async function startInboxMonitor(): Promise<void> {
  console.log('[InboxMonitor] Starting...');
  const processedIds = loadProcessedIds();

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
    console.log('[InboxMonitor] Shutting down...');
    saveProcessedIds(processedIds);
    void client.logout();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.connect();
  console.log(`[InboxMonitor] Connected to ${config.imap.host}. Polling every ${config.imap.pollIntervalMs}ms`);

  await pollOnce(client, processedIds);

  setInterval(() => {
    pollOnce(client, processedIds).catch((err) => {
      console.error('[InboxMonitor] Poll error:', err);
    });
  }, config.imap.pollIntervalMs);
}
