/**
 * PRD-28 — inbound correlation, idempotency and candidate ranking.
 *
 * Three mechanisms handled inbound correlation before this, each losing data
 * silently. This module replaces the weakest of them and gives the other two
 * somewhere to report.
 *
 * ── IDEMPOTENCY MOVES OFF DISK ──────────────────────────────────────────────
 *
 * `inboxMonitor.ts` kept processed `Message-ID`s in `.processed_messages.json`.
 * That file does not survive a container rebuild, cannot be shared across
 * instances, and is invisible to an operator — so after a redeploy the whole
 * mailbox is reprocessed, and nobody can see why.
 *
 * `processed_messages` replaces it. The legacy file is imported ONCE and then
 * ignored; maintaining both would guarantee they diverge.
 *
 * WHAT THIS TABLE DOES NOT DO: prevent duplicate referrals. That is
 * `referrals.source_message_id`'s unique constraint, which stays exactly as it
 * is. This table adds durability and observability on top of it — the constraint
 * is what actually stops a second row, and losing sight of that would be how a
 * "refactor" quietly removes the real protection.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { existsSync, readFileSync } from 'fs';
import { db } from '../../db';
import {
  outboundMessages,
  patients,
  processedMessages,
  referralWorkspaces,
  referrals,
  workspaceParties,
} from '../../db/schema';
import { emitEvent } from '../analytics/eventService';
import { WorkspaceEvents } from './eventCatalog';
import { ActingUser, formatActor } from './identityService';
import { CorrelationCandidate } from './exceptionService';

export type ProcessedOutcome =
  | 'referral-created'
  | 'ack-matched'
  | 'duplicate'
  | 'ignored'
  | 'exception'
  | 'replayed';

export const PROCESSED_OUTCOMES: readonly ProcessedOutcome[] = [
  'referral-created',
  'ack-matched',
  'duplicate',
  'ignored',
  'exception',
  'replayed',
];

export interface CorrelationKeys {
  externalReferralId?: string;
  senderAddress?: string;
  recipientAddress?: string;
  patientLastName?: string;
  patientDob?: string;
  messageControlId?: string;
}

// ── Idempotency ──────────────────────────────────────────────────────────────

export async function isAlreadyProcessed(messageId: string): Promise<boolean> {
  const rows = await db
    .select({ id: processedMessages.id })
    .from(processedMessages)
    .where(eq(processedMessages.messageId, messageId))
    .limit(1);
  return rows.length > 0;
}

export interface RecordProcessedInput {
  messageId: string;
  senderAddress?: string | null;
  subject?: string | null;
  outcome: ProcessedOutcome;
  referralId?: number | null;
  exceptionId?: number | null;
}

/**
 * Records the outcome of processing one inbound message.
 *
 * `onConflictDoUpdate` on `message_id`: re-processing the same id UPDATES the
 * outcome rather than throwing, which is what makes a deliberate replay
 * expressible (AC4) without a delete-then-insert that would lose the original
 * `processed_at` ordering if it failed halfway.
 */
export async function recordProcessed(input: RecordProcessedInput): Promise<void> {
  const now = new Date();
  await db
    .insert(processedMessages)
    .values({
      messageId: input.messageId,
      senderAddress: input.senderAddress ?? null,
      subject: input.subject ?? null,
      outcome: input.outcome,
      referralId: input.referralId ?? null,
      exceptionId: input.exceptionId ?? null,
      processedAt: now,
    })
    .onConflictDoUpdate({
      target: processedMessages.messageId,
      set: {
        outcome: input.outcome,
        referralId: input.referralId ?? null,
        exceptionId: input.exceptionId ?? null,
        processedAt: now,
      },
    });
}

