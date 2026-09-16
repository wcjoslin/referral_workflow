/**
 * Unit tests for documentService.ts (PRD-23)
 *
 * Three things carry most of the weight here:
 *
 *   - TWO INDEPENDENT GUEST GATES. Visibility and scope. The interesting test is
 *     not that an internal document is withheld — it is that a PATIENT-SCOPED
 *     document marked `Shared` is still withheld, because that is the mistake a
 *     single check would let through.
 *   - THE ALLOW-LIST IS ON BYTES, not on the declared content type. Every upload
 *     test lies about its Content-Type on purpose.
 *   - IDEMPOTENCY IS THE DATABASE'S. Asserted by registering twice and counting
 *     rows, not by trusting a guard.
 */

import os from 'os';
import path from 'path';
import { promises as fsp } from 'fs';

const UPLOAD_DIR = path.join(os.tmpdir(), `prd23-uploads-${process.pid}`);

jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct', orgName: 'Specialist Care Group' },
    database: { url: ':memory:' },
    workspace: {
        // PRD-27. Without these the notification path silently no-ops and
        // every assignment or mention in this suite logs a failure.
        notificationRetentionDays: 90,
        notificationCollapseWindowMinutes: 15,
      publicBaseUrl: 'http://test.invalid',
      guestInvitationExpiryHours: 336,
      guestSessionExpiryHours: 24,
      senderIdentityMode: 'organization',
      uploadDir: UPLOAD_DIR,
      maxUploadBytes: 4096,
    },
  },
}));

jest.mock('../../../src/modules/messaging/mailer', () => ({
  sendMail: jest.fn().mockResolvedValue(false),
  buildTransport: jest.fn(),
}));

jest.mock('../../../src/db', () => {
  const Database = require('better-sqlite3');
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const schema = require('../../../src/db/schema');

  const sqlite = new Database(':memory:');
  sqlite.exec(require('../../helpers/testSchema').TEST_SCHEMA_DDL);
  return { db: drizzle(sqlite, { schema }) };
});

import { eq } from 'drizzle-orm';
import { db } from '../../../src/db';
import {
  attachmentRequests,
  attachmentResponses,
  documentAccessLog,
  outboundMessages,
  partyAddresses,
  patients,
  priorAuthRequests,
  priorAuthResponses,
  referralMessages,
  referralWorkspaces,
  referrals,
  users,
  workflowEvents,
  workspaceAssertions,
  workspaceDocuments,
  workspaceGuests,
  workspaceInvitations,
  workspaceParties,
} from '../../../src/db/schema';
import { ReferralState } from '../../../src/state/referralStateMachine';
import { WorkStatus } from '../../../src/state/workStatusMachine';
import { ActingUser } from '../../../src/modules/workspace/identityService';
import { GuestContext } from '../../../src/modules/workspace/guestAccess';
import {
  DocumentAccessDeniedError,
  DocumentContentUnavailableError,
  DocumentNotFoundError,
  DocumentWorkspaceNotFoundError,
  GUEST_DOCUMENT_KEYS,
  GuestUploadVisibilityError,
  UploadEmptyError,
  UploadTooLargeError,
  UploadTypeNotAllowedError,
  assertGuestMayRead,
  backfillDocuments,
  detectContentType,
  getAccessLog,
  getDocument,
  listDocuments,
  listSharedDocuments,
  recordAccess,
  registerDocument,
  registerThreadDocument,
  resolveContent,
  uploadDocument,
} from '../../../src/modules/workspace/documentService';

let seq = 0;
let dana: ActingUser;

const acting = (id: number, displayName: string): ActingUser => ({
  id,
  displayName,
  email: `${id}@example.test`,
  directAddress: null,
  jobRole: 'coordinator',
  legacyClinicianId: null,
  allQueuesAccess: false,
  active: true,
});

// Real headers, so the allow-list is tested against what a file actually is.
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jfif')]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('ihdr'),
]);
const XML = Buffer.from('<?xml version="1.0"?><ClinicalDocument/>');
const XML_BOM = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('  \n<root/>')]);
const GIF = Buffer.from('GIF89a and then some');

beforeAll(async () => {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
});

afterAll(async () => {
  await fsp.rm(UPLOAD_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.delete(documentAccessLog);
  await db.delete(workspaceDocuments);
  await db.delete(workspaceAssertions);
  await db.delete(workspaceGuests);
  await db.delete(workspaceInvitations);
  await db.delete(partyAddresses);
  await db.delete(workspaceParties);
  await db.delete(workflowEvents);
  await db.delete(referralMessages);
  await db.delete(outboundMessages);
  await db.delete(priorAuthResponses);
  await db.delete(priorAuthRequests);
  await db.delete(attachmentResponses);
  await db.delete(attachmentRequests);
  await db.delete(referralWorkspaces);
  await db.delete(referrals);
  await db.delete(users);
  await db.delete(patients);

  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Dana Ruiz',
      email: `dana-${++seq}@example.test`,
      jobRole: 'coordinator',
      allQueuesAccess: false,
      active: true,
      createdAt: new Date(),
    })
    .returning();
  dana = acting(user.id, 'Dana Ruiz');
});

interface Fixture {
  workspaceId: number;
  referralId: number;
  patientId: number;
  receivingPartyId: number;
  initiatingPartyId: number;
}

