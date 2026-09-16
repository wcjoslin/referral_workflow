import * as dotenv from 'dotenv';
// PRD-26's next-action rule table is NOT here. It lives in
// `modules/workspace/nextActionRules.ts` and that module is its only authority.
//
// The draft PRD said to put it in this file, beside the other tunables. It was
// tried and reverted for two reasons: everything here calls requireEnv() at
// import time, so tests had to mock this module and restate the table — making
// every rule assertion run against a copy of itself — and routing a pure lookup
// through a second re-export created two places a rule could appear to live.
// The PRD's actual requirement ("changing a deadline must not require editing a
// service") is met: nextActionRules.ts is data, not logic.
export type { NextActionRule } from './modules/workspace/nextActionRules';
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}


export const config = {
  imap: {
    host: requireEnv('IMAP_HOST'),
    port: parseInt(optionalEnv('IMAP_PORT', '993'), 10),
    user: requireEnv('IMAP_USER'),
    password: requireEnv('IMAP_PASSWORD'),
    mailbox: optionalEnv('IMAP_MAILBOX', 'INBOX'),
    pollIntervalMs: parseInt(optionalEnv('IMAP_POLL_INTERVAL_MS', '10000'), 10),
  },
  smtp: {
    host: requireEnv('SMTP_HOST'),
    port: parseInt(optionalEnv('SMTP_PORT', '587'), 10),
    user: requireEnv('SMTP_USER'),
    password: requireEnv('SMTP_PASSWORD'),
  },
  receiving: {
    directAddress: requireEnv('RECEIVING_DIRECT_ADDRESS'),
    // PRD-24: the receiving party is OUR organization, so it has a real name.
    // Without this the only available name would be a guess at our own domain,
    // which would show our own organization as provisionally named and
    // unverified on every workspace. Optional so no existing .env breaks.
    orgName: optionalEnv('RECEIVING_ORG_NAME', 'Specialist Care Group'),
  },
  database: {
    url: optionalEnv('DATABASE_URL', './referral.db'),
  },
  // PRD-30. `publicBaseUrl` exists because an invitation link has to be
  // absolute and nothing else here knows the app's external address; the
  // localhost default is correct for the demo and wrong for a deployment,
  // which is the point of making it explicit.
  workspace: {
    publicBaseUrl: optionalEnv('PUBLIC_BASE_URL', `http://localhost:${optionalEnv('PORT', '3000')}`),
    guestInvitationExpiryHours: parseInt(optionalEnv('GUEST_INVITATION_EXPIRY_HOURS', '336'), 10),
    /**
     * Shows the raw guest invitation link in the inviter's own browser after
     * they create an invitation. OFF unless explicitly set to 'true'.
     *
     * WHY IT EXISTS. The link is delivered by email and nowhere else, so on a
     * demo box with no reachable SMTP the guest half of PRD-30 is unreachable:
     * you can create an invitation and then have no way to open it. This makes
     * the guest experience demonstrable.
     *
     * WHAT IT COSTS, stated plainly because the default is off for a reason.
     * The link contains a 256-bit bearer token. Displaying it puts that token
     * in the inviter's browser, its history, and any screenshot or screen share
     * of that page -- which is exactly what `createInvitation()`'s comment says
     * it is avoiding. Anyone holding the link has the invited party's access
     * until it is used or expires.
     *
     * So: a local demo affordance, never a deployment setting. It is separate
     * from PRD-31 rather than covered by it -- PRD-31 is about authenticating
     * internal callers, while this is about not printing a guest's credential.
     * Both must be settled before this application faces a network.
     */
    revealInviteLink: optionalEnv('WORKSPACE_REVEAL_INVITE_LINK', 'false') === 'true',
    guestSessionExpiryHours: parseInt(optionalEnv('GUEST_SESSION_EXPIRY_HOURS', '24'), 10),
    // PRD-29. 'organization' is the default because it is what every outbound
    // path in this codebase already does — each passes
    // config.receiving.directAddress as the HL7 sendingFacility — so the
    // default is a no-op and 'individual' is opt-in. Under 'individual' the
    // acting user's own users.direct_address becomes the sender, falling back
    // to the organizational address when they have none.
    //
    // This changes the AUTHORSHIP claim, not the transport signature: under
    // Mode A the licensed party's HISP signs either way. It is not
    // non-repudiation of the individual.
    senderIdentityMode:
      optionalEnv('SENDER_IDENTITY_MODE', 'organization') === 'individual'
        ? 'individual'
        : 'organization',

    // PRD-23. Uploaded documents are the only content this system stores itself
    // rather than indexing in place, so they need somewhere to live. Defaults
    // to a directory beside claims-inbox/ and claims-outbox/, matching what this
    // project already does — and GITIGNORED, because uploads are PHI and a
    // directory inside a checkout is one `git add -A` away from being
    // committed. A deployment should point this outside the checkout entirely.
    uploadDir: optionalEnv('WORKSPACE_UPLOAD_DIR', './workspace-uploads'),
    // 20 MB. Enforced by express.raw() as the body arrives, so an oversized
    // upload is refused before it is buffered rather than after.
    maxUploadBytes: parseInt(optionalEnv('WORKSPACE_MAX_UPLOAD_BYTES', String(20 * 1024 * 1024)), 10),

    // PRD-27. Retention is pruned in the same sweep as the overdue checker
    // rather than adding a second scheduled job.
    notificationRetentionDays: parseInt(
      optionalEnv('WORKSPACE_NOTIFICATION_RETENTION_DAYS', '90'),
      10,
    ),
    // AC13: a burst of activity on one workspace collapses into one row for the
    // same recipient and type within this window.
    notificationCollapseWindowMinutes: parseInt(
      optionalEnv('WORKSPACE_NOTIFICATION_COLLAPSE_WINDOW_MINUTES', '15'),
      10,
    ),

    // 15 minutes. The sweep only notices the passage of time — every next
    // action and due date is computed SYNCHRONOUSLY with its transition, so
    // this interval controls notification latency, not correctness.
    overdueSweepIntervalMs: parseInt(
      optionalEnv('WORKSPACE_OVERDUE_SWEEP_INTERVAL_MS', String(15 * 60 * 1000)),
      10,
    ),
  },
  gemini: {
    apiKey: optionalEnv('GEMINI_API_KEY', ''),
  },
  app: {
    env: optionalEnv('NODE_ENV', 'development'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  },
  fhir: {
    baseUrl: optionalEnv('FHIR_BASE_URL', 'https://hapi.fhir.org/baseR4'),
  },
  skills: {
    dir: optionalEnv('SKILLS_DIR', './skills'),
    overrideWindowHours: parseInt(optionalEnv('SKILL_OVERRIDE_WINDOW_HOURS', '24'), 10),
    pendingInfoTimeoutHours: parseInt(optionalEnv('PENDING_INFO_TIMEOUT_HOURS', '72'), 10),
    pendingInfoCheckIntervalMs: parseInt(optionalEnv('PENDING_INFO_CHECK_INTERVAL_MS', '3600000'), 10),
  },
  server: {
    port: parseInt(optionalEnv('PORT', '3000'), 10),
  },
  claims: {
    watchDir: optionalEnv('CLAIMS_WATCH_DIR', './claims-inbox'),
    outboundDir: optionalEnv('CLAIMS_OUTBOUND_DIR', './claims-outbox'),
  },
  priorAuth: {
    mockPayerBaseUrl: optionalEnv('PA_MOCK_PAYER_URL', 'http://localhost:3000/mock-payer'),
    pendTimeoutMs: parseInt(optionalEnv('PA_PEND_TIMEOUT_MS', '300000'), 10),
    inquirePollIntervalMs: parseInt(optionalEnv('PA_INQUIRE_POLL_MS', '30000'), 10),
    mockPayerDelayMs: parseInt(optionalEnv('PA_MOCK_DELAY_MS', '5000'), 10),
  },
} as const;
