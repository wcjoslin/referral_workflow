---
up: "[[📋 PRD Index]]"
prev: "[[PRD-22 - Referral Conversation]]"
---

# PRD-23: Referral Document Collection

**Status:** Drafting  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

The clinical documents on a referral already exist in this system, but there is no such thing as *the
documents on a referral*. They are scattered across four places with four shapes: the inbound C-CDA sits in
`referrals.raw_ccda_xml`; protocol message bodies sit in `referral_messages.content_xml`,
`content_hl7` and `content_body`; claims attachment responses sit in `attachment_responses.ccda_xml`;
prior authorization bundles sit in `prior_auth_requests.claim_json`. The only document surface in the
UI is the single inbound C-CDA rendered in the review page's right-hand pane, reached by a
purpose-built route (`GET /referrals/:id/ccda.xml`) that exists to feed that one viewer.

So a coordinator cannot answer basic questions: what documents do we have on this referral, where did
each come from, who sent it, when did it arrive, which protocol step does it belong to, and has the
other side actually received the one we sent. The source document asks for exactly that — "one
referral document collection with type, source, sender, received date, and protocol relationship" —
and pairs it with delivery and access evidence.

The design decision that shapes this PRD: **do not copy the content.** A second copy of every C-CDA
is a synchronization problem and doubles the PHI footprint for no benefit. Instead this PRD adds an
*index*: one row per document that points at wherever the bytes already live, carrying the metadata
that makes the collection navigable. Uploads are the one case with nowhere to point, so they get
storage of their own.

### Goal

The primary goal of this feature is to:
1. Give every workspace **one document collection** listing everything clinical on the referral,
   whatever table the content happens to live in
2. Carry the metadata that makes a document usable: **type, source, sender, received date, protocol
   relationship, visibility**
3. Show **delivery and access evidence** — whether an outbound document was delivered, and who has
   opened it
4. Let a coordinator or guest **upload** a local document without it being transmitted by accident

### Scope

**In Scope:**
- A `workspace_documents` index table referencing existing content locations, plus uploads
- A backfill that indexes every document already in the database
- Registration hooks so new artifacts are indexed as they are created
- The document collection panel in the `#wsDocuments` slot
- A generalized content endpoint serving any indexed document, with the C-CDA viewer wired to it
- Upload, with `Shared` or `Internal` visibility and an explicit rule that upload never transmits
- Delivery evidence from the existing ack tracking, and access evidence from view logging
- Document-level visibility gating guest access

**Out of Scope:**
- Editing, versioning or co-authoring document content — the epic excludes co-authoring, and inbound
  artifacts are immutable by definition
- Folders, tags or arbitrary hierarchy — the collection is flat, ordered by received date, filterable
  by source and type
- OCR, text extraction, thumbnailing, or converting between formats
- Full-text search across documents
- Transmitting a document — attaching 360X context and sending is PRD-29
- Retention and purge policy — inherited from the deployment, noted as a production gap
- Moving existing content out of its current tables; this PRD indexes, it does not migrate

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to see every document on a referral in one list so that I stop hunting through message bodies

**AC1:** The document panel lists every document on the workspace with type, source, sender, received
date and protocol relationship.  
**AC2:** The list covers documents whose content lives in `referrals.raw_ccda_xml`,
`referral_messages`, `attachment_responses` and uploads — a coordinator cannot tell from the list
which table the bytes are in.  
**AC3:** Documents are ordered by received date, newest first, and can be filtered by source and by
type.  
**AC4:** A workspace with no documents shows an explicit empty state.

### As a care coordinator, I want to open any document without leaving the workspace so that reviewing a referral is one page

**AC5:** Any indexed C-CDA opens in the existing viewer from the document list.  
**AC6:** An HL7 or plain-text document opens as escaped monospace text, reusing the thread's content
view treatment.  
**AC7:** An uploaded binary offers a download, and the download is recorded as an access event.  
**AC8:** One content endpoint serves every indexed document, and the review page's existing
`GET /referrals/:id/ccda.xml` continues to work unchanged for backwards compatibility.

### As a care coordinator, I want to know whether the document we sent actually arrived so that I stop guessing

