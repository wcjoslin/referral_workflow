---
up: "[[📋 PRD Index]]"
prev: "[[PRD-22 - Referral Conversation]]"
---

# PRD-23: Referral Document Collection

**Status:** Implemented  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

The clinical documents on a referral already exist in this system, but there is no such thing as *the
documents on a referral*. They are scattered across several tables with several shapes: the inbound
C-CDA sits in `referrals.raw_ccda_xml` *and* in `referral_messages.content_xml`; protocol message
bodies sit in `referral_messages.content_xml`, `content_hl7` and `content_body`; claims attachment
responses sit in `attachment_responses.ccda_xml`; prior authorization bundles and payer decisions sit
in `prior_auth_requests.bundle_json` and `prior_auth_responses.response_json`. The only document
surface in the UI is the single inbound C-CDA rendered in the review page's right-hand pane, reached
by a purpose-built route (`GET /referrals/:id/ccda.xml`) that exists to feed that one viewer.

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
   relationship, scope, visibility**
3. Show **delivery and access evidence** — whether an outbound document was delivered, and who has
   opened it — as two separate facts
4. Let a coordinator or guest **upload** a local document without it being transmitted by accident

### Scope

**In Scope:**
- A `workspace_documents` index table referencing existing content locations, plus uploads
- Six content sources: protocol messages, the legacy referral C-CDA, claims attachment responses,
  prior-auth bundles, prior-auth responses, and uploads
- A backfill that indexes every document already in the database, idempotent per row
- One registration hook, in `recordThreadMessage()`, so new protocol artifacts index themselves
- The document collection panel in the `#wsDocuments` slot
- A generalized content endpoint serving any indexed document, and a document-keyed viewer frame
- Upload by raw request body, with magic-byte type detection and an explicit never-transmits rule
- Delivery evidence derived from existing ack tracking; access evidence from view logging
- Two independent guest gates: document visibility, and document scope

**Out of Scope:**
- Editing, versioning or co-authoring document content — the epic excludes co-authoring, and inbound
  artifacts are immutable by definition
- Folders, tags or arbitrary hierarchy — the collection is flat, ordered by received date, filterable
  by source and type
- OCR, text extraction, thumbnailing, or converting between formats
- Full-text search across documents
- De-duplication. Two documents with the same `sha256` are both indexed; see the note below.
- Transmitting a document — attaching 360X context and sending is PRD-29
- Retention and purge policy — inherited from the deployment, recorded as a production gap
- Moving existing content out of its current tables; this PRD indexes, it does not migrate
- Multi-file upload in one request, and upload progress events — see the upload transport decision

---

## What the collection actually contains

Six content sources, because the bytes genuinely live in six places. `resolveContent()` is the one
function that knows how to fetch each, and adding a seventh is a case there and nothing else.

| `contentSource` | `contentRef` | Bytes | `scope` | `source` |
|---|---|---|---|---|
| `referral-message` | `referral_messages.id` | `content_xml` ?? `content_hl7` ?? `content_body` | referral | from the row's direction |
| `referral-ccda` | `referrals.id` | `raw_ccda_xml` | referral | `inbound-dsm` |
| `attachment-response` | `attachment_responses.id` | `ccda_xml` | **patient** | `payer-outbound` |
| `prior-auth-request` | `prior_auth_requests.id` | `bundle_json` ?? `claim_json` | referral | `payer-outbound` |
| `prior-auth-response` | `prior_auth_responses.id` | `response_json` | referral | `payer-inbound` |
| `upload` | null — `upload_path` instead | file on disk | referral | `uploaded` |

`referral-ccda` is a **legacy fallback, not the primary path.** The live ingest already records the
inbound C-CDA into the thread (`referralService.ts:139-147`) with the same bytes, and
`backfill-thread.ts:33` did the same for history, so a `referral-message` row normally covers it.
This source exists only for a referral whose `raw_ccda_xml` has no corresponding `ReferralCCDA`
thread row — possible on a database where the thread backfill was skipped because the table already
had rows. The document backfill detects that case and indexes it; nothing else ever writes this
source.