async function makeWorkspace(): Promise<Fixture> {
  const [patient] = await db
    .insert(patients)
    .values({ firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1815-12-10' })
    .returning();

  const [referral] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      sourceMessageId: `doc-${++seq}-${Date.now()}`,
      referrerAddress: 'referrals@lakeside.direct',
      reasonForReferral: 'Chest pain',
      state: ReferralState.SCHEDULED,
      routingDepartment: 'Cardiology',
      rawCcdaXml: '<ClinicalDocument>legacy</ClinicalDocument>',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const [workspace] = await db
    .insert(referralWorkspaces)
    .values({
      referralId: referral.id,
      workStatus: WorkStatus.WAITING_EXTERNAL,
      workStatusIsManual: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const [receiving] = await db
    .insert(workspaceParties)
    .values({
      workspaceId: workspace.id,
      partyRole: 'receiving',
      orgName: 'Specialist Care Group',
      orgNameVerified: true,
      directAddress: 'receiving@specialist.direct',
      protocolMode: 'workspace-mediated',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const [initiating] = await db
    .insert(workspaceParties)
    .values({
      workspaceId: workspace.id,
      partyRole: 'initiating',
      orgName: 'Lakeside Primary Care',
      orgNameVerified: false,
      directAddress: 'referrals@lakeside.direct',
      protocolMode: 'workspace-mediated',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  return {
    workspaceId: workspace.id,
    referralId: referral.id,
    patientId: patient.id,
    receivingPartyId: receiving.id,
    initiatingPartyId: initiating.id,
  };
}

async function makeMessage(
  fx: Fixture,
  overrides: Partial<{
    direction: string;
    messageType: string;
    contentXml: string | null;
    contentHl7: string | null;
    contentBody: string | null;
    senderAddress: string | null;
    ackStatus: string | null;
    ackAt: Date | null;
    messageControlId: string | null;
    relatedStateTransition: string | null;
  }> = {},
): Promise<number> {
  const [row] = await db
    .insert(referralMessages)
    .values({
      referralId: fx.referralId,
      direction: overrides.direction ?? 'inbound',
      messageType: overrides.messageType ?? 'ReferralCCDA',
      summary: 'a message',
      senderAddress: overrides.senderAddress ?? 'referrals@lakeside.direct',
      recipientAddress: 'receiving@specialist.direct',
      contentXml: overrides.contentXml ?? null,
      contentHl7: overrides.contentHl7 ?? null,
      contentBody: overrides.contentBody ?? null,
      messageControlId: overrides.messageControlId ?? null,
      ackStatus: overrides.ackStatus ?? null,
      ackAt: overrides.ackAt ?? null,
      relatedStateTransition: overrides.relatedStateTransition ?? null,
      createdAt: new Date(),
    })
    .returning();
  return row.id;
}

async function makeGuest(fx: Fixture): Promise<GuestContext> {
  const [invitation] = await db
    .insert(workspaceInvitations)
    .values({
      workspaceId: fx.workspaceId,
      partyId: fx.initiatingPartyId,
      recipientEmail: `guest-${++seq}@lakeside.test`,
      tokenHash: `hash-${seq}`,
      invitedByUserId: dana.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      emailDelivered: false,
      createdAt: new Date(),
    })
    .returning();

  const [guest] = await db
    .insert(workspaceGuests)
    .values({
      invitationId: invitation.id,
      workspaceId: fx.workspaceId,
      partyId: fx.initiatingPartyId,
      displayName: 'Dr. Ruth Okoro',
      sessionTokenHash: `session-${seq}`,
      sessionExpiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
    })
    .returning();

  return {
    guestId: guest.id,
    invitationId: invitation.id,
    workspaceId: fx.workspaceId,
    partyId: fx.initiatingPartyId,
    partyRole: 'initiating',
    partyOrgName: 'Lakeside Primary Care',
    protocolMode: 'workspace-mediated',
    displayName: 'Dr. Ruth Okoro',
    expiresAt: guest.sessionExpiresAt as Date,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('documentService (PRD-23)', () => {
  // ── Type detection ────────────────────────────────────────────────────────

  describe('detectContentType()', () => {
    it('recognises PDF, JPEG, PNG and XML from their leading bytes', () => {
      expect(detectContentType(PDF)?.type).toBe('application/pdf');
      expect(detectContentType(JPEG)?.type).toBe('image/jpeg');
      expect(detectContentType(PNG)?.type).toBe('image/png');
      expect(detectContentType(XML)?.type).toBe('application/xml');
    });

    it('sees past a UTF-8 BOM and leading whitespace for XML', () => {
      expect(detectContentType(XML_BOM)?.type).toBe('application/xml');
    });

    it('returns null for anything else, including a plausible-looking image', () => {
      expect(detectContentType(GIF)).toBeNull();
      expect(detectContentType(Buffer.from('just some text'))).toBeNull();
      expect(detectContentType(Buffer.alloc(0))).toBeNull();
    });
  });

  // ── Registration ──────────────────────────────────────────────────────────

  describe('registerThreadDocument()', () => {
    it('indexes an inbound C-CDA as a shared referral note', async () => {
      const fx = await makeWorkspace();
      const messageId = await makeMessage(fx, { contentXml: '<ClinicalDocument/>' });

      const document = await registerThreadDocument(messageId);

      expect(document).toMatchObject({
        docType: 'Referral Note',
        source: 'inbound-dsm',
        scope: 'referral',
        // Inbound: they sent it to us, so calling it internal would be a fiction.
        visibility: 'Shared',
        contentType: 'application/xml',
        renderAs: 'ccda',
        // Inbound documents have no delivery story of their own.
        deliveryStatus: null,
        deliveryMode: null,
      });
      expect(document!.senderOrgName).toBe('Lakeside Primary Care');
      expect(document!.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns null for a thread entry with no content in any column', async () => {
      const fx = await makeWorkspace();
      const messageId = await makeMessage(fx, {
        messageType: 'MDN',
        contentXml: null,
        contentHl7: null,
        contentBody: null,
      });
      await expect(registerThreadDocument(messageId)).resolves.toBeNull();
      await expect(listDocuments(fx.workspaceId)).resolves.toEqual([]);
    });

    it('treats a whitespace-only body as no content', async () => {
      const fx = await makeWorkspace();
      const messageId = await makeMessage(fx, { contentBody: '   \n  ' });
      await expect(registerThreadDocument(messageId)).resolves.toBeNull();
    });

    it('picks content in the order xml, hl7, body', async () => {
      const fx = await makeWorkspace();
      const both = await makeMessage(fx, {
        contentXml: '<x/>',
        contentHl7: 'MSH|...',
        contentBody: 'text',
      });
      const hl7 = await makeMessage(fx, {
        messageType: 'RRI',
        direction: 'outbound',
        contentHl7: 'MSH|...',
        contentBody: 'text',
      });
      const body = await makeMessage(fx, {
        messageType: 'InterimUpdate',
        direction: 'outbound',
        contentBody: 'text',
      });

      const a = await registerThreadDocument(both);
      const b = await registerThreadDocument(hl7);
      const c = await registerThreadDocument(body);

      expect(a!.contentType).toBe('application/xml');
      expect(b!.contentType).toBe('text/plain');
      expect(c!.contentType).toBe('text/plain');
      // And each is exactly one document, not one per populated column.
      await expect(listDocuments(fx.workspaceId)).resolves.toHaveLength(3);
    });

    it('maps every known message type to a label a coordinator would recognise', async () => {
      const fx = await makeWorkspace();
      const expected: [string, string][] = [
        ['RRI', 'Referral Response'],
        ['SIU', 'Appointment Notification'],
        ['ConsultNote', 'Consult Note'],
        ['NoShowNotification', 'No-Show Notification'],
        ['ACK', 'Acknowledgement'],
      ];
      for (const [messageType, label] of expected) {
        const id = await makeMessage(fx, { messageType, direction: 'outbound', contentHl7: 'MSH' });
        const document = await registerThreadDocument(id);
        expect(document!.docType).toBe(label);
      }
    });

    it('falls back to the raw message type for one it has no label for', async () => {
      const fx = await makeWorkspace();
      const id = await makeMessage(fx, {
        messageType: 'SomethingNew',
        direction: 'outbound',
        contentBody: 'hello',
      });
      const document = await registerThreadDocument(id);
      expect(document!.docType).toBe('SomethingNew');
    });

    it('marks an outbound artifact the gateway never transmitted as generated and internal', async () => {
      const fx = await makeWorkspace();
      const messageId = await makeMessage(fx, {
        direction: 'outbound',
        messageType: 'ConsultNote',
        contentXml: '<ClinicalDocument/>',
      });
      await db.insert(workspaceAssertions).values({
        workspaceId: fx.workspaceId,
        assertionKey: `k-${++seq}`,
        assertionType: 'final-outcome',
        assertedByPartyId: fx.receivingPartyId,
        assertedByActor: `user:${dana.id}`,
        artifactMessageId: messageId,
        deliveryMode: 'local-only',
        transportMode: 'address-on-file',
        deliveryStatus: 'Not-Transmitted',
        createdAt: new Date(),
      });

      const document = await registerThreadDocument(messageId);

      // Nobody outside has it, so sharing it would be wrong.
      expect(document).toMatchObject({
        source: 'generated',
        visibility: 'Internal',
        deliveryMode: 'local-only',
        deliveryStatus: 'Not-Transmitted',
        // The assertion type is a better protocol relationship than a transition.
        protocolRelationship: 'final-outcome',
      });
    });

    it('is idempotent — the database says so, not a guard', async () => {
      const fx = await makeWorkspace();
      const messageId = await makeMessage(fx, { contentXml: '<x/>' });

      const first = await registerThreadDocument(messageId);
      const second = await registerThreadDocument(messageId);

      expect(second!.id).toBe(first!.id);
      const rows = await db.select().from(workspaceDocuments);
      expect(rows).toHaveLength(1);
    });

    it('refuses to index against a workspace that does not exist', async () => {
      await expect(
        registerDocument({
          workspaceId: 9999,
          contentSource: 'upload',
          contentType: 'application/pdf',
          docType: 'X',
          source: 'uploaded',
          receivedAt: new Date(),
        }),
      ).rejects.toThrow(DocumentWorkspaceNotFoundError);
    });
  });

  // ── Delivery status derivation ────────────────────────────────────────────

  describe('delivery status', () => {
    it('prefers the assertion status over the thread ack', async () => {
      const fx = await makeWorkspace();
      const messageId = await makeMessage(fx, {
        direction: 'outbound',
        messageType: 'RRI',
        contentHl7: 'MSH',
        ackStatus: 'Pending',
      });
      await db.insert(workspaceAssertions).values({
        workspaceId: fx.workspaceId,
        assertionKey: `k-${++seq}`,
        assertionType: 'accept',
        assertedByPartyId: fx.receivingPartyId,
        assertedByActor: 'system',
        artifactMessageId: messageId,
        deliveryMode: 'transmitted',
        transportMode: 'address-on-file',
        deliveryStatus: 'Delivered',
        deliveredAt: new Date(),
        createdAt: new Date(),
      });

      const document = await registerThreadDocument(messageId);
      expect(document!.deliveryStatus).toBe('Delivered');
      expect(document!.deliveredAt).not.toBeNull();
    });

    it('uses the thread ack when there is no assertion', async () => {
      const fx = await makeWorkspace();
      const acked = await makeMessage(fx, {
        direction: 'outbound',
        messageType: 'SIU',
        contentHl7: 'MSH',
        ackStatus: 'Acknowledged',
        ackAt: new Date(),
      });
      const pending = await makeMessage(fx, {
        direction: 'outbound',
        messageType: 'RRI',
        contentHl7: 'MSH',
        ackStatus: 'Pending',
      });

      expect((await registerThreadDocument(acked))!.deliveryStatus).toBe('Delivered');
      expect((await registerThreadDocument(pending))!.deliveryStatus).toBe('Pending');
    });

    it('falls back to the legacy outbound_messages row', async () => {
      const fx = await makeWorkspace();
      const controlId = `MSG-${++seq}`;
      await db.insert(outboundMessages).values({
        referralId: fx.referralId,
        messageControlId: controlId,
        messageType: 'RRI',
        status: 'Acknowledged',
        sentAt: new Date(),
        acknowledgedAt: new Date(),
      });
      const messageId = await makeMessage(fx, {
        direction: 'outbound',
        messageType: 'RRI',
        contentHl7: 'MSH',
        messageControlId: controlId,
        ackStatus: null,
      });

      const document = await registerThreadDocument(messageId);
      expect(document!.deliveryStatus).toBe('Delivered');
    });

    it('gives an inbound document no status rather than a misleading one', async () => {
      const fx = await makeWorkspace();
      const messageId = await makeMessage(fx, { contentXml: '<x/>' });
      expect((await registerThreadDocument(messageId))!.deliveryStatus).toBeNull();
    });
  });

  // ── Content resolution ────────────────────────────────────────────────────

  describe('resolveContent()', () => {
    it('resolves a protocol message', async () => {
      const fx = await makeWorkspace();
      const messageId = await makeMessage(fx, { contentXml: '<ClinicalDocument>live</ClinicalDocument>' });
      const document = await registerThreadDocument(messageId);

      const content = await resolveContent(document!.id);
      expect(content.body).toBe('<ClinicalDocument>live</ClinicalDocument>');
      expect(content.contentType).toBe('application/xml');
    });

    it('resolves the legacy referral C-CDA', async () => {
      const fx = await makeWorkspace();
      const document = await registerDocument({
        workspaceId: fx.workspaceId,
        contentSource: 'referral-ccda',
        contentRef: fx.referralId,
        contentType: 'application/xml',
        docType: 'Referral Note',
        source: 'inbound-dsm',
        receivedAt: new Date(),
        visibility: 'Shared',
      });

      const content = await resolveContent(document!.id);
      expect(content.body).toBe('<ClinicalDocument>legacy</ClinicalDocument>');
    });

    it('resolves a claims attachment response', async () => {
      const fx = await makeWorkspace();
      const [request] = await db
        .insert(attachmentRequests)
        .values({
          patientId: fx.patientId,
          controlNumber: `ISA-${++seq}`,
          payerName: 'Big Payer',
          payerIdentifier: 'BP1',
          subscriberName: 'Ada Lovelace',
          requestedLoincCodes: '["34133-9"]',
          sourceFile: 'x.edi',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      const [response] = await db
        .insert(attachmentResponses)
        .values({
          requestId: request.id,
          loincCode: '34133-9',
          ccdaDocumentType: 'Summary of Episode Note',
          ccdaXml: '<ClinicalDocument>claims</ClinicalDocument>',
        })
        .returning();

      const document = await registerDocument({
        workspaceId: fx.workspaceId,
        contentSource: 'attachment-response',
        contentRef: response.id,
        contentType: 'application/xml',
        docType: 'Summary of Episode Note',
        source: 'payer-outbound',
        scope: 'patient',
        receivedAt: new Date(),
      });

      expect((await resolveContent(document!.id)).body).toBe(
        '<ClinicalDocument>claims</ClinicalDocument>',
      );
    });

    it('resolves a prior-auth bundle and a payer decision', async () => {
      const fx = await makeWorkspace();
      const [request] = await db
        .insert(priorAuthRequests)
        .values({
          referralId: fx.referralId,
          patientId: fx.patientId,
          claimJson: '{"resourceType":"Claim"}',
          bundleJson: '{"resourceType":"Bundle"}',
          insurerName: 'Big Payer',
          insurerId: 'BP1',
          serviceCode: '93000',
          providerNpi: '1234567893',
          providerName: 'Dr Chen',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      const [response] = await db
        .insert(priorAuthResponses)
        .values({
          requestId: request.id,
          responseJson: '{"resourceType":"ClaimResponse"}',
          outcome: 'approved',
          receivedVia: 'sync',
          receivedAt: new Date(),
        })
        .returning();

      const bundle = await registerDocument({
        workspaceId: fx.workspaceId,
        contentSource: 'prior-auth-request',
        contentRef: request.id,
        contentType: 'application/json',
        docType: 'Prior Auth Bundle',
        source: 'payer-outbound',
        receivedAt: new Date(),
      });
      const decision = await registerDocument({
        workspaceId: fx.workspaceId,
        contentSource: 'prior-auth-response',
        contentRef: response.id,
        contentType: 'application/json',
        docType: 'Prior Auth Decision — approved',
        source: 'payer-inbound',
        receivedAt: new Date(),
      });

      // The bundle wins over the claim when both are present.
      expect((await resolveContent(bundle!.id)).body).toBe('{"resourceType":"Bundle"}');
      expect((await resolveContent(decision!.id)).body).toBe('{"resourceType":"ClaimResponse"}');
      // Payer traffic renders as text, not in the C-CDA viewer.
      expect(bundle!.renderAs).toBe('text');
    });

    it('throws a distinct error when the row behind the index has vanished', async () => {
      const fx = await makeWorkspace();
      const messageId = await makeMessage(fx, { contentXml: '<x/>' });
      const document = await registerThreadDocument(messageId);

      // contentRef deliberately carries no foreign key — it means a different
      // table per source — so the row it points at really can go away.
      await db.delete(referralMessages).where(eq(referralMessages.id, messageId));

      await expect(resolveContent(document!.id)).rejects.toThrow(DocumentContentUnavailableError);
      // And the index entry survives, so the collection can say so.
      await expect(listDocuments(fx.workspaceId)).resolves.toHaveLength(1);
    });

    it('throws not-found for an id that was never a document', async () => {
      await expect(resolveContent(9999)).rejects.toThrow(DocumentNotFoundError);
    });
  });

  // ── Upload ────────────────────────────────────────────────────────────────

  describe('uploadDocument()', () => {
    it('stores a PDF, detects its type and defaults to Internal', async () => {
      const fx = await makeWorkspace();
      const document = await uploadDocument({
        workspaceId: fx.workspaceId,
        body: PDF,
        claimedContentType: 'application/pdf',
        originalFilename: 'imaging.pdf',
        uploader: { kind: 'user', user: dana },
      });

      expect(document).toMatchObject({
        contentType: 'application/pdf',
        docType: 'Uploaded PDF',
        source: 'uploaded',
        scope: 'referral',
        visibility: 'Internal',
        renderAs: 'download',
        originalFilename: 'imaging.pdf',
        // Never transmitted, so no delivery story.
        deliveryStatus: null,
      });
      expect(document.uploadedByDisplayName).toBe('Dana Ruiz');
      expect((await resolveContent(document.id)).body).toEqual(PDF);
    });

    it('believes the bytes, not the declared type, and records the disagreement', async () => {
      const fx = await makeWorkspace();
      const document = await uploadDocument({
        workspaceId: fx.workspaceId,
        body: PNG,
        // A lie, of exactly the kind a multipart parser would have accepted.
        claimedContentType: 'application/pdf',
        originalFilename: 'screenshot.pdf',
        uploader: { kind: 'user', user: dana },
      });
      expect(document.contentType).toBe('image/png');
      expect(document.claimedContentType).toBe('application/pdf');
    });

    it('records no claimed type when the client got it right', async () => {
      const fx = await makeWorkspace();
      const document = await uploadDocument({
        workspaceId: fx.workspaceId,
        body: JPEG,
        claimedContentType: 'image/jpeg',
        originalFilename: 'photo.jpg',
        uploader: { kind: 'user', user: dana },
      });
      expect(document.claimedContentType).toBeNull();
    });

    it('renders an uploaded XML as text rather than feeding it to the C-CDA viewer', async () => {
      const fx = await makeWorkspace();
      const document = await uploadDocument({
        workspaceId: fx.workspaceId,
        body: XML,
        claimedContentType: 'application/xml',
        originalFilename: 'something.xml',
        uploader: { kind: 'user', user: dana },
      });
      // An arbitrary uploaded XML is not a C-CDA, and the viewer would render an
      // empty frame rather than say so.
      expect(document.renderAs).toBe('text');
    });

    it('never uses the client filename as a path, and keeps it as metadata', async () => {
      const fx = await makeWorkspace();
      const document = await uploadDocument({
        workspaceId: fx.workspaceId,
        body: PDF,
        claimedContentType: 'application/pdf',
        originalFilename: '../../../../etc/passwd',
        uploader: { kind: 'user', user: dana },
      });

      const [row] = await db
        .select({ uploadPath: workspaceDocuments.uploadPath })
        .from(workspaceDocuments)
        .where(eq(workspaceDocuments.id, document.id));

      expect(row.uploadPath).toContain(UPLOAD_DIR);
      expect(row.uploadPath).not.toContain('..');
      expect(row.uploadPath).toMatch(/\.pdf$/);
      // The directory part is stripped, so nothing downstream can reassemble it.
      expect(document.originalFilename).toBe('passwd');
      // And the bytes really are where the row says.
      expect((await resolveContent(document.id)).body).toEqual(PDF);
    });

    it('rejects an empty file, an oversized one, and a type not on the list', async () => {
      const fx = await makeWorkspace();
      const base = {
        workspaceId: fx.workspaceId,
        claimedContentType: 'application/pdf',
        originalFilename: 'x.pdf',
        uploader: { kind: 'user' as const, user: dana },
      };

      await expect(uploadDocument({ ...base, body: Buffer.alloc(0) })).rejects.toThrow(
        UploadEmptyError,
      );
      await expect(
        uploadDocument({ ...base, body: Buffer.concat([PDF, Buffer.alloc(5000)]) }),
      ).rejects.toThrow(UploadTooLargeError);
      await expect(uploadDocument({ ...base, body: GIF })).rejects.toThrow(
        UploadTypeNotAllowedError,
      );

      // None of the three left a row or a file behind.
      await expect(listDocuments(fx.workspaceId)).resolves.toEqual([]);
      const files = await fsp.readdir(UPLOAD_DIR);
      expect(files.filter((f) => f.endsWith('.gif'))).toEqual([]);
    });

    it('honours a chosen visibility for an internal uploader', async () => {
      const fx = await makeWorkspace();
      const document = await uploadDocument({
        workspaceId: fx.workspaceId,
        body: PDF,
        claimedContentType: 'application/pdf',
        originalFilename: 'x.pdf',
        visibility: 'Shared',
        uploader: { kind: 'user', user: dana },
      });
      expect(document.visibility).toBe('Shared');
    });

    it('forces a guest upload to Shared and refuses any other value', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);

      const document = await uploadDocument({
        workspaceId: fx.workspaceId,
        body: PDF,
        claimedContentType: 'application/pdf',
        originalFilename: 'from-them.pdf',
        uploader: { kind: 'guest', guest },
      });
      expect(document.visibility).toBe('Shared');
      expect(document.senderOrgName).toBe('Lakeside Primary Care');
      expect(document.uploadedByDisplayName).toBe('Dr. Ruth Okoro');

      await expect(
        uploadDocument({
          workspaceId: fx.workspaceId,
          body: PDF,
          claimedContentType: 'application/pdf',
          originalFilename: 'private.pdf',
          visibility: 'Internal',
          uploader: { kind: 'guest', guest },
        }),
      ).rejects.toThrow(GuestUploadVisibilityError);
    });

    it('records that the upload was not transmitted', async () => {
      const fx = await makeWorkspace();
      await uploadDocument({
        workspaceId: fx.workspaceId,
        body: PDF,
        claimedContentType: 'application/pdf',
        originalFilename: 'x.pdf',
        uploader: { kind: 'user', user: dana },
      });
      const [event] = await db
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.eventType, 'workspace.document_uploaded'));
      const metadata = JSON.parse(event.metadata as string) as Record<string, unknown>;
      expect(metadata.transmitted).toBe(false);
    });
  });

  // ── The two guest gates ───────────────────────────────────────────────────

  describe('the guest gates', () => {
    async function threeDocuments(fx: Fixture): Promise<{
      shared: number;
      internal: number;
      patientShared: number;
    }> {
      const sharedId = await makeMessage(fx, { contentXml: '<shared/>' });
      const shared = await registerThreadDocument(sharedId);

      const internal = await registerDocument({
        workspaceId: fx.workspaceId,
        contentSource: 'prior-auth-request',
        contentRef: 1,
        contentType: 'application/json',
        docType: 'Prior Auth Bundle',
        source: 'payer-outbound',
        receivedAt: new Date(),
        visibility: 'Internal',
      });

      // The dangerous case: patient-scoped AND marked Shared. One gate would
      // let this through.
      const patientShared = await registerDocument({
        workspaceId: fx.workspaceId,
        contentSource: 'attachment-response',
        contentRef: 1,
        contentType: 'application/xml',
        docType: 'Summary of Episode Note',
        source: 'payer-outbound',
        scope: 'patient',
        receivedAt: new Date(),
        visibility: 'Shared',
      });

      return { shared: shared!.id, internal: internal!.id, patientShared: patientShared!.id };
    }

    it('shows a guest only shared, referral-scoped documents', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      const ids = await threeDocuments(fx);

      const visible = await listSharedDocuments(fx.workspaceId, guest.guestId);
      expect(visible.map((d) => d.id)).toEqual([ids.shared]);
    });

    it('refuses an internal document, and records the refusal', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      const ids = await threeDocuments(fx);

      await expect(assertGuestMayRead(ids.internal, guest)).rejects.toThrow(
        DocumentAccessDeniedError,
      );
      const log = await getAccessLog(ids.internal);
      expect(log[0]).toMatchObject({ action: 'denied', reason: 'internal document' });
    });

    it('refuses a PATIENT-SCOPED document even when it is marked Shared', async () => {
      // The whole point of two gates. A payer attachment about another episode
      // of care must not reach a referring office because one flag was toggled.
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      const ids = await threeDocuments(fx);

      await expect(assertGuestMayRead(ids.patientShared, guest)).rejects.toThrow(
        DocumentAccessDeniedError,
      );
      const log = await getAccessLog(ids.patientShared);
      expect(log[0]).toMatchObject({ action: 'denied', reason: 'patient-scoped document' });
    });

    it('refuses a document belonging to another workspace', async () => {
      const fx = await makeWorkspace();
      const other = await makeWorkspace();
      const guest = await makeGuest(fx);

      const elsewhereId = await makeMessage(other, { contentXml: '<elsewhere/>' });
      const elsewhere = await registerThreadDocument(elsewhereId);

      await expect(assertGuestMayRead(elsewhere!.id, guest)).rejects.toThrow(
        DocumentAccessDeniedError,
      );
      const log = await getAccessLog(elsewhere!.id);
      expect(log[0]).toMatchObject({ action: 'denied', reason: 'another workspace' });
    });

    it('lets a guest read a document that passes both gates', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      const ids = await threeDocuments(fx);
      await expect(assertGuestMayRead(ids.shared, guest)).resolves.toMatchObject({
        id: ids.shared,
      });
    });

    it('carries exactly the allowed keys to a guest', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      await threeDocuments(fx);

      const [visible] = await listSharedDocuments(fx.workspaceId, guest.guestId);
      // An allow-list, so a field added to the internal shape and copied through
      // fails here even though nobody listed it as forbidden.
      expect(Object.keys(visible).sort()).toEqual([...GUEST_DOCUMENT_KEYS].sort());
    });

    it('marks a guest their own uploads', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      const other = await makeGuest(fx);

      await uploadDocument({
        workspaceId: fx.workspaceId,
        body: PDF,
        claimedContentType: 'application/pdf',
        originalFilename: 'mine.pdf',
        uploader: { kind: 'guest', guest },
      });
      await uploadDocument({
        workspaceId: fx.workspaceId,
        body: JPEG,
        claimedContentType: 'image/jpeg',
        originalFilename: 'theirs.jpg',
        uploader: { kind: 'guest', guest: other },
      });

      const visible = await listSharedDocuments(fx.workspaceId, guest.guestId);
      const mine = visible.find((d) => d.originalFilename === 'mine.pdf');
      const theirs = visible.find((d) => d.originalFilename === 'theirs.jpg');
      expect(mine?.own).toBe(true);
      expect(theirs?.own).toBe(false);
    });
  });

  // ── Access evidence ───────────────────────────────────────────────────────

  describe('access logging', () => {
    it('counts internal and guest reads separately and ignores denials', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      const messageId = await makeMessage(fx, { contentXml: '<x/>' });
      const document = await registerThreadDocument(messageId);

      await recordAccess(document!.id, { userId: dana.id }, 'view');
      await recordAccess(document!.id, { userId: dana.id }, 'download');
      await recordAccess(document!.id, { guestId: guest.guestId }, 'view');
      await recordAccess(document!.id, {}, 'denied', 'no identity');

      const [refreshed] = await listDocuments(fx.workspaceId);
      // A denial is not an access. Counting it would overstate who has read this.
      expect(refreshed.accessCount).toEqual({ internal: 2, guest: 1 });
      expect(refreshed.lastAccessedAt).not.toBeNull();

      const log = await getAccessLog(document!.id);
      expect(log.map((a) => a.action)).toEqual(['denied', 'view', 'download', 'view']);
      expect(log.find((a) => a.action === 'denied')?.viewerKind).toBe('unknown');
    });

    it('names the internal viewer and keeps a guest anonymous in the log', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      const messageId = await makeMessage(fx, { contentXml: '<x/>' });
      const document = await registerThreadDocument(messageId);

      await recordAccess(document!.id, { userId: dana.id }, 'view');
      await recordAccess(document!.id, { guestId: guest.guestId }, 'view');

      const log = await getAccessLog(document!.id);
      expect(log.map((a) => a.viewerDisplayName)).toContain('Dana Ruiz');
      expect(log.map((a) => a.viewerDisplayName)).toContain('A guest');
    });

    it('refuses an access log for a document that does not exist', async () => {
      await expect(getAccessLog(9999)).rejects.toThrow(DocumentNotFoundError);
    });
  });

  // ── Listing ───────────────────────────────────────────────────────────────

  describe('listDocuments()', () => {
    it('orders newest first', async () => {
      const fx = await makeWorkspace();
      const older = await makeMessage(fx, { contentBody: 'older' });
      await db
        .update(referralMessages)
        .set({ createdAt: new Date(Date.now() - 86_400_000) })
        .where(eq(referralMessages.id, older));
      const newer = await makeMessage(fx, { contentBody: 'newer' });

      await registerThreadDocument(older);
      await registerThreadDocument(newer);

      const documents = await listDocuments(fx.workspaceId);
      expect(documents).toHaveLength(2);
      expect(documents[0].receivedAt.getTime()).toBeGreaterThan(
        documents[1].receivedAt.getTime(),
      );
    });

    it('does not leak another workspace’s documents', async () => {
      const fx = await makeWorkspace();
      const other = await makeWorkspace();
      await registerThreadDocument(await makeMessage(other, { contentXml: '<x/>' }));
      await expect(listDocuments(fx.workspaceId)).resolves.toEqual([]);
    });

    it('refuses an unknown workspace rather than returning nothing', async () => {
      await expect(listDocuments(9999)).rejects.toThrow(DocumentWorkspaceNotFoundError);
      await expect(listDocuments(0)).rejects.toThrow(DocumentWorkspaceNotFoundError);
    });

    it('404s getDocument for an unknown id', async () => {
      await expect(getDocument(9999)).rejects.toThrow(DocumentNotFoundError);
    });
  });

  // ── Backfill ──────────────────────────────────────────────────────────────

  describe('backfillDocuments()', () => {
    it('indexes history once and is a no-op on a re-run', async () => {
      const fx = await makeWorkspace();
      await makeMessage(fx, { contentXml: '<one/>' });
      await makeMessage(fx, { direction: 'outbound', messageType: 'RRI', contentHl7: 'MSH' });
      await makeMessage(fx, { messageType: 'MDN' }); // no content — not a document

      const first = await backfillDocuments();
      expect(first.messages).toBe(2);
      expect(first.empty).toBe(1);
      // The thread carries the referral C-CDA, so the legacy fallback adds nothing.
      expect(first.legacyCcda).toBe(0);

      const second = await backfillDocuments();
      expect(second.messages).toBe(0);
      expect(second.alreadyIndexed).toBe(2);
      await expect(listDocuments(fx.workspaceId)).resolves.toHaveLength(2);
    });

    it('uses the legacy fallback only when the thread has no ReferralCCDA row', async () => {
      const fx = await makeWorkspace();
      // raw_ccda_xml is set by the fixture; no thread row exists yet.
      const withFallback = await backfillDocuments();
      expect(withFallback.legacyCcda).toBe(1);

      const documents = await listDocuments(fx.workspaceId);
      expect(documents).toHaveLength(1);
      expect((await resolveContent(documents[0].id)).body).toBe(
        '<ClinicalDocument>legacy</ClinicalDocument>',
      );

      // Now the thread gets its own row. The fallback must not fire again, and
      // must not produce a second copy of the same document.
      await registerThreadDocument(await makeMessage(fx, { contentXml: '<live/>' }));
      const after = await backfillDocuments();
      expect(after.legacyCcda).toBe(0);
      await expect(listDocuments(fx.workspaceId)).resolves.toHaveLength(2);
    });

    it('indexes a claims attachment against every referral the patient has, as patient-scoped', async () => {
      // The consequence of indexing by patient, asserted rather than hidden.
      const first = await makeWorkspace();
      const [secondReferral] = await db
        .insert(referrals)
        .values({
          patientId: first.patientId,
          sourceMessageId: `second-${++seq}`,
          referrerAddress: 'referrals@lakeside.direct',
          state: ReferralState.RECEIVED,
          routingDepartment: 'Cardiology',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      await db.insert(referralWorkspaces).values({
        referralId: secondReferral.id,
        workStatus: WorkStatus.TRIAGE,
        workStatusIsManual: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const [request] = await db
        .insert(attachmentRequests)
        .values({
          patientId: first.patientId,
          controlNumber: `ISA-${++seq}`,
          payerName: 'Big Payer',
          payerIdentifier: 'BP1',
          subscriberName: 'Ada Lovelace',
          requestedLoincCodes: '["34133-9"]',
          sourceFile: 'x.edi',
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      await db.insert(attachmentResponses).values({
        requestId: request.id,
        loincCode: '34133-9',
        ccdaDocumentType: 'Summary of Episode Note',
        ccdaXml: '<ClinicalDocument>claims</ClinicalDocument>',
        sentAt: new Date(),
      });

      const result = await backfillDocuments();
      expect(result.attachments).toBe(2); // one per referral this patient has

      const documents = await listDocuments(first.workspaceId);
      const attachment = documents.find((d) => d.docType === 'Summary of Episode Note');
      expect(attachment).toMatchObject({
        scope: 'patient',
        source: 'payer-outbound',
        // A payer document is never shared with a party, whatever "outbound"
        // suggests.
        visibility: 'Internal',
        loincCode: '34133-9',
      });
    });

    it('indexes prior-auth documents against the referral they belong to', async () => {
      const fx = await makeWorkspace();
      const [request] = await db
        .insert(priorAuthRequests)
        .values({
          referralId: fx.referralId,
          patientId: fx.patientId,
          claimJson: '{"resourceType":"Claim"}',
          insurerName: 'Big Payer',
          insurerId: 'BP1',
          serviceCode: '93000',
          providerNpi: '1234567893',
          providerName: 'Dr Chen',
          createdAt: new Date(),
          updatedAt: new Date(),
          submittedAt: new Date(),
        })
        .returning();
      await db.insert(priorAuthResponses).values({
        requestId: request.id,
        responseJson: '{"resourceType":"ClaimResponse"}',
        outcome: 'denied',
        denialReason: 'Not medically necessary',
        receivedVia: 'sync',
        receivedAt: new Date(),
      });

      const result = await backfillDocuments();
      expect(result.priorAuth).toBe(2);

      const documents = await listDocuments(fx.workspaceId);
      const claim = documents.find((d) => d.docType === 'Prior Auth Claim');
      const decision = documents.find((d) => d.docType?.startsWith('Prior Auth Decision'));
      // No bundleJson, so the claim is what gets indexed and the label says so.
      expect(claim).toMatchObject({ scope: 'referral', source: 'payer-outbound' });
      expect(decision).toMatchObject({ scope: 'referral', source: 'payer-inbound' });
      expect(decision?.deliveryStatus).toBeNull();
    });
  });
});