**AC9:** An outbound document shows delivery status derived from the existing ack tracking
(`outbound_messages.status` / `acknowledged_at`) and the PRD-29 assertion delivery status.  
**AC10:** A document recorded but not transmitted — because the party has no Direct address — is
labelled as such, distinctly from one that was sent and is awaiting acknowledgement.  
**AC11:** A document shows who has viewed it and when, separating internal viewers from guest
viewers.  
**AC12:** Technical delivery and human access are presented as two different facts, never merged into
one "seen" indicator.

### As a care coordinator, I want to add a document from my desk without it being sent anywhere, so that uploading is safe

**AC13:** An upload is stored, indexed and visible in the collection, and is never transmitted by the
act of uploading.  
**AC14:** An upload's visibility is chosen at upload time and defaults to `Internal`.  
**AC15:** A guest upload is always `Shared` and the visibility control is not offered.  
**AC16:** Transmitting an uploaded document requires attaching 360X context through PRD-29, which is a
separate, explicit action.

### As a compliance reviewer, I want document access recorded so that I can answer who read what

**AC17:** Every content fetch and every download writes an access event naming the viewer, the
document and the time.  
**AC18:** A guest can fetch only `Shared` documents belonging to their own workspace; anything else is
refused and the refusal is recorded.  
**AC19:** Access events appear in the workspace activity feed and are distinguishable from delivery
receipts.

---

## Technical Specifications

### Dependencies

- [[PRD-18 - Workspace Entity & Dual Status]] — the workspace
- [[PRD-19 - Workspace Shell]] — the `#wsDocuments` slot
- [[PRD-24 - Parties & Participants]] — sender attribution
- [[PRD-30 - Guest Participation]] — guest visibility gating
- `@kno2/ccdaview` — already mounted at `/static/ccdaview`
- `src/modules/claims/loincMapper.ts` — existing LOINC → document-type mapping, reused for labels

### Engineering Constraints

- **Index, do not copy.** A document row points at its content by `(contentSource, contentRef)`. The
  only content this PRD stores itself is an upload. A second copy of clinical content is explicitly
  out of scope and a reviewer should reject a change that introduces one.
- **Resolution is one function.** `resolveContent(document)` is the single place that knows how to
  fetch bytes for each `contentSource`. Adding a new source is a case in that function and nothing
  else.
- Registration happens where artifacts are created, through one `registerDocument()` call, so the
  index cannot drift from reality. The backfill exists for history, not as the steady-state mechanism.
- Uploads are written to a configured directory outside the repository with a generated filename;
  never trust or reuse the client filename as a path. Store the original name as metadata only.
- Every content fetch goes through an authorization check that resolves the caller's workspace and
  the document's visibility. A guest content route must not accept a document id from an arbitrary
  workspace — this is the same one-guard principle as PRD-30.
- Access logging is synchronous with the fetch, before the bytes are streamed, so a failed stream
  still leaves evidence of the attempt.
- `sha256` is computed at registration for inbound and generated content, and at write time for
  uploads. It is the integrity record for the immutability claim.
- The existing `GET /referrals/:id/ccda.xml` route stays. The review page depends on it, and breaking
  it to satisfy tidiness would be a regression for no user benefit.

### Data Models

```typescript
// src/db/schema.ts — new
export const workspaceDocuments = sqliteTable(
  'workspace_documents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),

    // Where the bytes actually live. Exactly one contentRef interpretation per source.
    contentSource: text('content_source').notNull(),
      // 'referral-ccda'        -> referrals.raw_ccda_xml (contentRef = referral id)
      // 'referral-message'     -> referral_messages.content_* (contentRef = message id)
      // 'attachment-response'  -> attachment_responses.ccda_xml (contentRef = response id)
      // 'upload'               -> uploadPath
    contentRef: integer('content_ref'),
    uploadPath: text('upload_path'),
    contentType: text('content_type').notNull(),        // 'application/xml' | 'text/plain' | ...

    // Descriptive metadata
    docType: text('doc_type').notNull(),                // 'Referral Note' | 'Consult Note' | ...
    loincCode: text('loinc_code'),
    protocolRelationship: text('protocol_relationship'), // 'referral-request' | 'final-outcome' | ...
    source: text('source').notNull(),                   // 'inbound-dsm' | 'outbound-dsm' | 'generated' | 'uploaded'
    senderPartyId: integer('sender_party_id').references(() => workspaceParties.id),
    senderAddress: text('sender_address'),
    receivedAt: integer('received_at', { mode: 'timestamp' }).notNull(),

    visibility: text('visibility').notNull().default('Internal'),   // 'Internal' | 'Shared'
    deliveryMode: text('delivery_mode'),                // 'transmitted' | 'local-only' | null (inbound)
    immutable: integer('immutable', { mode: 'boolean' }).notNull().default(true),
    sha256: text('sha256'),
    originalFilename: text('original_filename'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_documents_workspace')
      .on(table.workspaceId, table.receivedAt),
    sourceIdx: index('idx_workspace_documents_source').on(table.contentSource, table.contentRef),
  }),
);

export const documentAccessLog = sqliteTable(
  'document_access_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentId: integer('document_id').references(() => workspaceDocuments.id).notNull(),
    viewerUserId: integer('viewer_user_id').references(() => users.id),
    viewerGuestId: integer('viewer_guest_id').references(() => workspaceGuests.id),
    action: text('action').notNull(),                   // 'view' | 'download' | 'denied'
    viewedAt: integer('viewed_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({ documentIdx: index('idx_document_access_document').on(table.documentId, table.viewedAt) }),
);
```