### Scope is not visibility, and both gate a guest

`attachment_responses` has **no path to a referral**. The chain is
`attachment_responses → attachment_requests → patients`, and `attachment_requests` links to
`patients`, not `referrals`. A claims attachment belongs to a patient and was produced for a payer's
claim, which may concern a different episode of care entirely. Indexing it against a referral is
therefore a *patient-level* association, and a patient with three referrals will see the same
attachment on all three.

That is a deliberate decision, taken knowing the consequence, so the consequence is made visible
rather than hidden: every document carries `scope`, which is `'referral'` for everything with a real
referral link and `'patient'` for claims attachments alone. The panel labels patient-scoped documents
as such, so a coordinator is never told a payer document came from this referral.

**A patient-scoped document is excluded from the guest list unconditionally, independent of its
visibility.** Two independent gates, not one. A payer's attachment about another episode must not
become visible to a referring office because somebody toggled a flag, and a single `visibility`
check would make that one mistake away.

### Visibility is derived from direction

A document that has already crossed the wire to a party is `Shared`, because calling it internal is a
fiction — they have it. Everything else is `Internal`.

```
inbound-dsm   → Shared     the party sent it to us
outbound-dsm  → Shared     we sent it to the party
generated     → Internal   produced here, never transmitted (a local-only assertion artifact)
payer-outbound → Internal  a payer is not a party on this workspace
payer-inbound  → Internal  likewise
uploaded      → Internal   the default; chosen at upload time
```

"Inbound" and "outbound" mean **from or to a party on this workspace**. Payer traffic is neither, so
prior-auth bundles and claims attachments are `Internal` despite being outbound in the everyday
sense — stated because the naive reading of "outbound" would share them.

`Shared` is binary, as PRD-22 established: shared with every guest on the workspace, not per-party.

---

## Refinement decisions

| # | Decision | Effect |
|---|---|---|
| 1 | **Upload by raw request body**, not multipart | No new dependency. `express.raw()` is per-route, so the size cap does not touch any other endpoint, and a `Buffer` lets the server detect the real type from magic bytes instead of trusting the client's declared one. |
| 2 | **Index everything, claims by patient** | Six content sources. Claims attachments are included despite having no referral link, carried as `scope: 'patient'` and gated twice for guests. |
| 3 | **Visibility derived from direction** | A document the other side already has is `Shared`; anything they have never seen is `Internal`. |

### The upload transport, and what it costs

`express.json()` (`server.ts:196`) is type-scoped to `application/json` and `application/fhir+json`,
so it does not consume a PDF, JPEG, PNG or XML body. `express.raw({ limit })` mounted on the upload
route alone enforces `maxUploadBytes` as the body arrives.

Three consequences, recorded so nobody rediscovers them:

- **Filenames must be `encodeURIComponent()`-ed by the client and decoded by the server.** HTTP header
  values are latin-1; an unencoded accented or CJK filename either throws in `fetch` or arrives
  mangled.
- **The whole file buffers in memory** before the handler runs, bounded by `maxUploadBytes`. Fine for
  documents and images. If imaging-scale files are ever needed, that is the point to reach for a
  streaming multipart parser, and this note is the trigger.
- **No multi-file request, and no progress events.** A client wanting several files issues one request
  each, which gives per-file progress and per-file failure anyway.

Accepted types are allow-listed **by magic bytes**, not by the declared content type: PDF (`%PDF-`),
JPEG (`FF D8 FF`), PNG (`89 50 4E 47`) and XML (a leading `<` after optional BOM and whitespace). PNG
is included alongside JPEG deliberately — a coordinator pasting a screenshot produces one, and an
unexplained rejection is a worse outcome than one extra entry in the list. The client's declared type
is stored separately as `claimedContentType` when it disagrees with the detected one.

### What the codebase pass changed

Facts the draft got wrong or missed, all verified against the working tree:

1. **`attachment_responses` cannot reach a referral.** See above. The draft's AC2 asserted the
   collection covers it as though the link existed.
2. **`prior_auth_requests` *does* carry `referralId`** (nullable). The draft named prior-auth bundles
   in its context paragraph and then omitted them from AC2 — exactly backwards from what the schema
   supports.
