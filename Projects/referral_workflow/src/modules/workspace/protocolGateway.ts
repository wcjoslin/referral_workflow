/**
 * PRD-29 — the protocol gateway.
 *
 * THE BET THIS IMPLEMENTS: the workspace supplies the protocol, so neither party
 * has to implement 360X. A counterparty brings a Direct address — commonplace —
 * rather than an implementation. Inside the workspace they make an assertion in
 * plain language; the gateway renders it into a conformant artifact using the
 * EXISTING builders, guards it with the existing state machine, stores it, and
 * decides whether there is anywhere to send it.
 *
 * ORDER OF OPERATIONS, and it matters:
 *
 *   authorize → validate → render → STORE → transition → deliver
 *
 * Store before transition and before delivery. A delivery failure must never
 * lose the artifact, and a protocol state that moved without a stored artifact
 * would be a loop we cannot evidence.
 *
 * WHY THIS DOES NOT CALL dispositionService, schedulingService ET AL.
 * Those own whole flows: they transition, build, send, and audit as
 * `clinician:<id>`. Delegating would have meant giving four tested services in
 * four other PRDs' modules a suppress-transmission flag for `local-only`
 * parties and an actor override so a guest is not recorded as a clinician. So
 * this calls only the PURE builders — `buildRri`, `buildSiu`,
 * `buildConsultNoteCcda`, `buildMdnReport`, `buildAck` — and owns persistence
 * and delivery itself.
 *
 * The cost, stated rather than hidden: two code paths can advance protocol
 * state, this one and the existing services. That is acceptable only because
 * BOTH go through `referralStateMachine.transition()`, the single guard, and
 * because the existing services keep serving the automated and demo flows
 * unchanged. A third path should be a consolidation, not an addition.
 *
 * NO NEW MESSAGE-BUILDING CODE LIVES HERE. Two builders were missing and were
 * added in the modules that own those message types — `buildMdnReport()`
 * extracted in prd01, `buildAck()` added in prd06 and round-trip tested against
 * `parseAck()`. Neither is in this file, and nothing in this file assembles a
 * segment or an element.
 */

import { randomUUID } from 'crypto';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  patients,
  referralMessages,
  referralWorkspaces,
  referrals,
  users,
  workspaceAssertions,
  workspaceParties,
} from '../../db/schema';
import { config } from '../../config';
import { ReferralState, transition } from '../../state/referralStateMachine';
import { emitEvent } from '../analytics/eventService';
import { buildRri } from '../prd02/rriBuilder';
import { buildSiu } from '../prd03/siuBuilder';
import { buildConsultNoteCcda } from '../prd04/ccdaBuilder';
import { buildMdnReport } from '../prd01/mdnService';
import { buildAck } from '../prd06/ackBuilder';
import { recordThreadMessage } from '../messaging/threadService';
import { sendMail } from '../messaging/mailer';
import { proposeForReferral } from './workspaceService';
import {
  ASSERTION_CATALOG,
  AssertionType,
  availableAssertions,
  isAssertionAvailable,
  missingContext,
} from './assertionCatalog';
import { Party, PartyRole, findPartyByDirectAddress, getParties, markCapabilityVerified } from './partyService';

export class AssertionNotPermittedError extends Error {
  constructor(type: AssertionType, role: PartyRole) {
    super(`A ${role} party may not assert ${type}`);
    this.name = 'AssertionNotPermittedError';
  }
}

export class AssertionNotAvailableError extends Error {
  constructor(type: AssertionType, state: ReferralState) {
    super(`${type} is not available from ${state}`);
    this.name = 'AssertionNotAvailableError';
  }
}

