# Plan: X12N Claims Attachment Workflow (CMS-0053-F)

## Context

The existing project handles the 360X referral lifecycle (IMAP ingest → C-CDA parse → clinician review → scheduling → encounter → consult note). This plan extends the project with a **second, independent workflow** for healthcare claims attachments under CMS-0053-F.

A payer sends a **X12N 277** (Health Care Claim Request for Additional Information) asking the provider for supporting clinical documentation. The provider's system queries FHIR for the patient's data, builds a **C-CDA document** matched to the LOINC-coded request type, a clinician click-signs it, and it goes back as a **X12N 275** (Patient Information) response.

Key implementation decisions:
- **Transport**: File watcher on a configurable directory for inbound `.edi` files; outbound 275 written to an outbound directory
- **E-signature**: Click-to-sign (name + NPI + timestamp embedded as `legalAuthenticator` in the C-CDA)
- **X12 parsing/building**: Hand-written parsers for X12 (X12 is structurally more complex than the hand-built HL7 V2 used elsewhere)
- **Organization**: New `src/modules/claims/` subtree — separate from PRD modules

---

## Phase 1 — DB Schema & State Machine

### New State Machine: `src/state/claimsStateMachine.ts`

```
Received → Processing → Pending-Signature → Sent
```

- **Received**: 277 file parsed and record created
- **Processing**: FHIR query + C-CDA build in progress
- **Pending-Signature**: Documents ready, awaiting provider click-to-sign
- **Sent**: 275 written to outbound dir

Terminal state: `Sent`

Follow the exact pattern in `src/state/referralStateMachine.ts` — `ClaimsAttachmentState` const enum, `VALID_TRANSITIONS` map, `transition()` function, `InvalidClaimsStateTransitionError`.

### New DB Tables: add to `src/db/schema.ts`

**`attachment_requests`**
- `id` — integer PK autoincrement
- `patientId` — FK → `patients.id` (nullable until patient matched)
- `controlNumber` — text unique (277 ISA13 interchange control)
- `claimNumber` — text (from 277 claim reference)
- `payerName` — text
- `payerIdentifier` — text (payer ID from 277 NM1 loop)
- `subscriberName` — text (patient name as provided by payer)
- `subscriberId` — text (member/subscriber ID)
- `subscriberDob` — text (ISO 8601, used for FHIR patient match)
- `requestedLoincCodes` — text (JSON array of LOINC strings)
- `sourceFile` — text (original .edi filename)
- `state` — text default 'Received'
- `createdAt` — integer timestamp
- `updatedAt` — integer timestamp

**`attachment_responses`**
- `id` — integer PK autoincrement
- `requestId` — FK → `attachment_requests.id`
- `loincCode` — text (one response per LOINC code requested)
- `ccdaDocumentType` — text (human label, e.g., "History and Physical")
- `ccdaXml` — text (generated C-CDA document)
- `fhirData` — text (JSON — FHIR query results used to build C-CDA)
- `signedByName` — text nullable
- `signedByNpi` — text nullable
- `signedAt` — integer timestamp nullable
- `sentAt` — integer timestamp nullable
- `x12ControlNumber` — text nullable (275 ISA control number assigned at send time)

After schema changes: `npm run db:generate && npm run db:migrate`

---

## Phase 2 — 277 Intake

### Module: `src/modules/claims/intake/`

**`ediWatcher.ts`** — watches `config.claimsWatchDir` for new `.edi` files using `chokidar` for cross-platform reliability. On file creation: read file, pass to parser, then move to processed subdir.

**`x12_277Parser.ts`** — parses the 277 transaction set and extracts:
- ISA13 → `controlNumber`
- NM1 loop (Loop 2100A, entity qualifier `PR`) → `payerName`, `payerIdentifier`
- NM1 loop (subscriber/patient level) → `subscriberName`, `subscriberId`, `subscriberDob`
- Claim reference (CLM or REF segment) → `claimNumber`
- STC segments → `requestedLoincCodes` (LOINC codes identifying document types needed)