/** What happened to a message id, for the operator view. */
export async function getProcessed(messageId: string): Promise<{
  messageId: string;
  outcome: ProcessedOutcome;
  referralId: number | null;
  exceptionId: number | null;
  processedAt: string;
} | null> {
  const [row] = await db
    .select()
    .from(processedMessages)
    .where(eq(processedMessages.messageId, messageId))
    .limit(1);
  if (!row) return null;
  return {
    messageId: row.messageId,
    outcome: row.outcome as ProcessedOutcome,
    referralId: row.referralId,
    exceptionId: row.exceptionId,
    processedAt: row.processedAt.toISOString(),
  };
}

export async function listProcessed(
  limit = 200,
  outcome?: ProcessedOutcome,
): Promise<
  Array<{
    messageId: string;
    senderAddress: string | null;
    subject: string | null;
    outcome: ProcessedOutcome;
    referralId: number | null;
    exceptionId: number | null;
    processedAt: string;
  }>
> {
  const rows = await db
    .select()
    .from(processedMessages)
    .where(outcome ? eq(processedMessages.outcome, outcome) : undefined)
    .orderBy(desc(processedMessages.processedAt))
    .limit(limit);
  return rows.map((r) => ({
    messageId: r.messageId,
    senderAddress: r.senderAddress,
    subject: r.subject,
    outcome: r.outcome as ProcessedOutcome,
    referralId: r.referralId,
    exceptionId: r.exceptionId,
    processedAt: r.processedAt.toISOString(),
  }));
}

/**
 * Imports `.processed_messages.json` once (AC3).
 *
 * Idempotent: ids already in the table are counted as skipped rather than
 * re-inserted, so running it twice is a no-op. Imported rows get outcome
 * `'ignored'` — deliberately, because the legacy file recorded only THAT a
 * message was seen, never what happened to it. Claiming `'referral-created'`
 * for them would be inventing history.
 *
 * Tolerates a missing or malformed file: a fresh deployment has no file, and
 * that is the normal case, not an error.
 */
export async function importLegacyProcessedFile(
  filePath: string,
): Promise<{ imported: number; skipped: number; fileFound: boolean }> {
  if (!existsSync(filePath)) return { imported: 0, skipped: 0, fileFound: false };

  let ids: string[];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    ids = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch (err) {
    console.warn(`[CorrelationService] could not parse ${filePath}:`, err);
    return { imported: 0, skipped: 0, fileFound: true };
  }

  const now = new Date();
  let imported = 0;
  let skipped = 0;
  for (const id of ids) {
    if (await isAlreadyProcessed(id)) {
      skipped += 1;
      continue;
    }
    await db.insert(processedMessages).values({
      messageId: id,
      outcome: 'ignored',
      subject: 'imported from .processed_messages.json',
      processedAt: now,
    });
    imported += 1;
  }
  return { imported, skipped, fileFound: true };
}

export class MessageNotProcessedError extends Error {
  constructor(messageId: string) {
    super(`Message ${messageId} has no processing record to replay`);
    this.name = 'MessageNotProcessedError';
  }
}

/**
 * Marks a message id for deliberate replay (AC4).
 *
 * Does NOT re-fetch or re-parse anything — it clears the idempotency record so
 * the next inbox sweep will process the message again, and audits that a human
 * asked for it. Re-driving the parse from here would need the raw MIME, which
 * this system does not retain for successfully-processed messages.
 *
 * REPLAY CANNOT CREATE A SECOND REFERRAL. `referrals.source_message_id` is still
 * unique, so a message that succeeded the first time is refused at insert. The
 * replay is therefore safe by construction rather than by care.
 */
export async function replayMessage(messageId: string, actor: ActingUser): Promise<void> {
  const existing = await getProcessed(messageId);
  if (!existing) throw new MessageNotProcessedError(messageId);

  await recordProcessed({
    messageId,
    outcome: 'replayed',
    referralId: existing.referralId,
    exceptionId: existing.exceptionId,
  });

  await emitEvent({
    eventType: WorkspaceEvents.MESSAGE_REPLAYED,
    entityType: 'referral',
    entityId: existing.referralId ?? 0,
    actor: formatActor(actor),
    metadata: {
      messageId,
      previousOutcome: existing.outcome,
      previouslyProcessedAt: existing.processedAt,
      note: 'Idempotency record cleared; the next inbox sweep will reprocess. The unique constraint on referrals.source_message_id still prevents a duplicate referral.',
    },
  });
}