3. **The inbound C-CDA is already in the thread.** `referralService.ts:139-147` writes it to
   `referral_messages.content_xml`, the same bytes as `referrals.raw_ccda_xml`. The draft treated
   `referral-ccda` as a primary source; it is a legacy fallback.
4. **There is exactly ONE insert site for `referral_messages`.** `recordThreadMessage()`
   (`threadService.ts:38`), called by eleven services. PRD-24 already hooked party-address
   observation there, fire-and-forget, with a comment calling it "the funnel every one of the nine
   messaging services already calls". So registration is one hook — not "`registerDocument()` calls
   added at each artifact-creation site", as the draft's deliverables said.
5. **No multipart parser exists** in the dependency tree. Hence decision 1.
6. **`loincMapper.ts` moved.** It is `src/modules/claims/intake/loincMapper.ts`; the claims module is
   now `document/`, `intake/`, `response/`, `review/`. Its exports are `getDocumentTypeForLoinc`,
   `isRecognizedLoinc` and `getAllRecognizedLoincCodes` — there is no helper that labels a
   non-LOINC document, so `docType` for a protocol message comes from `referral_messages.messageType`
   through a local label map.
7. **The C-CDA viewer is hard-wired to a referral id.** `/referrals/:id/ccda-frame` reads
   `referrals.raw_ccda_xml` directly and the frame it renders fetches `/referrals/:id/ccda.xml`.
   Opening an arbitrary indexed C-CDA needs a document-keyed frame route; the existing pair stays
   untouched, because the review page depends on it.
8. **`.document-list` / `.document-item` / `.document-preview` exist** in
   `claimsRequestDetail.html:65-77`, but every view carries its own `<style>` block and there is no
   shared stylesheet. "Reuse" means copying the treatment, the way PRD-30's guest view did on
   purpose.
9. **`backfill-thread.ts` is not row-idempotent.** It short-circuits when `referral_messages` has any
   rows at all. This PRD's backfill must be idempotent on `(contentSource, contentRef)` as specified
   — stricter than the script it says it follows, and the reason a unique index enforces it rather
   than a check-then-insert.
10. **Migration is `0017`**, not the draft's `0015` — `0015` went to PRD-29 and `0016` to PRD-22.
11. **`#wsDocuments` is in the side column** (`workspaceDetail.html:397`), above `wsCcdaPanel`. That
    is correct for reference material and is left where it is; PRD-21 and PRD-24 moved their panels
    to the main column because they turned out to be action surfaces, and a document list is not.

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to see every document on a referral in one list so that I stop hunting through message bodies

**AC1:** The document panel lists every document on the workspace with type, source, sender, received
date, protocol relationship and scope.  
**AC2:** The list covers all six content sources, and a coordinator cannot tell from the list which
table the bytes are in.  
**AC3:** Documents are ordered by received date, newest first, and can be filtered by source and by
type.  
**AC4:** A workspace with no documents shows an explicit empty state.  
**AC5:** A patient-scoped document is labelled as patient-level, so it is never mistaken for
something that arrived on this referral.

### As a care coordinator, I want to open any document without leaving the workspace so that reviewing a referral is one page

**AC6:** Any indexed C-CDA opens in the existing viewer from the document list, through a
document-keyed frame route.  
**AC7:** An HL7, JSON or plain-text document opens as escaped monospace text.  
**AC8:** An uploaded binary offers a download, and the download is recorded as an access event
distinct from a view.  
**AC9:** One content endpoint serves every indexed document, and the review page's existing
`GET /referrals/:id/ccda.xml` and `/referrals/:id/ccda-frame` continue to work unchanged.  
**AC10:** A document whose underlying row has vanished resolves to a clean "content unavailable"
rather than an exception, and the list still shows the index entry.

### As a care coordinator, I want to know whether the document we sent actually arrived so that I stop guessing