**`requestService.ts`** — ingests parsed 277 data:
1. Create `attachment_requests` record with state `Received`
2. Attempt FHIR patient match using `subscriberName` + `subscriberDob` (reuse `fhirClient.ts` from `src/modules/prd08/fhirClient.ts`)
3. If matched, set `patientId`; if not, set `patientId = null` (will need manual resolution)
4. Transition state: `Received → Processing`
5. Kick off document build (background, fire-and-forget)

### Config additions (`src/config.ts`)
- `CLAIMS_WATCH_DIR` — directory to watch for inbound 277 `.edi` files (default: `./claims-inbox`)
- `CLAIMS_OUTBOUND_DIR` — directory to write outbound 275 `.edi` files (default: `./claims-outbox`)

### LOINC Mapper: `src/modules/claims/intake/loincMapper.ts`

Core mapping artifact — LOINC code → document type label + required FHIR resource types:

| LOINC | C-CDA Type | FHIR Resources |
|-------|-----------|---------------|
| 34117-2 | History and Physical | Conditions, Medications, AllergyIntolerances, Encounters |
| 11488-4 | Consultation Note | Conditions, Medications, Encounters, Observations |
| 11506-3 | Progress Note | Conditions, Medications, Observations (recent) |
| 18842-5 | Discharge Summary | Encounters, Conditions, Medications, Procedures |
| 34101-6 | Outpatient Consult Note | Conditions, Medications, Encounters |

Export: `getDocumentTypeForLoinc(code: string): { label: string; fhirResources: string[] } | null`

---

## Phase 3 — Document Build

### Module: `src/modules/claims/document/`

**`claimsDocumentService.ts`** — orchestrates the full build for a request:
1. Load `attachment_request` from DB
2. For each LOINC code in `requestedLoincCodes`:
   a. Look up document type and FHIR resources via `loincMapper.ts`
   b. Query FHIR (reuse `fhirClient.ts` patterns from prd08) for the patient's data
   c. Call `claimsCcdaBuilder.ts` to assemble the C-CDA
   d. Insert `attachment_responses` record with state `Draft`
3. Transition `attachment_request` state: `Processing → Pending-Signature`

**`claimsCcdaBuilder.ts`** — builds a C-CDA document from FHIR data + LOINC type context.
- Different from `src/modules/prd04/ccdaBuilder.ts` (which is consult-note-specific)
- Uses `xmlbuilder2` (already a dependency) to produce valid C-CDA R2.1 XML
- Includes `<code>` element with the request LOINC code (identifies document type per CMS-0053-F)
- Includes placeholder `<legalAuthenticator>` block (filled in at sign time)
- Sections included vary by LOINC type (from mapper)

---

## Phase 4 — Review UI & E-Signature

### New Express routes in `src/server.ts`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/claims` | Claims attachment queue (all requests) |
| GET | `/claims/:id` | Request detail — patient info, LOINC docs, C-CDA preview, sign button |
| POST | `/claims/:id/sign` | Click-to-sign: capture name + NPI, embed legalAuthenticator, transition to Pending-Signature |
| POST | `/claims/:id/send` | Build + send 275, transition to Sent |

### New HTML views: `src/views/`

**`claimsQueue.html`** — table of all attachment requests with state badges, payer, patient, requested doc types, date received. Same card/table pattern as `dashboard.html`.

**`claimsRequestDetail.html`** — shows:
- Request metadata (payer, claim number, patient, subscriber ID)
- For each LOINC code: document type label, C-CDA preview (collapsible `<pre>` block)
- Sign & Send form: provider name input, NPI input, "Sign & Send" button
- State timeline (mirrors existing referral review timeline pattern)

### `src/modules/claims/review/signatureService.ts`