```typescript
// src/modules/workspace/documentService.ts — new
export type ContentSource = 'referral-ccda' | 'referral-message' | 'attachment-response' | 'upload';
export type DocumentSource = 'inbound-dsm' | 'outbound-dsm' | 'generated' | 'uploaded';

export class DocumentNotFoundError extends Error {}
export class DocumentAccessDeniedError extends Error {}

export interface WorkspaceDocument {
  id: number; docType: string; loincCode: string | null;
  protocolRelationship: string | null;
  source: DocumentSource;
  senderOrgName: string | null; senderAddress: string | null;
  receivedAt: Date;
  visibility: CommentVisibility;
  contentType: string;
  deliveryMode: 'transmitted' | 'local-only' | null;
  deliveryStatus: 'Delivered' | 'Pending' | 'Failed' | 'Not-Transmitted' | null;
  deliveredAt: Date | null;
  accessCount: { internal: number; guest: number };
  lastAccessedAt: Date | null;
  sha256: string | null;
}

export async function registerDocument(input: {
  workspaceId: number;
  contentSource: ContentSource;
  contentRef?: number;
  uploadPath?: string;
  contentType: string;
  docType: string;
  loincCode?: string;
  protocolRelationship?: string;
  source: DocumentSource;
  senderPartyId?: number;
  senderAddress?: string;
  receivedAt: Date;
  visibility?: CommentVisibility;
  deliveryMode?: 'transmitted' | 'local-only';
  originalFilename?: string;
}): Promise<WorkspaceDocument>;

export async function listDocuments(
  workspaceId: number, audience: 'internal' | 'shared',
): Promise<WorkspaceDocument[]>;

/** The single place that knows how to fetch bytes for each content source. */
export async function resolveContent(
  documentId: number,
): Promise<{ contentType: string; body: string | Buffer; filename: string }>;

export async function recordAccess(
  documentId: number, viewer: { userId?: number; guestId?: number }, action: 'view' | 'download' | 'denied',
): Promise<void>;

export async function uploadDocument(input: {
  workspaceId: number;
  file: { originalName: string; contentType: string; body: Buffer };
  docType: string;
  visibility: CommentVisibility;
  uploader: { user?: ActingUser; guest?: GuestContext };
}): Promise<WorkspaceDocument>;
```

`deliveryStatus` is derived, not stored twice: for an outbound protocol message it comes from
`outbound_messages`, and for a PRD-29 artifact from `workspace_assertions.delivery_status`.

Migration: `0015_add_workspace_documents.sql`.
Config: `config.workspace.uploadDir` (default `./workspace-uploads`),
`config.workspace.maxUploadBytes`.

Backfill: `scripts/backfill-documents.ts` + `npm run backfill:documents`, following
`scripts/backfill-thread.ts`. Idempotent on `(contentSource, contentRef)`.

Audit events: `workspace.document_added`, `workspace.document_uploaded`,
`workspace.document_viewed`, `workspace.document_downloaded`, `workspace.document_access_denied`.

### API Design

