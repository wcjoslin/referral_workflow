import { startInboxMonitor } from './modules/prd01/inboxMonitor';
import { startServer } from './server';
import { getSkillCatalog, startSkillWatcher } from './modules/prd09/skillLoader';
import { checkPendingInfoTimeouts } from './modules/prd09/pendingInfoChecker';
import { config } from './config';

// PRD-09: Initialize skill catalog and file watcher
try {
  const catalog = getSkillCatalog();
  console.log(`[Startup] Skill catalog loaded: ${catalog.skills.size} skill(s)`);
  startSkillWatcher();
} catch (err) {
  console.warn('[Startup] Skill loader init failed:', err);
}

// Start the clinician review UI (Express)
startServer();

// Start the IMAP inbox monitor (non-fatal — server stays up even if IMAP is unavailable)
startInboxMonitor().catch((err: Error) => {
  console.warn(`[InboxMonitor] Could not connect — ${err.message}`);
  console.warn('[InboxMonitor] Server is still running. Use scripts/seed-demo.ts to inject a referral manually.');
});

// PRD-09: Start pending info timeout checker
setInterval(() => {
  checkPendingInfoTimeouts().catch((err) => {
    console.error('[PendingInfoChecker] Check failed:', err);
  });
}, config.skills.pendingInfoCheckIntervalMs);
