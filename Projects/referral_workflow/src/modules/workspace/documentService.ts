/**
 * PRD-23 — the referral document collection.
 *
 * AN INDEX, NOT A STORE. One row per document, pointing at wherever the bytes
 * already live. A second copy of every C-CDA would be a synchronization problem
 * and would double the PHI footprint for no benefit, so the only content this
 * module stores itself is an upload — the one case with nowhere to point.
 *
 * RESOLUTION IS ONE FUNCTION. `resolveContent()` is the single place that knows
 * how to fetch bytes for each content source. Adding a seventh source is a case
 * there and nothing else, which is the property that keeps six storage shapes
 * from leaking into every caller.
 *
 * TWO INDEPENDENT GUEST GATES, both in `assertGuestMayRead()`: visibility AND
 * scope. Neither implies the other. A claims attachment is patient-level rather
 * than referral-level, and it must not reach a referring office because somebody
 * toggled one flag.
 */

import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import {
  attachmentRequests,
  attachmentResponses,
  documentAccessLog,
  outboundMessages,
  priorAuthRequests,
  priorAuthResponses,
  referralMessages,
  referralWorkspaces,
  referrals,
  users,
  workspaceAssertions,
  workspaceDocuments,
  workspaceGuests,
  workspaceParties,
} from '../../db/schema';
import { config } from '../../config';
import { emitEvent } from '../analytics/eventService';
import { ActingUser } from './identityService';
import { findPartyByDirectAddress } from './partyService';
import { CommentVisibility } from './commentService';
import { GuestContext } from './guestAccess';

export type ContentSource =
  | 'referral-message'
  | 'referral-ccda'
  | 'attachment-response'
  | 'prior-auth-request'
  | 'prior-auth-response'
  | 'upload';

export type DocumentSource =
  | 'inbound-dsm'
  | 'outbound-dsm'
  | 'generated'
  | 'uploaded'
  | 'payer-outbound'
  | 'payer-inbound';

export type DocumentScope = 'referral' | 'patient';

export type DeliveryStatus = 'Delivered' | 'Pending' | 'Failed' | 'Not-Transmitted';

export type RenderAs = 'ccda' | 'text' | 'download';

// ── Errors ───────────────────────────────────────────────────────────────────

export class DocumentNotFoundError extends Error {
  constructor(documentId: number) {
    super(`No document with id ${documentId}`);
    this.name = 'DocumentNotFoundError';
  }
}

export class DocumentAccessDeniedError extends Error {
  constructor(message = 'You do not have access to that document.') {
    super(message);
    this.name = 'DocumentAccessDeniedError';
  }
}

/**
 * The index entry survives but its content does not. A distinct error rather
 * than a not-found, because the two mean different things to a reader: the
 * document was really here and the row behind it has gone.
 */
export class DocumentContentUnavailableError extends Error {
  constructor(documentId: number) {
    super(`The content behind document ${documentId} is no longer available.`);
    this.name = 'DocumentContentUnavailableError';
  }
}

export class UploadTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `That file is ${Math.round(bytes / 1024 / 1024)} MB; the limit is ` +
        `${Math.round(config.workspace.maxUploadBytes / 1024 / 1024)} MB.`,
    );
    this.name = 'UploadTooLargeError';
  }
}

export class UploadEmptyError extends Error {
  constructor() {
    super('That file is empty.');
    this.name = 'UploadEmptyError';
  }
}

export class UploadTypeNotAllowedError extends Error {
  constructor() {
    super('Only PDF, JPEG, PNG and XML files can be uploaded.');
    this.name = 'UploadTypeNotAllowedError';
  }
}

export class GuestUploadVisibilityError extends Error {
  constructor() {
    super('A document uploaded from outside your organization is always shared.');
    this.name = 'GuestUploadVisibilityError';
  }
}