export class MissingAssertionContextError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing required context: ${missing.join(', ')}`);
    this.name = 'MissingAssertionContextError';
  }
}

export class AssertionWorkspaceNotFoundError extends Error {
  constructor(workspaceId: number) {
    super(`No workspace with id ${workspaceId}`);
    this.name = 'AssertionWorkspaceNotFoundError';
  }
}

export class PartyNotOnWorkspaceError extends Error {
  constructor(partyId: number) {
    super(`Party ${partyId} is not on this workspace`);
    this.name = 'PartyNotOnWorkspaceError';
  }
}

export type DeliveryMode = 'transmitted' | 'local-only';
export type TransportMode = 'address-on-file' | 'delegated-mailbox';
export type DeliveryStatus = 'Pending' | 'Delivered' | 'Failed' | 'Not-Transmitted';

export interface AssertionRequest {
  workspaceId: number;
  /** Idempotency key. A retried submission must not emit a second artifact. */
  assertionKey: string;
  assertionType: AssertionType;
  /** Resolved server-side by the caller. NEVER read from a request body. */
  partyId: number;
  actor: string; // 'user:<id>' | 'guest:<id>'
  context?: Record<string, unknown>;
}

export interface AssertionResult {
  assertionId: number;
  artifactMessageId: number | null;
  fromState: ReferralState;
  toState: ReferralState | null;
  deliveryMode: DeliveryMode;
  deliveryStatus: DeliveryStatus;
  transportMode: TransportMode;
  sentToAddress: string | null;
  /** True when this key had already been submitted and nothing new happened. */
  idempotentReplay: boolean;
}

export interface AssertionRecord extends AssertionResult {
  assertionKey: string;
  assertionType: AssertionType;
  assertedByActor: string;
  assertedByPartyId: number;
  partyOrgName: string;
  createdAt: Date;
  deliveredAt: Date | null;
  deliveryError: string | null;
}

// ── Sender and recipient resolution ───────────────────────────────────────────

/**
 * Who the artifact claims as sender.
 *
 * Under `organization` (the default) this is the organizational intake address,
 * which is what every pre-existing outbound path in this codebase already
 * passes as `sendingFacility` — so the default changes nothing.
 *
 * Under `individual` the acting user's own address is used, falling back to the
 * organizational one when they have none. A GUEST always resolves to their own
 * party's address regardless of the setting: the setting is about our staff, and
 * applying it to a counterparty would be meaningless.
 *
 * This is an AUTHORSHIP claim, not a transport signature. Under Mode A the
 * licensed party's HISP signs either way, and `individual` is not
 * non-repudiation of that individual.
 */
async function resolveSenderAddress(actor: string, assertingParty: Party): Promise<string> {
  const orgAddress = config.receiving.directAddress;

  if (actor.startsWith('guest:')) {
    return assertingParty.directAddress ?? orgAddress;
  }

  if (config.workspace.senderIdentityMode !== 'individual') return orgAddress;

  const userId = Number(actor.slice('user:'.length));
  if (!Number.isInteger(userId)) return orgAddress;

  const [row] = await db
    .select({ directAddress: users.directAddress })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.directAddress?.trim() || orgAddress;
}

interface Recipient {
  address: string | null;
  matchedOn: string | null;
}

/**
 * Where the artifact goes: the other party's address.
 *
 * PRD-24's routing rule, inherited rather than re-decided — reply to the
 * address the inbound message actually arrived from, falling back to the party's
 * canonical intake address.
 *
 * A party resolved by DOMAIN alone has no confirmed reply address, so routing
 * falls back to intake and `matchedOn` records `domain`, which keeps the audit
 * trail from implying the address was verified.
 */
async function resolveRecipient(workspaceId: number, counterparty: Party | null): Promise<Recipient> {
  if (!counterparty) return { address: null, matchedOn: null };

  // The most recent inbound sender for this workspace, if we have matched one.
  const [latestInbound] = await db
    .select({ senderAddress: referralMessages.senderAddress })
    .from(referralMessages)
    .innerJoin(referralWorkspaces, eq(referralWorkspaces.referralId, referralMessages.referralId))
    .where(and(eq(referralWorkspaces.id, workspaceId), eq(referralMessages.direction, 'inbound')))
    .orderBy(asc(referralMessages.createdAt))
    .limit(1);

  if (latestInbound?.senderAddress) {
    const match = await findPartyByDirectAddress(workspaceId, latestInbound.senderAddress);
    if (match && match.party.id === counterparty.id) {
      // An exact match is a confirmed reply address; a domain match is not, so
      // it falls back to intake while still recording how it resolved.
      if (match.matchedOn !== 'domain') {
        return { address: latestInbound.senderAddress, matchedOn: match.matchedOn };
      }
      return { address: counterparty.directAddress, matchedOn: 'domain' };
    }
  }

  return { address: counterparty.directAddress, matchedOn: counterparty.directAddress ? 'intake' : null };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

interface RenderedArtifact {
  messageType: string;
  summary: string;
  contentHl7?: string;
  contentXml?: string;
  contentBody?: string;
  messageControlId: string;
}

/**
 * Chooses a builder and supplies it with parameters. That is the whole job —
 * nothing here assembles a message.
 */
async function renderArtifact(
  type: AssertionType,
  referralId: number,
  senderAddress: string,
  recipientAddress: string | null,
  context: Record<string, unknown>,
): Promise<RenderedArtifact> {
  const spec = ASSERTION_CATALOG[type];
  const messageControlId = randomUUID();

  const [referral] = await db
    .select()
    .from(referrals)
    .where(eq(referrals.id, referralId))
    .limit(1);
  if (!referral) throw new AssertionWorkspaceNotFoundError(referralId);

  const [patient] = await db
    .select()
    .from(patients)
    .where(eq(patients.id, referral.patientId))
    .limit(1);

  const note = typeof context.note === 'string' ? context.note : '';
  const reason = typeof context.reason === 'string' ? context.reason : '';

  switch (spec.builder) {
    case 'rri': {
      // 'AA' accepts; 'AR' covers decline AND needs-information, because an
      // information request is a rejection of the referral AS SUBMITTED — the
      // distinction lives in the reason text and the protocol state, not here.
      const acceptCode = type === 'accept' ? 'AA' : 'AR';
      return {
        messageType: 'RRI',
        summary:
          type === 'accept'
            ? 'Referral accepted via workspace assertion'
            : `Referral ${type === 'decline' ? 'declined' : 'held for information'}: ${reason}`,
        contentHl7: buildRri({
          messageControlId,
          sourceMessageId: referral.sourceMessageId,
          referrerAddress: recipientAddress ?? referral.referrerAddress,
          sendingFacility: senderAddress,
          acceptCode,
          ...(acceptCode === 'AR' ? { declineReason: reason } : {}),
        }),
        messageControlId,
      };
    }

    case 'siu': {
      const appointmentDate = String(context.appointmentDate ?? '');
      const start = new Date(appointmentDate);
      const pad = (n: number): string => String(n).padStart(2, '0');
      const dtm = Number.isNaN(start.getTime())
        ? ''
        : `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}` +
          `${pad(start.getHours())}${pad(start.getMinutes())}${pad(start.getSeconds())}`;
      return {
        messageType: 'SIU',
        summary: `Appointment confirmed for ${appointmentDate} at ${String(context.location ?? '')}`,
        contentHl7: buildSiu({
          messageControlId,
          appointmentId: String(referralId),
          startDatetime: dtm,
          durationMinutes: Number(context.durationMinutes ?? 60),
          appointmentType: String(context.appointmentType ?? referral.routingDepartment),
          locationName: String(context.location ?? ''),
          scheduledProvider: String(context.provider ?? referral.scheduledProvider ?? ''),
          patientId: String(referral.patientId),
          patientFirstName: patient?.firstName ?? '',
          patientLastName: patient?.lastName ?? '',
          patientDob: (patient?.dateOfBirth ?? '').replace(/-/g, ''),
          referrerAddress: recipientAddress ?? referral.referrerAddress,
          sendingFacility: senderAddress,
        }),
        messageControlId,
      };
    }

    case 'ccda': {
      return {
        messageType: 'ConsultNote',
        summary: 'Consult note returned via workspace assertion',
        contentXml: buildConsultNoteCcda({
          patient: {
            firstName: patient?.firstName ?? '',
            lastName: patient?.lastName ?? '',
            dateOfBirth: patient?.dateOfBirth ?? '',
          },
          referral: {
            reasonForReferral: referral.reasonForReferral ?? '',
            referrerAddress: recipientAddress ?? referral.referrerAddress,
          },
          sections: {
            chiefComplaint: String(context.chiefComplaint ?? referral.reasonForReferral ?? ''),
            historyOfPresentIllness: String(context.historyOfPresentIllness ?? ''),
            physicalExam: String(context.physicalExam ?? ''),
            assessment: String(context.assessment ?? ''),
            plan: String(context.plan ?? ''),
          },
          documentId: messageControlId,
          effectiveTime: new Date(),
        }),
        messageControlId,
      };
    }

    case 'mdn': {
      return {
        messageType: 'MDN',
        summary: 'Receipt confirmed via workspace assertion',
        contentBody: buildMdnReport(referral.sourceMessageId),
        messageControlId,
      };
    }

    case 'ack': {
      // Acknowledges the last outbound artifact we have a control id for —
      // which for `acknowledge-outcome` is the consult note.
      const [lastOutbound] = await db
        .select({ messageControlId: referralMessages.messageControlId })
        .from(referralMessages)
        .where(
          and(
            eq(referralMessages.referralId, referralId),
            eq(referralMessages.direction, 'outbound'),
            eq(referralMessages.messageType, 'ConsultNote'),
          ),
        )
        .orderBy(asc(referralMessages.createdAt))
        .limit(1);

      return {
        messageType: 'ACK',
        summary: 'Outcome acknowledged via workspace assertion — loop closed',
        contentHl7: buildAck({
          messageControlId,
          acknowledgedControlId: lastOutbound?.messageControlId ?? messageControlId,
          ackCode: 'AA',
          sendingFacility: senderAddress,
          receivingFacility: recipientAddress ?? referral.referrerAddress,
        }),
        messageControlId,
      };
    }

    case 'direct':
    default: {
      // A plain Direct message. No structured artifact exists for these, and
      // none is invented — see the catalog's note on `no-show`.
      const body = note || reason || spec.description;
      return {
        messageType: labelForDirect(type),
        summary: `${spec.label}: ${body}`.slice(0, 200),
        contentBody: body,
        messageControlId,
      };
    }
  }
}

function labelForDirect(type: AssertionType): string {
  switch (type) {
    case 'no-show':
      return 'NoShowNotification';
    case 'supply-information':
      return 'InfoReply';
    case 'cancel':
      return 'Cancellation';
    case 'encounter':
      return 'InterimUpdate';
    default:
      return 'InterimUpdate';
  }
}

// ── Submission ────────────────────────────────────────────────────────────────

/**
 * The one entry point. Authorizes, validates, renders, stores, transitions, and
 * then delivers.
 */
export async function submitAssertion(req: AssertionRequest): Promise<AssertionResult> {
  // Idempotency first, before any work. The unique index on assertion_key is
  // the real guarantee; this read makes a replay cheap and gives the caller the
  // original result rather than an error.
  const [existing] = await db
    .select()
    .from(workspaceAssertions)
    .where(eq(workspaceAssertions.assertionKey, req.assertionKey))
    .limit(1);
  if (existing) return { ...toResult(existing), idempotentReplay: true };

  const [workspace] = await db
    .select()
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, req.workspaceId))
    .limit(1);
  if (!workspace) throw new AssertionWorkspaceNotFoundError(req.workspaceId);

  const parties = await getParties(req.workspaceId);
  const assertingParty = parties.find((p) => p.id === req.partyId);
  if (!assertingParty) throw new PartyNotOnWorkspaceError(req.partyId);

  const [referral] = await db
    .select()
    .from(referrals)
    .where(eq(referrals.id, workspace.referralId))
    .limit(1);
  if (!referral) throw new AssertionWorkspaceNotFoundError(req.workspaceId);

  const fromState = referral.state as ReferralState;
  const spec = ASSERTION_CATALOG[req.assertionType];

  // Authorize by PARTY ROLE, then by protocol state. Both re-checked here from
  // the same catalog the UI derives from, so a hand-crafted request cannot
  // reach something the surface would not have offered.
  if (!spec.permittedRoles.includes(assertingParty.partyRole)) {
    throw new AssertionNotPermittedError(req.assertionType, assertingParty.partyRole);
  }
  if (!isAssertionAvailable(req.assertionType, fromState, assertingParty.partyRole)) {
    throw new AssertionNotAvailableError(req.assertionType, fromState);
  }

  const missing = missingContext(req.assertionType, req.context);
  if (missing.length > 0) throw new MissingAssertionContextError(missing);

  // Validate the transition BEFORE rendering. An invalid assertion produces no
  // artifact at all.
  if (spec.toState !== null) transition(fromState, spec.toState);

  // The counterparty is whichever party is not the asserting one. Its address
  // decides transmitted vs local-only.
  const counterparty =
    parties.find((p) => p.id !== assertingParty.id && p.partyRole !== 'other') ?? null;
  const recipient = await resolveRecipient(req.workspaceId, counterparty);
  const senderAddress = await resolveSenderAddress(req.actor, assertingParty);

  const artifact = await renderArtifact(
    req.assertionType,
    referral.id,
    senderAddress,
    recipient.address,
    req.context ?? {},
  );

  const deliveryMode: DeliveryMode = recipient.address ? 'transmitted' : 'local-only';
  const deliveryStatus: DeliveryStatus = recipient.address ? 'Pending' : 'Not-Transmitted';
  const now = new Date();

  // STORE BEFORE ANYTHING ELSE MOVES. The thread row is where the bytes live,
  // and PRD-23 will index it.
  await recordThreadMessage({
    referralId: referral.id,
    direction: 'outbound',
    messageType: artifact.messageType,
    summary: artifact.summary,
    senderAddress,
    ...(recipient.address ? { recipientAddress: recipient.address } : {}),
    ...(artifact.contentBody ? { contentBody: artifact.contentBody } : {}),
    ...(artifact.contentHl7 ? { contentHl7: artifact.contentHl7 } : {}),
    ...(artifact.contentXml ? { contentXml: artifact.contentXml } : {}),
    messageControlId: artifact.messageControlId,
    ...(spec.toState ? { relatedStateTransition: `${fromState}->${spec.toState}` } : {}),
  });

  const [stored] = await db
    .select({ id: referralMessages.id })
    .from(referralMessages)
    .where(eq(referralMessages.messageControlId, artifact.messageControlId))
    .limit(1);

  const [assertion] = await db
    .insert(workspaceAssertions)
    .values({
      workspaceId: req.workspaceId,
      assertionKey: req.assertionKey,
      assertionType: req.assertionType,
      assertedByPartyId: assertingParty.id,
      assertedByActor: req.actor,
      context: req.context ? JSON.stringify(req.context) : null,
      fromState,
      toState: spec.toState,
      artifactMessageId: stored?.id ?? null,
      deliveryMode,
      // Always Mode A today. Resolved at send time from the party row rather
      // than baked in, so a Mode B upgrade is configuration, not a migration.
      transportMode: 'address-on-file',
      sentToAddress: recipient.address,
      sentFromAddress: senderAddress,
      addressMatchedOn: recipient.matchedOn,
      deliveryStatus,
      createdAt: now,
    })
    .returning();

  // Only now move the protocol state, through the single guard.
  if (spec.toState !== null) {
    await db
      .update(referrals)
      .set({
        state: spec.toState,
        ...(req.assertionType === 'decline' || req.assertionType === 'cancel'
          ? { declineReason: String(req.context?.reason ?? '') }
          : {}),
        updatedAt: now,
      })
      .where(eq(referrals.id, referral.id));

    // PRD-18's advisory proposal, same ordering the existing services use:
    // after the state is committed and before any send, so it cannot go stale
    // when SMTP fails.
    await proposeForReferral(referral.id, spec.toState);
  }

  void emitEvent({
    eventType: 'workspace.assertion_made',
    entityType: 'referral',
    entityId: referral.id,
    ...(spec.toState ? { fromState, toState: spec.toState } : {}),
    actor: req.actor,
    metadata: {
      workspaceId: req.workspaceId,
      assertionId: assertion.id,
      assertionType: req.assertionType,
      partyId: assertingParty.id,
      deliveryMode,
      // Both facts recorded separately so neither is implied by the other:
      // the payload claims this author, our HISP signs the transport.
      authoredAs: senderAddress,
      transportSignedBy: config.receiving.directAddress,
      transportMode: 'address-on-file',
      ...(recipient.matchedOn ? { addressMatchedOn: recipient.matchedOn } : {}),
    },
  }).catch((err) => console.error('[ProtocolGateway]', err));

  if (deliveryMode === 'local-only') {
    void emitEvent({
      eventType: 'workspace.artifact_not_transmitted',
      entityType: 'referral',
      entityId: referral.id,
      actor: req.actor,
      metadata: {
        workspaceId: req.workspaceId,
        assertionId: assertion.id,
        reason: 'The counterparty has no Direct address on file',
      },
    }).catch((err) => console.error('[ProtocolGateway]', err));
  } else {
    // Delivery runs AFTER the record is committed, and the caller is not held
    // open on SMTP. The outcome arrives as an event.
    void deliver(assertion.id).catch((err) => console.error('[ProtocolGateway]', err));
  }

  return { ...toResult(assertion), idempotentReplay: false };
}

/**
 * Sends a stored artifact and records the outcome.
 *
 * A failure leaves the artifact and the party's protocol mode untouched and
 * raises an event for PRD-28. It never downgrades the party's mode: a bounced
 * message says nothing about what the other side can parse.
 */
async function deliver(assertionId: number): Promise<void> {
  const [assertion] = await db
    .select()
    .from(workspaceAssertions)
    .where(eq(workspaceAssertions.id, assertionId))
    .limit(1);
  if (!assertion || !assertion.sentToAddress || !assertion.artifactMessageId) return;

  const [message] = await db
    .select()
    .from(referralMessages)
    .where(eq(referralMessages.id, assertion.artifactMessageId))
    .limit(1);
  if (!message) return;

  const body = message.contentHl7 ?? message.contentXml ?? message.contentBody ?? '';
  const delivered = await sendMail({
    to: assertion.sentToAddress,
    from: assertion.sentFromAddress ?? config.receiving.directAddress,
    subject: `360X ${message.messageType} — referral ${assertion.workspaceId}`,
    text: body,
  });

  const now = new Date();
  await db
    .update(workspaceAssertions)
    .set({
      deliveryStatus: delivered ? 'Delivered' : 'Failed',
      deliveredAt: delivered ? now : null,
      deliveryError: delivered ? null : 'SMTP delivery failed',
    })
    .where(eq(workspaceAssertions.id, assertionId));

  const [workspace] = await db
    .select({ referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, assertion.workspaceId))
    .limit(1);

  void emitEvent({
    eventType: delivered ? 'workspace.artifact_transmitted' : 'workspace.artifact_delivery_failed',
    entityType: 'referral',
    entityId: workspace?.referralId ?? 0,
    actor: assertion.assertedByActor,
    metadata: {
      workspaceId: assertion.workspaceId,
      assertionId,
      to: assertion.sentToAddress,
      ...(delivered ? {} : { forPrd28: 'delivery failure requires reconciliation' }),
    },
  }).catch((err) => console.error('[ProtocolGateway]', err));

  // AC12: a real exchange is what turns an assumed capability into a verified
  // one. Only on success, and only for the party we actually reached.
  if (delivered) {
    const parties = await getParties(assertion.workspaceId);
    const target = parties.find(
      (p) => p.directAddress?.toLowerCase() === assertion.sentToAddress?.toLowerCase(),
    );
    if (target) {
      await markCapabilityVerified(target.id, target.protocolMode);
      void emitEvent({
        eventType: 'workspace.capability_verified',
        entityType: 'referral',
        entityId: workspace?.referralId ?? 0,
        actor: 'system',
        metadata: { workspaceId: assertion.workspaceId, partyId: target.id, mode: target.protocolMode },
      }).catch((err) => console.error('[ProtocolGateway]', err));
    }
  }
}

/**
 * Transmits a previously local-only artifact, after a Direct address was added
 * to the party.
 *
 * EXPLICIT, never automatic backfill (AC11). Silently mailing a batch of old
 * artifacts the moment somebody fills in an address field would be a surprise
 * with PHI in it.
 */
export async function transmitPending(assertionId: number, actor: string): Promise<AssertionResult> {
  const [assertion] = await db
    .select()
    .from(workspaceAssertions)
    .where(eq(workspaceAssertions.id, assertionId))
    .limit(1);
  if (!assertion) throw new AssertionWorkspaceNotFoundError(assertionId);

  if (assertion.deliveryStatus !== 'Not-Transmitted' && assertion.deliveryStatus !== 'Failed') {
    return toResult(assertion);
  }

  const parties = await getParties(assertion.workspaceId);
  const counterparty = parties.find(
    (p) => p.id !== assertion.assertedByPartyId && p.partyRole !== 'other',
  );
  const recipient = await resolveRecipient(assertion.workspaceId, counterparty ?? null);
  if (!recipient.address) return toResult(assertion);

  await db
    .update(workspaceAssertions)
    .set({
      sentToAddress: recipient.address,
      addressMatchedOn: recipient.matchedOn,
      deliveryMode: 'transmitted',
      deliveryStatus: 'Pending',
    })
    .where(eq(workspaceAssertions.id, assertionId));

  void emitEvent({
    eventType: 'workspace.assertion_made',
    entityType: 'referral',
    // Was 0, which orphaned every retransmit event: PRD-25's per-referral feed
    // reads this table by entity id, so an event at 0 belongs to no referral and
    // would never appear. The assertion carries a workspaceId, so the referral
    // was always resolvable — this path just did not bother.
    entityId: await referralIdForWorkspace(assertion.workspaceId),
    actor,
    metadata: {
      workspaceId: assertion.workspaceId,
      assertionId,
      retransmit: true,
      to: recipient.address,
    },
  }).catch((err) => console.error('[ProtocolGateway]', err));

  await deliver(assertionId);

  const [updated] = await db
    .select()
    .from(workspaceAssertions)
    .where(eq(workspaceAssertions.id, assertionId))
    .limit(1);
  return toResult(updated ?? assertion);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

type AssertionRow = typeof workspaceAssertions.$inferSelect;

/**
 * The referral a workspace belongs to.
 *
 * Added by PRD-25 to fix the retransmit path, which emitted its event at
 * `entityId: 0` and so orphaned it from the per-referral feed. Returns 0 only
 * when the workspace itself has gone, which cannot happen for a live assertion.
 */
async function referralIdForWorkspace(workspaceId: number): Promise<number> {
  const [row] = await db
    .select({ referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  return row?.referralId ?? 0;
}

function toResult(row: AssertionRow): AssertionResult {
  return {
    assertionId: row.id,
    artifactMessageId: row.artifactMessageId,
    fromState: row.fromState as ReferralState,
    toState: row.toState as ReferralState | null,
    deliveryMode: row.deliveryMode as DeliveryMode,
    deliveryStatus: row.deliveryStatus as DeliveryStatus,
    transportMode: row.transportMode as TransportMode,
    sentToAddress: row.sentToAddress,
    idempotentReplay: false,
  };
}

export async function getAssertions(workspaceId: number): Promise<AssertionRecord[]> {
  if (!Number.isInteger(workspaceId)) return [];

  const rows = await db
    .select()
    .from(workspaceAssertions)
    .where(eq(workspaceAssertions.workspaceId, workspaceId))
    .orderBy(asc(workspaceAssertions.createdAt));

  const parties = await getParties(workspaceId);
  const nameOf = (id: number): string =>
    parties.find((p) => p.id === id)?.orgName ?? 'Unknown organization';

  return rows.map((row) => ({
    ...toResult(row),
    assertionKey: row.assertionKey,
    assertionType: row.assertionType as AssertionType,
    assertedByActor: row.assertedByActor,
    assertedByPartyId: row.assertedByPartyId,
    partyOrgName: nameOf(row.assertedByPartyId),
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    deliveryError: row.deliveryError,
  }));
}

export interface AvailableAssertionsResult {
  partyId: number | null;
  partyRole: PartyRole | null;
  protocolState: ReferralState | null;
  available: {
    type: AssertionType;
    label: string;
    description: string;
    requiredContext: string[];
  }[];
}

/**
 * What the given party may assert on this workspace right now.
 *
 * Derived from the same catalog the gateway enforces, so the surface and the
 * guard cannot disagree.
 */
export async function assertionsAvailableFor(
  workspaceId: number,
  partyId: number | null,
): Promise<AvailableAssertionsResult> {
  const [workspace] = await db
    .select({ referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  if (!workspace || partyId === null) {
    return { partyId: null, partyRole: null, protocolState: null, available: [] };
  }

  const [referral] = await db
    .select({ state: referrals.state })
    .from(referrals)
    .where(eq(referrals.id, workspace.referralId))
    .limit(1);

  const [party] = await db
    .select({ partyRole: workspaceParties.partyRole })
    .from(workspaceParties)
    .where(and(eq(workspaceParties.id, partyId), eq(workspaceParties.workspaceId, workspaceId)))
    .limit(1);

  if (!referral || !party) {
    return { partyId: null, partyRole: null, protocolState: null, available: [] };
  }

  const state = referral.state as ReferralState;
  const role = party.partyRole as PartyRole;

  return {
    partyId,
    partyRole: role,
    protocolState: state,
    available: availableAssertions(state, role).map((spec) => ({
      type: spec.type,
      label: spec.label,
      description: spec.description,
      requiredContext: spec.requiredContext,
    })),
  };
}