**AC11:** An outbound document shows delivery status derived from existing records, in this
precedence: the PRD-29 assertion's `delivery_status` when the message is an assertion artifact, then
`referral_messages.ack_status` / `ack_at`, then `outbound_messages.status` / `acknowledged_at`.  
**AC12:** A document recorded but not transmitted — because the party has no Direct address — is
labelled `Not-Transmitted`, distinctly from one that was sent and is awaiting acknowledgement.  
**AC13:** An inbound document has no delivery status at all, rather than a misleading one.  
**AC14:** A document shows who has viewed it and when, separating internal viewers from guest
viewers.  
**AC15:** Technical delivery and human access are presented as two different facts, never merged into
one "seen" indicator.

### As a care coordinator, I want to add a document from my desk without it being sent anywhere, so that uploading is safe

**AC16:** An upload is stored, indexed and visible in the collection, and is never transmitted by the
act of uploading. The response says so explicitly.  
**AC17:** An upload's visibility is chosen at upload time and defaults to `Internal`.  
**AC18:** A guest upload is always `Shared` and the visibility control is not offered; a supplied
value other than `Shared` is refused rather than coerced.  
**AC19:** The stored type is detected from the file's magic bytes; a mismatched declared type is
recorded alongside rather than trusted.  
**AC20:** A file whose magic bytes match nothing on the allow-list is rejected, as is a zero-byte
upload and one over `maxUploadBytes`.  
**AC21:** The client's filename is never used as a path. Storage uses a generated name; the original
is metadata only, and a traversal attempt is stored safely.  
**AC22:** Transmitting an uploaded document requires attaching 360X context through PRD-29, which is
a separate, explicit action.

### As a compliance reviewer, I want document access recorded so that I can answer who read what

**AC23:** Every content fetch and every download writes an access event naming the viewer, the
document and the time, **before** the bytes are streamed, so a failed stream still leaves evidence of
the attempt.  
**AC24:** A guest can fetch only `Shared`, referral-scoped documents of their own workspace.
Anything else is refused and the refusal is recorded as a `denied` access event.  
**AC25:** An internal comment on visibility cannot widen guest access: a patient-scoped document
marked `Shared` is still refused.  
**AC26:** Access events are emitted as workflow events for PRD-25's feed, distinguishable from
delivery receipts.

### As an engineer, I want the index to stay true so that the collection is trustworthy

**AC27:** `registerDocument()` is idempotent on `(contentSource, contentRef)`, enforced by a unique
index rather than a check-then-insert.  
**AC28:** A protocol message recorded through `recordThreadMessage()` is indexed without the calling
service knowing documents exist.  
**AC29:** The backfill indexes every pre-existing document exactly once and is safe to re-run.  
**AC30:** A `referral_messages` row with several content columns populated is indexed once, with
precedence `content_xml`, then `content_hl7`, then `content_body`.  
**AC31:** A message row with no content at all is not indexed — a thread entry is not a document.

---

## Technical Specifications

### Dependencies

- [[PRD-18 - Workspace Entity & Dual Status]] — the workspace
- [[PRD-19 - Workspace Shell]] — the `#wsDocuments` slot
- [[PRD-22 - Referral Conversation]] — the `CommentVisibility` type, reused rather than redefined
- [[PRD-24 - Parties & Participants]] — sender attribution
- [[PRD-29 - 360X Protocol Gateway]] — assertion delivery status, and the only path that transmits
- [[PRD-30 - Guest Participation]] — guest visibility gating
- `@kno2/ccdaview` — already mounted at `/static/ccdaview`
- `src/modules/claims/intake/loincMapper.ts` — existing LOINC → document-type mapping

### Engineering Constraints

- **Index, do not copy.** A document row points at its content by `(contentSource, contentRef)`. The
  only content this PRD stores itself is an upload. A reviewer should reject a change that introduces
  a second copy of clinical content.
- **Resolution is one function.** `resolveContent(document)` is the single place that knows how to
  fetch bytes for each `contentSource`. Adding a source is a case there and nothing else.
- **Registration is one hook.** `recordThreadMessage()` calls `registerDocument()`, following PRD-24's
  precedent in the same function: fire-and-forget, so document bookkeeping can never fail the thread
  write that triggered it. The cost is that a failed index write silently omits a document until the
  backfill runs; the backfill is idempotent precisely so that recovery is a no-op re-run.