export class DocumentWorkspaceNotFoundError extends Error {
  constructor(workspaceId: number) {
    super(`No workspace with id ${workspaceId}`);
    this.name = 'DocumentWorkspaceNotFoundError';
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkspaceDocument {
  id: number;
  workspaceId: number;
  docType: string;
  loincCode: string | null;
  protocolRelationship: string | null;
  source: DocumentSource;
  scope: DocumentScope;
  senderOrgName: string | null;
  senderAddress: string | null;
  receivedAt: Date;
  visibility: CommentVisibility;
  contentType: string;
  claimedContentType: string | null;
  /** How the document opens: the viewer, escaped text, or a download. */
  renderAs: RenderAs;
  deliveryMode: 'transmitted' | 'local-only' | null;
  deliveryStatus: DeliveryStatus | null;
  deliveredAt: Date | null;
  accessCount: { internal: number; guest: number };
  lastAccessedAt: Date | null;
  originalFilename: string | null;
  uploadedByDisplayName: string | null;
  sha256: string | null;
}

/**
 * What a guest receives. Deliberately narrower than the internal shape — no
 * scope, no visibility, no delivery evidence, no access counts, no hash.
 * Asserted against GUEST_DOCUMENT_KEYS by a test, following PRD-22 and PRD-30.
 */
export interface GuestSharedDocument {
  id: number;
  docType: string;
  senderOrgName: string | null;
  receivedAt: string;
  contentType: string;
  renderAs: RenderAs;
  originalFilename: string | null;
  /** True when this guest uploaded it. */
  own: boolean;
}

export const GUEST_DOCUMENT_KEYS: readonly string[] = [
  'id',
  'docType',
  'senderOrgName',
  'receivedAt',
  'contentType',
  'renderAs',
  'originalFilename',
  'own',
];

export interface AccessRecord {
  action: 'view' | 'download' | 'denied';
  viewerKind: 'user' | 'guest' | 'unknown';
  viewerDisplayName: string | null;
  reason: string | null;
  viewedAt: Date;
}

// ── Labels and detection ─────────────────────────────────────────────────────

/**
 * `referral_messages.messageType` → something a coordinator would recognise.
 *
 * Local rather than borrowed from loincMapper: that module maps LOINC codes to
 * C-CDA document types for the claims flow, and a protocol message has no LOINC
 * code. Reusing it would mean inventing codes to look up.
 */
const MESSAGE_DOC_TYPE: Record<string, string> = {
  ReferralCCDA: 'Referral Note',
  MDN: 'Delivery Receipt',
  RRI: 'Referral Response',
  SIU: 'Appointment Notification',
  InterimUpdate: 'Interim Update',
  ConsultNote: 'Consult Note',
  ConsultRequest: 'Consultation Request',
  NoShowNotification: 'No-Show Notification',
  InfoRequest: 'Information Request',
  InfoReply: 'Information Reply',
  ACK: 'Acknowledgement',
};

/**
 * The upload allow-list, keyed on MAGIC BYTES rather than on the content type
 * the client declared. A declared type is attacker-controlled; the first few
 * bytes of a file are what it actually is.
 *
 * PNG sits alongside JPEG deliberately: a coordinator pasting a screenshot
 * produces one, and an unexplained rejection is a worse outcome than one more
 * entry here.
 */
const MAGIC: { type: string; ext: string; match: (b: Buffer) => boolean }[] = [
  {
    type: 'application/pdf',
    ext: '.pdf',
    match: (b) => b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-',
  },
  {
    type: 'image/jpeg',
    ext: '.jpg',
    match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: 'image/png',
    ext: '.png',
    match: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    type: 'application/xml',
    ext: '.xml',
    // A leading '<' once a UTF-8 BOM and any whitespace are past. Deliberately
    // loose: an XML declaration is optional, and a bare root element is valid.
    match: (b): boolean => {
      let i = 0;
      if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
      while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) {
        i += 1;
      }
      return i < b.length && b[i] === 0x3c;
    },
  },
];

/** The real type, or null when the bytes match nothing on the allow-list. */
export function detectContentType(body: Buffer): { type: string; ext: string } | null {
  for (const candidate of MAGIC) {
    if (candidate.match(body)) return { type: candidate.type, ext: candidate.ext };
  }
  return null;
}

/**
 * How this document opens.
 *
 * XML from a protocol message or a claims attachment goes to the C-CDA viewer,
 * because that is what it is. An UPLOADED xml does not: an arbitrary uploaded
 * XML is not a C-CDA, and feeding it to the viewer would render an empty frame
 * rather than say so. It shows as escaped source instead.
 */
function renderAsFor(contentSource: ContentSource, contentType: string): RenderAs {
  if (contentType === 'application/pdf' || contentType.startsWith('image/')) return 'download';
  if (contentType === 'application/xml') {
    return contentSource === 'upload' ? 'text' : 'ccda';
  }
  return 'text';
}

function asVisibility(value: string): CommentVisibility {
  return value === 'Shared' ? 'Shared' : 'Internal';
}

function sha256Of(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function referralIdFor(workspaceId: number): Promise<number> {
  const [row] = await db
    .select({ referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  return row?.referralId ?? 0;
}

// ── Registration ─────────────────────────────────────────────────────────────

export interface RegisterDocumentInput {
  workspaceId: number;
  contentSource: ContentSource;
  contentRef?: number | null;
  uploadPath?: string;
  contentType: string;
  claimedContentType?: string | null;
  docType: string;
  loincCode?: string | null;
  protocolRelationship?: string | null;
  source: DocumentSource;
  scope?: DocumentScope;
  senderPartyId?: number | null;
  senderAddress?: string | null;
  receivedAt: Date;
  visibility?: CommentVisibility;
  deliveryMode?: 'transmitted' | 'local-only' | null;
  sha256?: string | null;
  originalFilename?: string | null;
  uploadedByUserId?: number | null;
  uploadedByGuestId?: number | null;
}

/**
 * Indexes one document, or returns the existing row when it is already indexed.
 *
 * IDEMPOTENT BY DATABASE, not by check-then-insert: the unique index on
 * `(workspace_id, content_source, content_ref)` is the guarantee, and a
 * collision is caught rather than raced against. Same choice PRD-29 made for
 * `assertion_key`.
 */
export async function registerDocument(
  input: RegisterDocumentInput,
): Promise<WorkspaceDocument> {
  const [workspace] = await db
    .select({ id: referralWorkspaces.id })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, input.workspaceId))
    .limit(1);
  if (!workspace) throw new DocumentWorkspaceNotFoundError(input.workspaceId);

  const values = {
    workspaceId: input.workspaceId,
    contentSource: input.contentSource,
    contentRef: input.contentRef ?? null,
    uploadPath: input.uploadPath ?? null,
    contentType: input.contentType,
    claimedContentType: input.claimedContentType ?? null,
    docType: input.docType,
    loincCode: input.loincCode ?? null,
    protocolRelationship: input.protocolRelationship ?? null,
    source: input.source,
    scope: input.scope ?? 'referral',
    senderPartyId: input.senderPartyId ?? null,
    senderAddress: input.senderAddress ?? null,
    receivedAt: input.receivedAt,
    visibility: input.visibility ?? 'Internal',
    deliveryMode: input.deliveryMode ?? null,
    // Everything in this table is immutable, uploads included: nothing here is
    // ever edited in place. The column exists so a future mutable kind of
    // document has somewhere to say so, not because anything is mutable today.
    immutable: true,
    sha256: input.sha256 ?? null,
    originalFilename: input.originalFilename ?? null,
    uploadedByUserId: input.uploadedByUserId ?? null,
    uploadedByGuestId: input.uploadedByGuestId ?? null,
    createdAt: new Date(),
  };

  let documentId: number;
  try {
    const [row] = await db.insert(workspaceDocuments).values(values).returning();
    documentId = row.id;

    void emitEvent({
      eventType: 'workspace.document_indexed',
      entityType: 'referral',
      entityId: await referralIdFor(input.workspaceId),
      actor: input.uploadedByGuestId
        ? `guest:${input.uploadedByGuestId}`
        : input.uploadedByUserId
          ? `user:${input.uploadedByUserId}`
          : 'system',
      metadata: {
        workspaceId: input.workspaceId,
        documentId,
        contentSource: input.contentSource,
        docType: input.docType,
        source: input.source,
        scope: values.scope,
        visibility: values.visibility,
      },
    }).catch((err) => console.error('[DocumentService]', err));
  } catch (err) {
    if (!/UNIQUE constraint failed/i.test(String((err as Error).message))) throw err;
    // Already indexed. Return what is there rather than an error: a re-run of
    // the backfill, or a retried registration, is a no-op by design.
    const [existing] = await db
      .select({ id: workspaceDocuments.id })
      .from(workspaceDocuments)
      .where(
        and(
          eq(workspaceDocuments.workspaceId, input.workspaceId),
          eq(workspaceDocuments.contentSource, input.contentSource),
          input.contentRef === undefined || input.contentRef === null
            ? isNull(workspaceDocuments.contentRef)
            : eq(workspaceDocuments.contentRef, input.contentRef),
        ),
      )
      .limit(1);
    if (!existing) throw err;
    documentId = existing.id;
  }

  return getDocument(documentId);
}

/**
 * Indexes a protocol message from the thread. Called by `recordThreadMessage()`
 * so no individual messaging service has to know documents exist.
 *
 * Returns null when there is nothing to index — a thread entry with no content
 * in any column is an event, not a document (AC31). Deciding that here rather
 * than in the caller is what keeps the hook a single line.
 */
export async function registerThreadDocument(
  messageId: number,
): Promise<WorkspaceDocument | null> {
  const [message] = await db
    .select()
    .from(referralMessages)
    .where(eq(referralMessages.id, messageId))
    .limit(1);
  if (!message) return null;

  // Precedence xml → hl7 → body (AC30). A row with several columns populated is
  // one document, and this is which one.
  const content = message.contentXml ?? message.contentHl7 ?? message.contentBody ?? null;
  if (!content || !content.trim()) return null;
  const contentType = message.contentXml
    ? 'application/xml'
    : message.contentHl7
      ? 'text/plain'
      : 'text/plain';

  const [workspace] = await db
    .select({ id: referralWorkspaces.id })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.referralId, message.referralId))
    .limit(1);
  if (!workspace) return null;