**Endpoint:** `GET /api/workspaces/:id/documents`
```json
{ "documents": [ { "id": 341, "docType": "Consult Note", "loincCode": "11488-4", "protocolRelationship": "final-outcome", "source": "generated", "senderOrgName": "Lakeside Cardiology", "receivedAt": "2026-09-14T16:20:00Z", "visibility": "Shared", "contentType": "application/xml", "deliveryMode": "transmitted", "deliveryStatus": "Pending", "accessCount": { "internal": 2, "guest": 1 } } ] }
```

**Endpoint:** `GET /api/documents/:id/content` — serves the resolved bytes with the recorded content
type. Records `view` (or `download` with `?download=1`). `403` and a `denied` access record when the
caller is not entitled.

**Endpoint:** `POST /api/workspaces/:id/documents` — multipart upload
```
docType=Prior Imaging Report&visibility=Internal
```
```json
{ "success": true, "documentId": 342, "transmitted": false }
```
`transmitted` is always `false`; the field exists to make the guarantee explicit to the client.

**Endpoint:** `GET /api/documents/:id/access-log` → internal only; viewers and timestamps.

**Guest:** `GET /api/guest/documents` and `GET /api/guest/documents/:id/content` — shared-visibility
documents of the guest's own workspace only. `POST /api/guest/documents` uploads as `Shared`.

---

## Test Plan

**Unit Tests:**
- `registerDocument()` is idempotent on `(contentSource, contentRef)`
- `resolveContent()` returns the right bytes for each of the four content sources
- `resolveContent()` throws `DocumentNotFoundError` when the referenced row has vanished
- `listDocuments(_, 'shared')` returns only `Shared` documents, filtered in SQL
- `uploadDocument()` generates a safe filename, ignores the client path, stores the original name as
  metadata, and computes a sha256
- `uploadDocument()` defaults to `Internal` for a user and forces `Shared` for a guest
- `uploadDocument()` rejects a file over `maxUploadBytes`
- `deliveryStatus` derivation: outbound message pending vs acknowledged, assertion local-only,
  inbound null
- `recordAccess()` writes before content is returned

**Integration Tests:**
- Run the backfill on the seeded database and assert every pre-existing C-CDA, message body and
  attachment response is indexed exactly once
- Drive a referral through the full lifecycle and assert each generated artifact is indexed as it is
  created, with no second backfill needed
- Open a C-CDA from the collection in the viewer, and assert an access event
- Upload a document, confirm it is not transmitted, then attach 360X context via PRD-29 and confirm it
  is
- A guest lists documents and sees only shared ones; requesting an internal document id returns 403
  and writes a `denied` record

**Edge Cases:**
- Document whose underlying row is deleted — index row remains, content resolution fails cleanly, the
  list shows it as unavailable rather than crashing
- A referral message with all three content columns populated — indexed once with a defined precedence
  (xml, then hl7, then body)
- Upload with a filename containing path traversal characters — stored safely
- Upload with a mismatched content type — stored with the detected type, original claim recorded
- Zero-byte upload — rejected
- Two documents with the same sha256 — both indexed; dedupe is not in scope, and the PRD says so

**Boundary Tests:**
- An `Internal` document never appears in the guest document list or resolves through the guest
  content route
- An `Internal` document cannot be attached to a PRD-29 assertion

**Regression:**
- `GET /referrals/:id/ccda.xml` and the review page viewer are unchanged
- Claims and prior auth document flows unchanged

---

## Deliverables

- `workspace_documents`, `document_access_log` in `src/db/schema.ts` + migration
  `0015_add_workspace_documents.sql`
- `src/modules/workspace/documentService.ts`
- `registerDocument()` calls added at each artifact-creation site
- Routes listed above, including the generalized content endpoint
- Document collection panel in the `#wsDocuments` slot, reusing `.document-list` /
  `.document-item` / `.document-preview` from `claimsRequestDetail.html`
- `scripts/backfill-documents.ts` + `npm run backfill:documents`
- `config.workspace.uploadDir`, `config.workspace.maxUploadBytes`
- `tests/unit/workspace/documentService.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-19 - Workspace Shell]] — the slot
- [[PRD-29 - 360X Protocol Gateway]] — artifacts registered here, and the only path that transmits
- [[PRD-25 - Activity History & Audit]] — access events in the unified feed
- [[PRD-30 - Guest Participation]] — shared-document access
- [[PRD-10 - UI Modernization & CCDA Viewer]] — the viewer being reused
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-14  
**Version:** 1.0