- **Two independent guest gates.** Visibility AND scope. Neither implies the other and both are
  checked in the same guard, which is the one-guard principle PRD-30 established.
- **Access logging precedes the bytes.** The write is awaited before the response is sent.
- Uploads go to `config.workspace.uploadDir`, outside the repository, under a generated filename.
  The client filename is never a path component.
- `sha256` is computed at registration for indexed content and at write time for uploads. It is the
  integrity record behind the immutability claim. **De-duplication is out of scope** and two
  documents with the same hash are both indexed — a coordinator who uploads the same PDF twice has
  done something they can see and undo, and silently collapsing the second would be worse.
- The existing `GET /referrals/:id/ccda.xml` and `/referrals/:id/ccda-frame` routes stay. The review
  page depends on them, and breaking them for tidiness would be a regression for no user benefit.

### Data Models

```typescript
// src/db/schema.ts — new
export const workspaceDocuments = sqliteTable(
  'workspace_documents',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),

    contentSource: text('content_source').notNull(),
    contentRef: integer('content_ref'),        // null only for 'upload'
    uploadPath: text('upload_path'),           // set only for 'upload'
    contentType: text('content_type').notNull(),
    claimedContentType: text('claimed_content_type'), // upload only, when it disagreed

    docType: text('doc_type').notNull(),
    loincCode: text('loinc_code'),
    protocolRelationship: text('protocol_relationship'),
    source: text('source').notNull(),
    // 'inbound-dsm' | 'outbound-dsm' | 'generated' | 'uploaded'
    //   | 'payer-outbound' | 'payer-inbound'
    scope: text('scope').notNull().default('referral'),   // 'referral' | 'patient'
    senderPartyId: integer('sender_party_id').references(() => workspaceParties.id),
    senderAddress: text('sender_address'),
    receivedAt: integer('received_at', { mode: 'timestamp' }).notNull(),

    visibility: text('visibility').notNull().default('Internal'),
    deliveryMode: text('delivery_mode'),       // 'transmitted' | 'local-only' | null (inbound)
    immutable: integer('immutable', { mode: 'boolean' }).notNull().default(true),
    sha256: text('sha256'),
    originalFilename: text('original_filename'),
    uploadedByUserId: integer('uploaded_by_user_id').references(() => users.id),
    uploadedByGuestId: integer('uploaded_by_guest_id').references(() => workspaceGuests.id),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_documents_workspace')
      .on(table.workspaceId, table.receivedAt),
    // AC27: idempotency is a database guarantee, not a check-then-insert. An
    // upload has a null contentRef and SQLite treats NULLs as distinct, so
    // every upload is its own row — which is what we want.
    sourceIdx: uniqueIndex('idx_workspace_documents_source')
      .on(table.workspaceId, table.contentSource, table.contentRef),
  }),
);

export const documentAccessLog = sqliteTable(
  'document_access_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    documentId: integer('document_id').references(() => workspaceDocuments.id).notNull(),
    viewerUserId: integer('viewer_user_id').references(() => users.id),
    viewerGuestId: integer('viewer_guest_id').references(() => workspaceGuests.id),
    action: text('action').notNull(),          // 'view' | 'download' | 'denied'
    reason: text('reason'),                    // why, on a 'denied'
    viewedAt: integer('viewed_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    documentIdx: index('idx_document_access_document').on(table.documentId, table.viewedAt),
  }),
);
```

The viewer union is deliberately NOT a check constraint, unlike PRD-22's author union: a `denied`
record may legitimately have neither viewer set, because a request with no resolvable identity is
exactly the kind of attempt worth recording.