  const inbound = message.direction === 'inbound';

  // An inbound sender teaches us which party sent it; an outbound sender is our
  // own address, which the receiving party row already holds.
  let senderPartyId: number | null = null;
  if (inbound && message.senderAddress) {
    const match = await findPartyByDirectAddress(workspace.id, message.senderAddress);
    senderPartyId = match?.party.id ?? null;
  }

  // Was this message rendered by the PRD-29 gateway? If so its assertion type is
  // a better protocol relationship than the state transition, and its delivery
  // mode is authoritative.
  const [assertion] = await db
    .select({
      assertionType: workspaceAssertions.assertionType,
      deliveryMode: workspaceAssertions.deliveryMode,
    })
    .from(workspaceAssertions)
    .where(eq(workspaceAssertions.artifactMessageId, message.id))
    .limit(1);

  const transmitted = assertion ? assertion.deliveryMode === 'transmitted' : true;

  return registerDocument({
    workspaceId: workspace.id,
    contentSource: 'referral-message',
    contentRef: message.id,
    contentType,
    docType: MESSAGE_DOC_TYPE[message.messageType] ?? message.messageType,
    protocolRelationship: assertion?.assertionType ?? message.relatedStateTransition ?? null,
    // An outbound artifact the gateway never transmitted is `generated`, not
    // `outbound-dsm`: nobody outside has it, and the visibility rule below reads
    // this field.
    source: inbound ? 'inbound-dsm' : transmitted ? 'outbound-dsm' : 'generated',
    senderPartyId,
    senderAddress: message.senderAddress,
    receivedAt: message.createdAt,
    // DERIVED FROM DIRECTION. A document that has crossed the wire to a party is
    // Shared, because calling it internal is a fiction — they have it.
    visibility: inbound || transmitted ? 'Shared' : 'Internal',
    deliveryMode: inbound ? null : transmitted ? 'transmitted' : 'local-only',
    sha256: sha256Of(content),
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

interface DocRow {
  id: number;
  workspaceId: number;
  contentSource: string;
  contentRef: number | null;
  uploadPath: string | null;
  contentType: string;
  claimedContentType: string | null;
  docType: string;
  loincCode: string | null;
  protocolRelationship: string | null;
  source: string;
  scope: string;
  senderPartyId: number | null;
  senderAddress: string | null;
  receivedAt: Date;
  visibility: string;
  deliveryMode: string | null;
  sha256: string | null;
  originalFilename: string | null;
  uploadedByUserId: number | null;
  uploadedByGuestId: number | null;
}

/**
 * Delivery status, DERIVED and never stored twice.
 *
 * Precedence, per AC11: the PRD-29 assertion's own status when this message is
 * an assertion artifact, then the thread row's ack status, then the legacy
 * `outbound_messages` row. An inbound document gets null rather than a
 * misleading value.
 */
async function deliveryFor(
  rows: DocRow[],
): Promise<Map<number, { status: DeliveryStatus | null; at: Date | null }>> {
  const out = new Map<number, { status: DeliveryStatus | null; at: Date | null }>();
  const messageRefs = rows
    .filter((r) => r.contentSource === 'referral-message' && r.contentRef !== null)
    .map((r) => r.contentRef as number);

  const assertions = messageRefs.length
    ? await db
        .select({
          artifactMessageId: workspaceAssertions.artifactMessageId,
          deliveryStatus: workspaceAssertions.deliveryStatus,
          deliveredAt: workspaceAssertions.deliveredAt,
        })
        .from(workspaceAssertions)
        .where(inArray(workspaceAssertions.artifactMessageId, messageRefs))
    : [];
  const byArtifact = new Map(assertions.map((a) => [a.artifactMessageId as number, a]));

  const messages = messageRefs.length
    ? await db
        .select({
          id: referralMessages.id,
          ackStatus: referralMessages.ackStatus,
          ackAt: referralMessages.ackAt,
          messageControlId: referralMessages.messageControlId,
        })
        .from(referralMessages)
        .where(inArray(referralMessages.id, messageRefs))
    : [];
  const byMessage = new Map(messages.map((m) => [m.id, m]));

  const controlIds = messages
    .map((m) => m.messageControlId)
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  const legacy = controlIds.length
    ? await db
        .select({
          messageControlId: outboundMessages.messageControlId,
          status: outboundMessages.status,
          acknowledgedAt: outboundMessages.acknowledgedAt,
        })
        .from(outboundMessages)
        .where(inArray(outboundMessages.messageControlId, controlIds))
    : [];
  const byControl = new Map(legacy.map((l) => [l.messageControlId, l]));

  for (const row of rows) {
    // Inbound and uploads have no delivery story at all.
    if (row.source === 'inbound-dsm' || row.source === 'payer-inbound' || row.source === 'uploaded') {
      out.set(row.id, { status: null, at: null });
      continue;
    }
    if (row.deliveryMode === 'local-only') {
      out.set(row.id, { status: 'Not-Transmitted', at: null });
      continue;
    }
    if (row.contentSource === 'referral-message' && row.contentRef !== null) {
      const assertion = byArtifact.get(row.contentRef);
      if (assertion) {
        const raw = assertion.deliveryStatus;
        const status: DeliveryStatus =
          raw === 'Delivered' || raw === 'Failed' || raw === 'Not-Transmitted' ? raw : 'Pending';
        out.set(row.id, { status, at: assertion.deliveredAt ?? null });
        continue;
      }
      const message = byMessage.get(row.contentRef);
      if (message?.ackStatus) {
        out.set(row.id, {
          status: message.ackStatus === 'Acknowledged' ? 'Delivered' : 'Pending',
          at: message.ackAt ?? null,
        });
        continue;
      }
      const fallback = message?.messageControlId
        ? byControl.get(message.messageControlId)
        : undefined;
      if (fallback) {
        out.set(row.id, {
          status: fallback.status === 'Acknowledged' ? 'Delivered' : 'Pending',
          at: fallback.acknowledgedAt ?? null,
        });
        continue;
      }
    }
    // Payer traffic: submitted or not is all we know, and that is honest.
    out.set(row.id, { status: 'Pending', at: null });
  }
  return out;
}

async function accessFor(
  documentIds: number[],
): Promise<Map<number, { internal: number; guest: number; last: Date | null }>> {
  const out = new Map<number, { internal: number; guest: number; last: Date | null }>();
  if (documentIds.length === 0) return out;
  const rows = await db
    .select()
    .from(documentAccessLog)
    .where(inArray(documentAccessLog.documentId, documentIds))
    .orderBy(asc(documentAccessLog.viewedAt));
  for (const row of rows) {
    const entry = out.get(row.documentId) ?? { internal: 0, guest: 0, last: null };
    // A denial is not an access. Counting it would overstate who has read this.
    if (row.action !== 'denied') {
      if (row.viewerGuestId !== null) entry.guest += 1;
      else entry.internal += 1;
      entry.last = row.viewedAt;
    }
    out.set(row.documentId, entry);
  }
  return out;
}

async function toDocuments(rows: DocRow[]): Promise<WorkspaceDocument[]> {
  const delivery = await deliveryFor(rows);
  const access = await accessFor(rows.map((r) => r.id));

  const partyIds = rows.map((r) => r.senderPartyId).filter((n): n is number => n !== null);
  const parties = partyIds.length
    ? await db
        .select({ id: workspaceParties.id, orgName: workspaceParties.orgName })
        .from(workspaceParties)
        .where(inArray(workspaceParties.id, partyIds))
    : [];
  const orgById = new Map(parties.map((p) => [p.id, p.orgName]));

  const userIds = rows.map((r) => r.uploadedByUserId).filter((n): n is number => n !== null);
  const uploaders = userIds.length
    ? await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const userById = new Map(uploaders.map((u) => [u.id, u.displayName]));

  const guestIds = rows.map((r) => r.uploadedByGuestId).filter((n): n is number => n !== null);
  const guests = guestIds.length
    ? await db
        .select({
          id: workspaceGuests.id,
          displayName: workspaceGuests.displayName,
          partyId: workspaceGuests.partyId,
        })
        .from(workspaceGuests)
        .where(inArray(workspaceGuests.id, guestIds))
    : [];
  const guestById = new Map(guests.map((g) => [g.id, g]));

  return rows.map((row) => {
    const d = delivery.get(row.id) ?? { status: null, at: null };
    const a = access.get(row.id) ?? { internal: 0, guest: 0, last: null };
    const guest = row.uploadedByGuestId !== null ? guestById.get(row.uploadedByGuestId) : undefined;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      docType: row.docType,
      loincCode: row.loincCode,
      protocolRelationship: row.protocolRelationship,
      source: row.source as DocumentSource,
      scope: row.scope === 'patient' ? 'patient' : 'referral',
      senderOrgName:
        row.senderPartyId !== null
          ? (orgById.get(row.senderPartyId) ?? null)
          : guest
            ? (orgById.get(guest.partyId) ?? null)
            : null,
      senderAddress: row.senderAddress,
      receivedAt: row.receivedAt,
      visibility: asVisibility(row.visibility),
      contentType: row.contentType,
      claimedContentType: row.claimedContentType,
      renderAs: renderAsFor(row.contentSource as ContentSource, row.contentType),
      deliveryMode: (row.deliveryMode as 'transmitted' | 'local-only' | null) ?? null,
      deliveryStatus: d.status,
      deliveredAt: d.at,
      accessCount: { internal: a.internal, guest: a.guest },
      lastAccessedAt: a.last,
      originalFilename: row.originalFilename,
      uploadedByDisplayName:
        row.uploadedByUserId !== null
          ? (userById.get(row.uploadedByUserId) ?? null)
          : guest
            ? (guest.displayName ?? 'A guest')
            : null,
      sha256: row.sha256,
    };
  });
}

/** The internal collection: everything, newest first. */
export async function listDocuments(workspaceId: number): Promise<WorkspaceDocument[]> {
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
    throw new DocumentWorkspaceNotFoundError(workspaceId);
  }
  const [workspace] = await db
    .select({ id: referralWorkspaces.id })
    .from(referralWorkspaces)
    .where(eq(referralWorkspaces.id, workspaceId))
    .limit(1);
  if (!workspace) throw new DocumentWorkspaceNotFoundError(workspaceId);

  const rows = (await db
    .select()
    .from(workspaceDocuments)
    .where(eq(workspaceDocuments.workspaceId, workspaceId))
    .orderBy(desc(workspaceDocuments.receivedAt), desc(workspaceDocuments.id))) as DocRow[];
  return toDocuments(rows);
}

export async function getDocument(documentId: number): Promise<WorkspaceDocument> {
  const rows = (await db
    .select()
    .from(workspaceDocuments)
    .where(eq(workspaceDocuments.id, documentId))
    .limit(1)) as DocRow[];
  if (rows.length === 0) throw new DocumentNotFoundError(documentId);
  const [document] = await toDocuments(rows);
  return document;
}

/**
 * What a guest sees. BOTH gates are in the SQL — `Shared` and referral-scoped —
 * so a patient-level payer document is never loaded into this process on a
 * guest's behalf, whatever its visibility says.
 */
export async function listSharedDocuments(
  workspaceId: number,
  viewerGuestId: number,
): Promise<GuestSharedDocument[]> {
  const rows = (await db
    .select()
    .from(workspaceDocuments)
    .where(
      and(
        eq(workspaceDocuments.workspaceId, workspaceId),
        eq(workspaceDocuments.visibility, 'Shared'),
        eq(workspaceDocuments.scope, 'referral'),
      ),
    )
    .orderBy(desc(workspaceDocuments.receivedAt), desc(workspaceDocuments.id))) as DocRow[];

  // toDocuments() is a plain `rows.map`, so index i of the result is index i of
  // `rows`. That is what makes reading uploadedByGuestId back off `rows` safe,
  // and it is the only reason the guest shape can carry `own` without widening
  // WorkspaceDocument to expose an uploader id to every caller.
  const documents = await toDocuments(rows);
  return documents.map((doc, i) => ({
    id: doc.id,
    docType: doc.docType,
    senderOrgName: doc.senderOrgName,
    receivedAt: doc.receivedAt.toISOString(),
    contentType: doc.contentType,
    renderAs: doc.renderAs,
    originalFilename: doc.originalFilename,
    own: rows[i].uploadedByGuestId === viewerGuestId,
  }));
}

export async function getAccessLog(documentId: number): Promise<AccessRecord[]> {
  await getDocument(documentId); // 404s for an unknown id rather than returning []

  const rows = await db
    .select()
    .from(documentAccessLog)
    .where(eq(documentAccessLog.documentId, documentId))
    .orderBy(desc(documentAccessLog.viewedAt));

  const userIds = rows.map((r) => r.viewerUserId).filter((n): n is number => n !== null);
  const named = userIds.length
    ? await db
        .select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const byId = new Map(named.map((u) => [u.id, u.displayName]));

  return rows.map((row) => ({
    action: row.action as 'view' | 'download' | 'denied',
    viewerKind:
      row.viewerUserId !== null ? 'user' : row.viewerGuestId !== null ? 'guest' : 'unknown',
    viewerDisplayName:
      row.viewerUserId !== null ? (byId.get(row.viewerUserId) ?? null) : row.viewerGuestId !== null ? 'A guest' : null,
    reason: row.reason,
    viewedAt: row.viewedAt,
  }));
}

// ── Content resolution ───────────────────────────────────────────────────────

/**
 * THE SINGLE PLACE that knows how to fetch bytes for each content source.
 *
 * `contentRef` deliberately carries no foreign key — it means a different table
 * per source — so the row it points at really can vanish. That is why the
 * missing case throws a distinct error rather than returning empty content: the
 * collection should say "no longer available" and keep the index entry, not
 * pretend the document was blank.
 */
export async function resolveContent(
  documentId: number,
): Promise<{ contentType: string; body: string | Buffer; filename: string }> {
  const rows = (await db
    .select()
    .from(workspaceDocuments)
    .where(eq(workspaceDocuments.id, documentId))
    .limit(1)) as DocRow[];
  if (rows.length === 0) throw new DocumentNotFoundError(documentId);
  const row = rows[0];

  const named = (extension: string): string =>
    row.originalFilename ?? `document-${row.id}${extension}`;

  switch (row.contentSource as ContentSource) {
    case 'referral-message': {
      const [message] = await db
        .select()
        .from(referralMessages)
        .where(eq(referralMessages.id, row.contentRef ?? 0))
        .limit(1);
      const body = message?.contentXml ?? message?.contentHl7 ?? message?.contentBody ?? null;
      if (!body) throw new DocumentContentUnavailableError(documentId);
      return { contentType: row.contentType, body, filename: named('.xml') };
    }

    case 'referral-ccda': {
      const [referral] = await db
        .select({ rawCcdaXml: referrals.rawCcdaXml })
        .from(referrals)
        .where(eq(referrals.id, row.contentRef ?? 0))
        .limit(1);
      if (!referral?.rawCcdaXml) throw new DocumentContentUnavailableError(documentId);
      return { contentType: 'application/xml', body: referral.rawCcdaXml, filename: named('.xml') };
    }

    case 'attachment-response': {
      const [response] = await db
        .select({ ccdaXml: attachmentResponses.ccdaXml })
        .from(attachmentResponses)
        .where(eq(attachmentResponses.id, row.contentRef ?? 0))
        .limit(1);
      if (!response?.ccdaXml) throw new DocumentContentUnavailableError(documentId);
      return { contentType: 'application/xml', body: response.ccdaXml, filename: named('.xml') };
    }

    case 'prior-auth-request': {
      const [request] = await db
        .select({ bundleJson: priorAuthRequests.bundleJson, claimJson: priorAuthRequests.claimJson })
        .from(priorAuthRequests)
        .where(eq(priorAuthRequests.id, row.contentRef ?? 0))
        .limit(1);
      const body = request?.bundleJson ?? request?.claimJson ?? null;
      if (!body) throw new DocumentContentUnavailableError(documentId);
      return { contentType: 'application/json', body, filename: named('.json') };
    }

    case 'prior-auth-response': {
      const [response] = await db
        .select({ responseJson: priorAuthResponses.responseJson })
        .from(priorAuthResponses)
        .where(eq(priorAuthResponses.id, row.contentRef ?? 0))
        .limit(1);
      if (!response?.responseJson) throw new DocumentContentUnavailableError(documentId);
      return {
        contentType: 'application/json',
        body: response.responseJson,
        filename: named('.json'),
      };
    }

    case 'upload': {
      if (!row.uploadPath) throw new DocumentContentUnavailableError(documentId);
      try {
        const body = await fs.readFile(row.uploadPath);
        return { contentType: row.contentType, body, filename: named('') };
      } catch {
        // The row survived and the file did not. Same story as a vanished
        // database row, so the same error.
        throw new DocumentContentUnavailableError(documentId);
      }
    }

    default:
      throw new DocumentContentUnavailableError(documentId);
  }
}

// ── Access logging ───────────────────────────────────────────────────────────

/**
 * Written BEFORE the bytes are streamed, and awaited, so a failed stream still
 * leaves evidence of the attempt. Fire-and-forget here would mean a reader could
 * fetch a document and leave no trace if the process died mid-response.
 */
export async function recordAccess(
  documentId: number,
  viewer: { userId?: number; guestId?: number },
  action: 'view' | 'download' | 'denied',
  reason?: string,
): Promise<void> {
  await db.insert(documentAccessLog).values({
    documentId,
    viewerUserId: viewer.userId ?? null,
    viewerGuestId: viewer.guestId ?? null,
    action,
    reason: reason ?? null,
    viewedAt: new Date(),
  });

  const [row] = await db
    .select({ workspaceId: workspaceDocuments.workspaceId })
    .from(workspaceDocuments)
    .where(eq(workspaceDocuments.id, documentId))
    .limit(1);
  if (!row) return;

  void emitEvent({
    eventType:
      action === 'denied'
        ? 'workspace.document_access_denied'
        : action === 'download'
          ? 'workspace.document_downloaded'
          : 'workspace.document_viewed',
    entityType: 'referral',
    entityId: await referralIdFor(row.workspaceId),
    actor: viewer.guestId
      ? `guest:${viewer.guestId}`
      : viewer.userId
        ? `user:${viewer.userId}`
        : 'unknown',
    metadata: {
      workspaceId: row.workspaceId,
      documentId,
      action,
      ...(reason ? { reason } : {}),
    },
  }).catch((err) => console.error('[DocumentService]', err));
}

/**
 * THE GUEST GUARD. Both gates, in one place, so no route can check one and
 * forget the other.
 *
 * A refusal is RECORDED here rather than by the caller, for the same reason:
 * the denial is the audit-relevant event and a caller could omit it.
 */
export async function assertGuestMayRead(
  documentId: number,
  guest: GuestContext,
): Promise<WorkspaceDocument> {
  const rows = (await db
    .select()
    .from(workspaceDocuments)
    .where(eq(workspaceDocuments.id, documentId))
    .limit(1)) as DocRow[];
  if (rows.length === 0) throw new DocumentNotFoundError(documentId);
  const row = rows[0];

  const deny = async (reason: string): Promise<never> => {
    await recordAccess(documentId, { guestId: guest.guestId }, 'denied', reason);
    throw new DocumentAccessDeniedError();
  };

  if (row.workspaceId !== guest.workspaceId) await deny('another workspace');
  if (row.scope !== 'referral') await deny('patient-scoped document');
  if (asVisibility(row.visibility) !== 'Shared') await deny('internal document');

  const [document] = await toDocuments(rows);
  return document;
}

// ── Upload ───────────────────────────────────────────────────────────────────

export interface UploadDocumentInput {
  workspaceId: number;
  body: Buffer;
  claimedContentType: string | null;
  originalFilename: string;
  docType?: string;
  visibility?: CommentVisibility;
  uploader: { kind: 'user'; user: ActingUser } | { kind: 'guest'; guest: GuestContext };
}

const UPLOAD_DOC_TYPE: Record<string, string> = {
  'application/pdf': 'Uploaded PDF',
  'image/jpeg': 'Uploaded Image',
  'image/png': 'Uploaded Image',
  'application/xml': 'Uploaded XML',
};

/**
 * Stores an uploaded document and indexes it. NEVER TRANSMITS — transmitting is
 * an assertion, PRD-29, and a separate explicit action.
 */
export async function uploadDocument(input: UploadDocumentInput): Promise<WorkspaceDocument> {
  if (input.body.length === 0) throw new UploadEmptyError();
  if (input.body.length > config.workspace.maxUploadBytes) {
    throw new UploadTooLargeError(input.body.length);
  }

  const detected = detectContentType(input.body);
  if (!detected) throw new UploadTypeNotAllowedError();

  let visibility: CommentVisibility;
  if (input.uploader.kind === 'guest') {
    if (input.visibility !== undefined && input.visibility !== 'Shared') {
      throw new GuestUploadVisibilityError();
    }
    visibility = 'Shared';
  } else {
    visibility = input.visibility ?? 'Internal';
  }

  // THE CLIENT FILENAME IS NEVER A PATH COMPONENT. A generated name, so a
  // traversal attempt is inert; the original is kept as metadata only, with any
  // directory part stripped so nothing downstream can reassemble it.
  const storedName = `${randomUUID()}${detected.ext}`;
  const dir = path.resolve(config.workspace.uploadDir);
  const fullPath = path.join(dir, storedName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(fullPath, input.body);

  const original = path.basename(input.originalFilename || '').slice(0, 255) || storedName;

  try {
    const document = await registerDocument({
      workspaceId: input.workspaceId,
      contentSource: 'upload',
      contentRef: null,
      uploadPath: fullPath,
      contentType: detected.type,
      // Recorded only when it disagreed, so the row does not carry noise for the
      // ordinary case where the browser got it right.
      claimedContentType:
        input.claimedContentType && input.claimedContentType !== detected.type
          ? input.claimedContentType
          : null,
      docType: input.docType?.trim() || UPLOAD_DOC_TYPE[detected.type] || 'Uploaded Document',
      source: 'uploaded',
      scope: 'referral',
      senderPartyId: input.uploader.kind === 'guest' ? input.uploader.guest.partyId : null,
      receivedAt: new Date(),
      visibility,
      deliveryMode: null,
      sha256: sha256Of(input.body),
      originalFilename: original,
      uploadedByUserId: input.uploader.kind === 'user' ? input.uploader.user.id : null,
      uploadedByGuestId: input.uploader.kind === 'guest' ? input.uploader.guest.guestId : null,
    });
    void emitEvent({
      eventType: 'workspace.document_uploaded',
      entityType: 'referral',
      entityId: await referralIdFor(input.workspaceId),
      actor:
        input.uploader.kind === 'guest'
          ? `guest:${input.uploader.guest.guestId}`
          : `user:${input.uploader.user.id}`,
      metadata: {
        workspaceId: input.workspaceId,
        documentId: document.id,
        contentType: detected.type,
        bytes: input.body.length,
        visibility,
        // The guarantee, recorded rather than merely asserted in a comment.
        transmitted: false,
      },
    }).catch((err) => console.error('[DocumentService]', err));

    // PRD-27 AC6/AC19. A guest upload is BOTH a new document and a
    // guest-activity event, and the second is the one an internal reader
    // actually needs — it names the organization that acted (AC20).
    void (async (): Promise<void> => {
      const notifications = await import('./notificationService');
      if (input.uploader.kind === 'guest') {
        await notifications.notifyGuestActivity(
          input.workspaceId,
          input.uploader.guest.displayName ?? 'A guest',
          await initiatingOrgNameFor(input.workspaceId),
          `uploaded ${original}`,
        );
      } else {
        await notifications.notifyNewDocument(
          input.workspaceId,
          original,
          input.uploader.user.displayName,
          input.uploader.user.id,
        );
      }
    })().catch((err) => console.error('[DocumentService] upload notification failed', err));

    return document;
  } catch (err) {
    // Do not leave an orphan file behind a failed index write.
    await fs.unlink(fullPath).catch(() => undefined);
    throw err;
  }
}

/** The initiating party's organization name, for PRD-27 AC20. */
async function initiatingOrgNameFor(workspaceId: number): Promise<string | null> {
  const rows = await db
    .select({ orgName: workspaceParties.orgName })
    .from(workspaceParties)
    .where(
      and(eq(workspaceParties.workspaceId, workspaceId), eq(workspaceParties.partyRole, 'initiating')),
    )
    .limit(1);
  return rows[0]?.orgName ?? null;
}

// ── Backfill ─────────────────────────────────────────────────────────────────

export interface BackfillResult {
  messages: number;
  legacyCcda: number;
  attachments: number;
  priorAuth: number;
  /** Already indexed — a re-run, or the live hook got there first. */
  alreadyIndexed: number;
  /** Nothing to index: a thread entry with no content in any column. */
  empty: number;
}

/**
 * Indexes every document already in the database. Safe to re-run: the unique
 * index makes each registration a no-op the second time, which is stricter than
 * `backfill-thread.ts` — that one short-circuits if its table has any rows at
 * all, so a database half-populated by the live path would never be completed.
 */
export async function backfillDocuments(): Promise<BackfillResult> {
  const result: BackfillResult = {
    messages: 0,
    legacyCcda: 0,
    attachments: 0,
    priorAuth: 0,
    alreadyIndexed: 0,
    empty: 0,
  };

  const before = new Set(
    (await db.select({ id: workspaceDocuments.id }).from(workspaceDocuments)).map((r) => r.id),
  );

  /**
   * True when this registration created a row. Also tallies WHY it did not, in
   * the two cases that mean different things: a null document had nothing to
   * index, and a pre-existing id was already there. One combined "skipped"
   * counter cannot tell an operator which of those 500 rows they are looking at.
   */
  const counted = (document: WorkspaceDocument | null): boolean => {
    // `null` only ever comes from registerThreadDocument — registerDocument
    // either indexes, returns what is already there, or throws.
    if (document === null) {
      result.empty += 1;
      return false;
    }
    if (before.has(document.id)) {
      result.alreadyIndexed += 1;
      return false;
    }
    return true;
  };

  // 1. Every protocol message with content.
  const messages = await db.select({ id: referralMessages.id }).from(referralMessages);
  for (const message of messages) {
    if (counted(await registerThreadDocument(message.id))) result.messages += 1;
  }

  // 2. The legacy inbound C-CDA, only where the thread does not already carry
  //    it. On a healthy database this indexes nothing.
  const workspaces = await db
    .select({ id: referralWorkspaces.id, referralId: referralWorkspaces.referralId })
    .from(referralWorkspaces);

  for (const workspace of workspaces) {
    const [referral] = await db
      .select({ rawCcdaXml: referrals.rawCcdaXml, referrerAddress: referrals.referrerAddress, createdAt: referrals.createdAt })
      .from(referrals)
      .where(eq(referrals.id, workspace.referralId))
      .limit(1);
    if (!referral?.rawCcdaXml) continue;

    const [threadRow] = await db
      .select({ id: referralMessages.id })
      .from(referralMessages)
      .where(
        and(
          eq(referralMessages.referralId, workspace.referralId),
          eq(referralMessages.messageType, 'ReferralCCDA'),
        ),
      )
      .limit(1);
    if (threadRow) continue; // the thread has it; nothing to add

    const match = await findPartyByDirectAddress(workspace.id, referral.referrerAddress);
    const document = await registerDocument({
      workspaceId: workspace.id,
      contentSource: 'referral-ccda',
      contentRef: workspace.referralId,
      contentType: 'application/xml',
      docType: 'Referral Note',
      source: 'inbound-dsm',
      senderPartyId: match?.party.id ?? null,
      senderAddress: referral.referrerAddress,
      receivedAt: referral.createdAt,
      visibility: 'Shared',
      sha256: sha256Of(referral.rawCcdaXml),
    });
    if (counted(document)) result.legacyCcda += 1;
  }

  // 3. Claims attachment responses, reached by PATIENT because that is the only
  //    link there is. See the schema comment: scope records the consequence.
  for (const workspace of workspaces) {
    const [referral] = await db
      .select({ patientId: referrals.patientId })
      .from(referrals)
      .where(eq(referrals.id, workspace.referralId))
      .limit(1);
    if (!referral) continue;

    const responses = await db
      .select({
        id: attachmentResponses.id,
        loincCode: attachmentResponses.loincCode,
        ccdaDocumentType: attachmentResponses.ccdaDocumentType,
        ccdaXml: attachmentResponses.ccdaXml,
        sentAt: attachmentResponses.sentAt,
        payerName: attachmentRequests.payerName,
      })
      .from(attachmentResponses)
      .innerJoin(attachmentRequests, eq(attachmentRequests.id, attachmentResponses.requestId))
      .where(eq(attachmentRequests.patientId, referral.patientId));

    for (const response of responses) {
      if (!response.ccdaXml) continue;
      const document = await registerDocument({
        workspaceId: workspace.id,
        contentSource: 'attachment-response',
        contentRef: response.id,
        contentType: 'application/xml',
        docType: response.ccdaDocumentType,
        loincCode: response.loincCode,
        protocolRelationship: 'claims-attachment',
        source: 'payer-outbound',
        // THE ONLY patient-scoped source.
        scope: 'patient',
        senderAddress: response.payerName,
        receivedAt: response.sentAt ?? new Date(),
        visibility: 'Internal',
        deliveryMode: response.sentAt ? 'transmitted' : 'local-only',
        sha256: sha256Of(response.ccdaXml),
      });
      if (counted(document)) result.attachments += 1;
    }
  }

  // 4. Prior auth, which DOES have a referral link.
  for (const workspace of workspaces) {
    const requests = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.referralId, workspace.referralId));

    for (const request of requests) {
      const body = request.bundleJson ?? request.claimJson;
      const requestDoc = await registerDocument({
        workspaceId: workspace.id,
        contentSource: 'prior-auth-request',
        contentRef: request.id,
        contentType: 'application/json',
        docType: request.bundleJson ? 'Prior Auth Bundle' : 'Prior Auth Claim',
        protocolRelationship: 'prior-authorization',
        source: 'payer-outbound',
        senderAddress: request.insurerName,
        receivedAt: request.submittedAt ?? request.createdAt,
        visibility: 'Internal',
        deliveryMode: request.submittedAt ? 'transmitted' : 'local-only',
        sha256: sha256Of(body),
      });
      if (counted(requestDoc)) result.priorAuth += 1;

      const responses = await db
        .select()
        .from(priorAuthResponses)
        .where(eq(priorAuthResponses.requestId, request.id));
      for (const response of responses) {
        const responseDoc = await registerDocument({
          workspaceId: workspace.id,
          contentSource: 'prior-auth-response',
          contentRef: response.id,
          contentType: 'application/json',
          docType: `Prior Auth Decision — ${response.outcome}`,
          protocolRelationship: 'prior-authorization',
          source: 'payer-inbound',
          senderAddress: request.insurerName,
          receivedAt: response.receivedAt,
          visibility: 'Internal',
          sha256: sha256Of(response.responseJson),
        });
        if (counted(responseDoc)) result.priorAuth += 1;
      }
    }
  }

  return result;
}
