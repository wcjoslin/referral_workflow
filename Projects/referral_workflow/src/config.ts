import * as dotenv from 'dotenv';
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
  },
  database: {
    url: optionalEnv('DATABASE_URL', './referral.db'),
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