```typescript
// src/modules/workspace/documentService.ts — new
export type ContentSource =
  | 'referral-message' | 'referral-ccda' | 'attachment-response'
  | 'prior-auth-request' | 'prior-auth-response' | 'upload';
export type DocumentSource =
  | 'inbound-dsm' | 'outbound-dsm' | 'generated' | 'uploaded'
  | 'payer-outbound' | 'payer-inbound';
export type DocumentScope = 'referral' | 'patient';
export type DeliveryStatus = 'Delivered' | 'Pending' | 'Failed' | 'Not-Transmitted';

export class DocumentNotFoundError extends Error {}
export class DocumentAccessDeniedError extends Error {}
export class DocumentContentUnavailableError extends Error {}
export class UploadTooLargeError extends Error {}
export class UploadEmptyError extends Error {}
export class UploadTypeNotAllowedError extends Error {}
export class GuestUploadVisibilityError extends Error {}

export interface WorkspaceDocument {
  id: number;
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
  /** How the document opens: the viewer, escaped text, or a download. */
  renderAs: 'ccda' | 'text' | 'download';
  deliveryMode: 'transmitted' | 'local-only' | null;
  deliveryStatus: DeliveryStatus | null;
  deliveredAt: Date | null;
  accessCount: { internal: number; guest: number };
  lastAccessedAt: Date | null;
  originalFilename: string | null;
  sha256: string | null;
}

/** What a guest receives. Narrower, with its own exported key allow-list. */
export interface GuestSharedDocument {
  id: number;
  docType: string;
  senderOrgName: string | null;
  receivedAt: string;
  contentType: string;
  renderAs: 'ccda' | 'text' | 'download';
  originalFilename: string | null;
  own: boolean;
}
export const GUEST_DOCUMENT_KEYS: readonly string[];

export async function registerDocument(input: { /* … */ }): Promise<WorkspaceDocument | null>;
export async function listDocuments(workspaceId: number): Promise<WorkspaceDocument[]>;
export async function listSharedDocuments(
  workspaceId: number, viewerGuestId: number,
): Promise<GuestSharedDocument[]>;
export async function getDocument(documentId: number): Promise<WorkspaceDocument>;

/** The single place that knows how to fetch bytes for each content source. */
export async function resolveContent(
  documentId: number,
): Promise<{ contentType: string; body: string | Buffer; filename: string }>;

export async function recordAccess(
  documentId: number,
  viewer: { userId?: number; guestId?: number },
  action: 'view' | 'download' | 'denied',
  reason?: string,
): Promise<void>;

export async function uploadDocument(input: {
  workspaceId: number;
  body: Buffer;
  claimedContentType: string | null;
  originalFilename: string;
  docType?: string;
  visibility?: CommentVisibility;
  uploader: { kind: 'user'; user: ActingUser } | { kind: 'guest'; guest: GuestContext };
}): Promise<WorkspaceDocument>;

/** The guest guard: visibility AND scope, in one place. */
export async function assertGuestMayRead(
  documentId: number, guest: GuestContext,
): Promise<WorkspaceDocument>;
```

`registerThreadDocument()` returns `null` — not a document — when there is nothing to index, which is
how AC31's "a thread entry with no content is not a document" is expressed without the caller
deciding. `registerDocument()` itself never returns null: it indexes, returns the row that is already
there, or throws.

`deliveryStatus` is derived, never stored twice. Migration: `0017`.
Config: `config.workspace.uploadDir` (default `./workspace-uploads`),
`config.workspace.maxUploadBytes` (default 20 MB).

Backfill: `scripts/backfill-documents.ts` + `npm run backfill:documents`, idempotent on
`(workspaceId, contentSource, contentRef)` by relying on the unique index.

Audit events: `workspace.document_indexed`, `workspace.document_uploaded`,
`workspace.document_viewed`, `workspace.document_downloaded`, `workspace.document_access_denied`.

### API Design

**`GET /api/workspaces/:id/documents`**
```json
{ "documents": [ { "id": 341, "docType": "Consult Note", "loincCode": "11488-4",
  "protocolRelationship": "final-outcome", "source": "outbound-dsm", "scope": "referral",
  "senderOrgName": "Specialist Care Group", "receivedAt": "2026-09-14T16:20:00Z",
  "visibility": "Shared", "contentType": "application/xml", "renderAs": "ccda",
  "deliveryMode": "transmitted", "deliveryStatus": "Pending",
  "accessCount": { "internal": 2, "guest": 1 } } ] }
```