// ── Correlation ──────────────────────────────────────────────────────────────

/**
 * Finds the workspace an inbound artifact belongs to.
 *
 * Tries exact identifiers first and only then falls back to ranking. The order
 * matters: a control id or an external referral id is an IDENTIFIER, while a
 * patient name is a hint, and treating a hint as a match is how a message ends
 * up on the wrong patient's record.
 */
export async function correlate(
  keys: CorrelationKeys,
  now: Date = new Date(),
): Promise<
  { matched: true; workspaceId: number; referralId: number; via: string } | { matched: false; candidates: CorrelationCandidate[] }
> {
  // 1. HL7 MSH-10 against an outbound message we sent.
  if (keys.messageControlId) {
    const [msg] = await db
      .select({ referralId: outboundMessages.referralId })
      .from(outboundMessages)
      .where(eq(outboundMessages.messageControlId, keys.messageControlId))
      .limit(1);
    if (msg) {
      const [ws] = await db
        .select({ id: referralWorkspaces.id })
        .from(referralWorkspaces)
        .where(eq(referralWorkspaces.referralId, msg.referralId))
        .limit(1);
      if (ws) {
        return { matched: true, workspaceId: ws.id, referralId: msg.referralId, via: 'messageControlId' };
      }
    }
  }

  // 2. The external 360X referral id, which PRD-29 records on the workspace.
  if (keys.externalReferralId) {
    const [ws] = await db
      .select({ id: referralWorkspaces.id, referralId: referralWorkspaces.referralId })
      .from(referralWorkspaces)
      .where(eq(referralWorkspaces.externalReferralId, keys.externalReferralId))
      .limit(1);
    if (ws) {
      return { matched: true, workspaceId: ws.id, referralId: ws.referralId, via: 'externalReferralId' };
    }
  }

  return { matched: false, candidates: await rankCandidates(keys, now) };
}

/** Days within which recency contributes to a candidate's score. */
const RECENCY_DAYS = 7;

/**
 * Ranks candidate workspaces, deterministically and explainably.
 *
 * EVERY SCORING CONTRIBUTION APPENDS A REASON. A coordinator about to attach a
 * clinical document to a patient's record needs to see WHY a workspace was
 * suggested, not a number they have to trust — and a candidate with a score and
 * no reasons is a bug, which a test asserts against.
 *
 * Weights are chosen so no single hint can carry a candidate alone: a sender
 * address match (0.5) plus a surname match (0.35) clears a bar that neither
 * reaches by itself. Recency (0.15) can only ever break a tie.
 */
