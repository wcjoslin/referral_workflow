import { startInboxMonitor } from './modules/prd01/inboxMonitor';
import { startServer } from './server';
import { getSkillCatalog, startSkillWatcher } from './modules/prd09/skillLoader';
import { checkPendingInfoTimeouts } from './modules/prd09/pendingInfoChecker';
import { expirePendedRequests } from './modules/prd12/priorAuthService';
import { runOverdueSweep } from './modules/prd07/overdueChecker';
import { startEdiWatcher } from './modules/claims/intake/ediWatcher';
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

// Start EDI file watcher for X12N 277 claims requests
startEdiWatcher().catch((err: Error) => {
  console.warn(`[EdiWatcher] Could not start — ${err.message}`);
});

// PRD-09: Start pending info timeout checker
setInterval(() => {
  checkPendingInfoTimeouts().catch((err) => {
    console.error('[PendingInfoChecker] Check failed:', err);
  });
}, config.skills.pendingInfoCheckIntervalMs);

// PRD-12: Expire PA requests that have been Pended beyond the configured timeout
setInterval(() => {
  expirePendedRequests().catch((err) => {
    console.error('[PriorAuth] Pend timeout check failed:', err);
  });
}, config.priorAuth.inquirePollIntervalMs);

// PRD-26: Sweep for overdue messages and workspaces.
//
// PRD-07 wrote an overdue message checker and nothing ever called it — no
// route, no interval, and when it did run it only wrote a console.warn. This
// registration is the fix for that as well as the new workspace sweep, which is
// why it calls runOverdueSweep() rather than either one directly.
//
// The sweep NOTICES time passing; it never computes a next action or a due date.
// Those are written synchronously by the transition that causes them, so this
// interval sets notification latency, not correctness.
setInterval(() => {
  runOverdueSweep().catch((err) => {
    console.error('[OverdueChecker] Sweep failed:', err);
  });
}, config.workspace.overdueSweepIntervalMs);