**`GET /api/documents/:id/content`** — the resolved bytes with the recorded content type. Records
`view`, or `download` with `?download=1`. `403` plus a `denied` record when the caller is not
entitled; `410` when the index entry survives but its content has vanished.

**`GET /documents/:id/ccda-frame`** — the document-keyed viewer frame. The existing
`/referrals/:id/ccda-frame` is untouched.

**`POST /api/workspaces/:id/documents`** — raw body upload.
```
Content-Type: application/pdf
X-Document-Filename: Prior%20imaging%20report.pdf
X-Document-Type: Prior Imaging Report
X-Document-Visibility: Internal
```
```json
{ "success": true, "documentId": 342, "transmitted": false, "detectedContentType": "application/pdf" }
```
`transmitted` is always `false`; the field exists to make the guarantee explicit to the client.

**`GET /api/documents/:id/access-log`** → internal only; viewers, actions and timestamps.

**Guest:** `GET /api/guest/documents`, `GET /api/guest/documents/:id/content`,
`POST /api/guest/documents` (always `Shared`). All three go through `assertGuestMayRead()` or its
upload equivalent; the workspace comes from the session, never the request.

---

## Test Plan

**Unit Tests:**
- `registerDocument()` is idempotent on `(workspaceId, contentSource, contentRef)`, by the index
- `registerDocument()` returns null for a message row with no content in any column
- `registerDocument()` picks content precedence xml → hl7 → body, and reports the right `renderAs`
- `registerDocument()` derives visibility from direction for all six sources
- `registerDocument()` marks only `attachment-response` as `scope: 'patient'`
- `resolveContent()` returns the right bytes for each of the six sources
- `resolveContent()` throws `DocumentContentUnavailableError` when the referenced row has vanished
- `listSharedDocuments()` excludes internal documents and patient-scoped documents, in SQL
- `assertGuestMayRead()` refuses another workspace's document, an internal one, and a patient-scoped
  one that has been marked `Shared`
- `uploadDocument()` detects PDF, JPEG, PNG and XML from magic bytes and rejects everything else
- `uploadDocument()` records a mismatched declared type instead of trusting it
- `uploadDocument()` generates a safe filename, ignores a traversal attempt, keeps the original as
  metadata, and computes a sha256
- `uploadDocument()` defaults to `Internal` for a user, forces `Shared` for a guest, and refuses a
  guest-supplied value other than `Shared`
- `uploadDocument()` rejects a zero-byte file and one over `maxUploadBytes`
- Delivery status precedence: assertion status, then message ack, then outbound message; inbound null;
  local-only reports `Not-Transmitted`
- `recordAccess()` is awaited before content is returned, including on the `denied` path

**Integration Tests:**
- Run the backfill on a seeded database and assert every pre-existing document is indexed exactly
  once; re-run it and assert the counts are unchanged
- Drive a referral through the full lifecycle and assert each artifact is indexed as it is created,
  with no backfill needed
- Upload a PDF, confirm `transmitted: false` and that nothing was sent, then attach 360X context via
  PRD-29 and confirm the artifact is a separate indexed document
- A guest lists documents, sees only shared referral-scoped ones, and gets 403 plus a `denied` record
  for an internal id and for a patient-scoped id

**Edge Cases:**
- Underlying row deleted — the index entry remains and the list shows it unavailable
- A referral whose `raw_ccda_xml` has no thread row — indexed via the `referral-ccda` fallback exactly
  once, and not double-indexed when the thread row exists
- Upload filename with path traversal characters, and with non-ASCII characters
- Two uploads with identical bytes — both indexed, no dedupe
- A patient with two referrals and one claims attachment — indexed against both, labelled
  patient-level on both

**Boundary Tests:**
- An internal document never appears in `buildGuestPayload()` output
- A patient-scoped document never appears there either, whatever its visibility
- The guest document shape matches `GUEST_DOCUMENT_KEYS` exactly