export async function rankCandidates(
  keys: CorrelationKeys,
  now: Date = new Date(),
): Promise<CorrelationCandidate[]> {
  const recencyCutoff = new Date(now.getTime() - RECENCY_DAYS * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      workspaceId: referralWorkspaces.id,
      referralId: referralWorkspaces.referralId,
      createdAt: referralWorkspaces.createdAt,
      referrerAddress: referrals.referrerAddress,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dob: patients.dateOfBirth,
    })
    .from(referralWorkspaces)
    .innerJoin(referrals, eq(referrals.id, referralWorkspaces.referralId))
    .innerJoin(patients, eq(patients.id, referrals.patientId));

  const orgNames = await initiatingOrgNames();
  const partyAddresses = await initiatingAddresses();

  const sender = keys.senderAddress?.toLowerCase().trim();
  const surname = keys.patientLastName?.toLowerCase().trim();

  const candidates: CorrelationCandidate[] = [];
  for (const row of rows) {
    let score = 0;
    const reasons: string[] = [];

    if (sender) {
      if (row.referrerAddress.toLowerCase() === sender) {
        score += 0.5;
        reasons.push('sender address matches the referring address');
      } else if (partyAddresses.get(row.workspaceId)?.includes(sender)) {
        score += 0.5;
        reasons.push('sender address matches a recorded party address');
      } else if (domainOf(row.referrerAddress) && domainOf(row.referrerAddress) === domainOf(sender)) {
        score += 0.2;
        reasons.push('sender is at the same organization domain');
      }
    }

    if (surname && row.lastName.toLowerCase() === surname) {
      score += 0.35;
      reasons.push('patient surname matches');
    }

    if (keys.patientDob && row.dob === keys.patientDob) {
      score += 0.25;
      reasons.push('patient date of birth matches');
    }

    // A candidate with no substantive reason is not a candidate. Listing every
    // workspace with a score of zero would bury the real suggestions.
    if (reasons.length === 0) continue;

    // Recency is a TIE-BREAKER, applied only once something substantive already
    // matched — which is what the comment above always claimed and the first
    // version did not do. Adding it before this gate made every recently
    // created workspace a candidate on recency alone, so in a fresh database
    // the "candidates" list was just every workspace. A test caught it.
    if (row.createdAt >= recencyCutoff) {
      score += 0.15;
      reasons.push(`created within ${RECENCY_DAYS} days`);
    }

    candidates.push({
      workspaceId: row.workspaceId,
      referralId: row.referralId,
      patientName: `${row.firstName} ${row.lastName}`.trim(),
      initiatingOrgName: orgNames.get(row.workspaceId) ?? null,
      score: Math.round(Math.min(score, 1) * 100) / 100,
      reasons,
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.workspaceId - b.workspaceId)
    .slice(0, 10);
}

function domainOf(address: string | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  return at === -1 ? null : address.slice(at + 1).toLowerCase();
}

async function initiatingOrgNames(): Promise<Map<number, string>> {
  const rows = await db
    .select({ workspaceId: workspaceParties.workspaceId, orgName: workspaceParties.orgName })
    .from(workspaceParties)
    .where(eq(workspaceParties.partyRole, 'initiating'));
  const map = new Map<number, string>();
  for (const r of rows) if (r.orgName) map.set(r.workspaceId, r.orgName);
  return map;
}

async function initiatingAddresses(): Promise<Map<number, string[]>> {
  const rows = await db
    .select({ workspaceId: workspaceParties.workspaceId, address: workspaceParties.directAddress })
    .from(workspaceParties)
    .where(eq(workspaceParties.partyRole, 'initiating'));
  const map = new Map<number, string[]>();
  for (const r of rows) {
    if (!r.address) continue;
    const list = map.get(r.workspaceId) ?? [];
    list.push(r.address.toLowerCase());
    map.set(r.workspaceId, list);
  }
  return map;
}

// ── Duplicate patients ──────────────────────────────────────────────────────

/**
 * Existing patients matching on SURNAME and DATE OF BIRTH, case-insensitively.
 *
 * Deterministic on purpose. There is no master patient index, no MRN and no
 * probabilistic matching here, and pretending otherwise would be the start of a
 * patient-safety problem: this finds candidates for a human to judge, and the
 * PRD is explicit that no merge happens.
 *
 * Surname plus date of birth rather than full name: a first name arrives
 * inconsistently ("Robert", "Bob", "R."), while a surname and a date of birth
 * are the two fields a sending system is most likely to get right.
 */
export async function findPotentialDuplicatePatients(
  lastName: string,
  dob: string,
  excludePatientId?: number,
): Promise<number[]> {
  if (!lastName.trim() || !dob.trim()) return [];
  const rows = await db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        sql`LOWER(${patients.lastName}) = ${lastName.toLowerCase().trim()}`,
        eq(patients.dateOfBirth, dob.trim()),
      ),
    );
  return rows.map((r) => r.id).filter((id) => id !== excludePatientId);
}

/** Workspaces created since a cutoff, for the operator's reconciliation view. */
export async function recentWorkspaceCount(since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(referralWorkspaces)
    .where(gte(referralWorkspaces.createdAt, since));
  return Number(row?.n ?? 0);
}
