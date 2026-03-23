import { startInboxMonitor } from './modules/prd01/inboxMonitor';
import { startServer } from './server';

// Start the clinician review UI (Express)
startServer();

// Start the IMAP inbox monitor (non-fatal — server stays up even if IMAP is unavailable)
startInboxMonitor().catch((err: Error) => {
  console.warn(`[InboxMonitor] Could not connect — ${err.message}`);
  console.warn('[InboxMonitor] Server is still running. Use scripts/seed-demo.ts to inject a referral manually.');
});