- `signRequest(requestId, providerName, providerNpi)`:
  1. For each `attachment_response` on the request, embed the `legalAuthenticator` block into the stored `ccdaXml`
  2. Set `signedByName`, `signedByNpi`, `signedAt` on each response

### Nav update

Add `<a href="/claims">Claims</a>` link to the `NAV_HTML` constant in `src/server.ts`.

---

## Phase 5 — 275 Response Builder & Send

### Module: `src/modules/claims/response/`

**`x12_275Builder.ts`** — builds a valid X12N 275 transaction:
- ISA/GS envelope with new control number
- For each signed `attachment_response`: 
  - STC segment with the LOINC code(s)
  - BDS segment: `BDS01 = "B64"`, `BDS02 = base64 length`, `BDS03 = Base64.encode(ccdaXml)`
- IEA/GE trailer

**`responseService.ts`** — orchestrates send:
1. Build 275 X12 string via `x12_275Builder.ts`
2. Write `.edi` file to `config.claimsOutboundDir` (filename: `275_<controlNumber>_<timestamp>.edi`)
3. Update each `attachment_response` with `sentAt` and `x12ControlNumber`
4. Transition `attachment_request` state: `Pending-Signature → Sent`

---

## Files Created

```
src/state/claimsStateMachine.ts
src/modules/claims/intake/ediWatcher.ts
src/modules/claims/intake/x12_277Parser.ts
src/modules/claims/intake/requestService.ts
src/modules/claims/intake/loincMapper.ts
src/modules/claims/document/claimsDocumentService.ts
src/modules/claims/document/claimsCcdaBuilder.ts
src/modules/claims/review/signatureService.ts
src/modules/claims/response/x12_275Builder.ts
src/modules/claims/response/responseService.ts
src/views/claimsQueue.html
src/views/claimsRequestDetail.html
scripts/seed-claims-demo.ts
tests/unit/claims/claimsStateMachine.test.ts
tests/unit/claims/loincMapper.test.ts
tests/unit/claims/x12_277Parser.test.ts
tests/unit/claims/claimsCcdaBuilder.test.ts
tests/unit/claims/x12_275Builder.test.ts
```

## Files Modified

```
src/db/schema.ts          — added attachment_requests, attachment_responses tables
src/config.ts             — added CLAIMS_WATCH_DIR, CLAIMS_OUTBOUND_DIR
src/server.ts             — added /claims routes, updated NAV_HTML
src/index.ts              — started EDI watcher alongside IMAP monitor
src/db/migrations/0005_add_claims_tables.sql  — created migration
src/db/migrations/meta/_journal.json           — updated journal
```

## Key Reuse Points

- `src/modules/prd08/fhirClient.ts` — FHIR patient search and resource queries
- `src/modules/prd08/fhirEnrichment.ts` — patterns for querying conditions/meds/encounters
- `src/modules/prd04/ccdaBuilder.ts` — reference for xmlbuilder2 C-CDA construction
- `src/state/referralStateMachine.ts` — exact pattern replicated for claimsStateMachine

## Dependencies

- `chokidar` — cross-platform file watching (already added)
- `xmlbuilder2` — already in use for C-CDA construction

## Implementation Status

✅ **Complete** — All 5 phases fully implemented and tested:
1. DB schema & state machine
2. 277 intake (file watcher, parser, request ingestion)
3. Document build (FHIR queries, C-CDA generation)
4. Review UI & e-signature
5. 275 response builder & send

**Test Coverage:** 304 tests passing (26 test suites)

**Known Issues & Fixes:**
- ✅ X12 277 parser: STC LOINC index range corrected (2–6)
- ✅ ISA segment: Control number extraction fixed (fields[12], not [13])
- ✅ X12 275 builder: Dynamic sender/receiver codes and payer/provider information
- ✅ EDI watcher: Refined file path logic to prevent directory recursion
- ✅ Test updates: C-CDA builder and X12 275 builder assertions corrected