**Smoke Check (what unit tests cannot catch):**
- The document panel renders in `#wsDocuments` with its filters and both evidence columns
- A hostile filename and a hostile docType arrive escaped in the internal page and the guest page
- An upload round-trips through the real route and the bytes come back byte-identical
- The guest page carries a shared document and not an internal or patient-scoped one

**Regression:**
- `GET /referrals/:id/ccda.xml`, `/referrals/:id/ccda-frame` and the review page viewer unchanged
- Claims and prior-auth flows unchanged — this PRD reads their tables and writes to neither
- `slots.documents` flips to `true` and the PRD-23 placeholder stops rendering

---

## Deliverables

- `workspace_documents`, `document_access_log` in `src/db/schema.ts` + migration `0017`
- `src/modules/workspace/documentService.ts`
- One `registerDocument()` hook in `recordThreadMessage()`
- The routes listed above, including the generalized content endpoint and the document-keyed frame
- Document collection panel in the `#wsDocuments` slot, and the guest document section
- `scripts/backfill-documents.ts` + `npm run backfill:documents`
- `config.workspace.uploadDir`, `config.workspace.maxUploadBytes`
- `tests/unit/workspace/documentService.test.ts` and smoke-check additions

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-19 - Workspace Shell]] — the slot
- [[PRD-22 - Referral Conversation]] — the visibility type and the guest allow-list idiom
- [[PRD-29 - 360X Protocol Gateway]] — artifacts indexed here, and the only path that transmits
- [[PRD-25 - Activity History & Audit]] — access events in the unified feed
- [[PRD-30 - Guest Participation]] — shared-document access
- [[PRD-10 - UI Modernization & CCDA Viewer]] — the viewer being reused
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-16  
**Version:** 1.1 — Refined to implementation-ready. Three decisions taken: upload by raw request body
rather than adding a multipart dependency, index every source including claims attachments, and
derive visibility from direction. Eleven codebase findings recorded above; the two that changed the
design most:

- **`attachment_responses` has no path to a referral.** The chain is
  `attachment_responses → attachment_requests → patients`, and `attachment_requests` links to
  patients. The draft asserted the collection covers claims attachments as though a referral link
  existed. Indexing them was chosen anyway, so the association is carried honestly as
  `scope: 'patient'` and gated twice for guests rather than once.
- **The inbound C-CDA is already in the thread, and the thread has one insert site.** The draft
  treated `referrals.raw_ccda_xml` as a primary content source and spread `registerDocument()` calls
  across every artifact-creation site. In fact `recordThreadMessage()` is the single funnel eleven
  services already call — PRD-24 hooked it for the same reason — so registration is one hook and
  `referral-ccda` is a legacy fallback for a database whose thread backfill was skipped.

**Version:** 1.2 — Implemented. Built as specified at v1.1, with 846 tests across 46 suites and
179 smoke checks green. Four things implementation settled, the first only because the smoke check
caught it:

- **The content route recorded access AFTER resolving it, so a failed read left no evidence.**
  AC23 requires the record before the bytes, and the route had `resolveContent()` first. A document
  whose underlying row had vanished therefore answered `410` and logged nothing — the one case an
  auditor most wants to see. Now: confirm the document exists (so the access row has a real foreign
  key), record the attempt, then resolve. Both the internal and guest content routes.
- **Registration is chained after the address observation, not parallel with it.**
  `registerThreadDocument()` attributes a document by resolving its sender through
  `findPartyByDirectAddress()`, so running both fire-and-forget hooks concurrently would index the
  first message from a new departmental address with no sender party. The ordering is load-bearing
  and the comment in `recordThreadMessage()` says so.
- **The C-CDA frame is parameterised by URL, not duplicated.** `ccdaFrame.html` now derives its
  URL from an explicit `url` when given one and from `referralId` otherwise, so PRD-10's review-page
  route is untouched while the document and guest frames serve any indexed document. A smoke check
  asserts the legacy route still derives its own URL.
- **`registerDocument()` does not return null.** The signature said it might; it cannot. It indexes,
  returns the row already there, or throws. Only `registerThreadDocument()` has a nothing-to-index
  case, and a signature advertising a null the function never produces is a cost every caller pays.
