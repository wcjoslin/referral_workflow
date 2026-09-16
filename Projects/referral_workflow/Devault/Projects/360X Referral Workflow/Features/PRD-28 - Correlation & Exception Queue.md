---
up: "[[📋 PRD Index]]"
prev: "[[PRD-27 - Notifications]]"
---

# PRD-28: Correlation, Reconciliation & Exception Queue

**Status:** Refined — implemented  
**Team:** Clinical Workflow & Interoperability  
**Module:** `workspace/`, `prd01/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

Inbound correlation in this system works by three independent mechanisms, each with a failure mode
that currently loses data silently.

**Initial intake** keys on the RFC-822 `Message-ID`, stored as `referrals.source_message_id` with a
unique constraint. Idempotency is a JSON file on disk — `.processed_messages.json`, loaded and saved
by `src/modules/prd01/inboxMonitor.ts` — which does not survive a container rebuild, cannot be shared
across instances, and is invisible to the operator.

**ACK correlation** keys on HL7 MSH-10 via `outbound_messages.message_control_id`. When
`processAck()` cannot find a match it returns `{ matched: false }` and the ACK is logged and dropped.
There is no dead-letter record, so an acknowledgement that arrives with a mangled control id simply
never happened. Only `ackCode === 'AA'` is processed at all.

**Patient matching does not exist.** `ingestReferral()` inserts a new `patients` row for every
inbound referral, so the same patient referred twice is two patients. There is no MRN, no FHIR id, no
dedupe key on the table.

Three further gaps: an auto-declined referral writes **no referral row at all** and emits
`referral.auto_declined` with `entityId: 0`, so the decision most worth reviewing is the least
visible; `attachment_requests` has no `referral_id` column, so claims attachments are never associated
with the referral they concern; and `messageType: 'InfoReply'` exists in the schema comment but has no
inbound correlation path — it is only ever produced by a demo route that supplies the referral id in
the URL.

The source document is direct about this: require "idempotent processing, replay, reconciliation, and
a visible exception queue," and provide "manual reassociation with full audit." The epic's Exception
work status and the queue view's Exception tab exist for what this PRD produces.

### Goal

The primary goal of this feature is to:
1. Make inbound processing **idempotent and durable** — replace the JSON file with a table that
   survives a rebuild and is visible to an operator
2. **Stop losing messages.** An inbound artifact that cannot be correlated becomes a visible exception
   rather than a log line
3. Give correlation **real identifiers** — the external 360X referral id plus sender, recipient and
   patient — instead of relying on a single `Message-ID`
4. Provide **manual reassociation** so a coordinator can attach an orphaned message or document to the
   right workspace, with full audit
5. Surface every exception in a **queue a human actually looks at**

### Scope

**In Scope:**
- A `processed_messages` table replacing `.processed_messages.json`, with replay support
- Persisting correlation identifiers on the workspace and a correlation service that uses them
- A `workspace_exceptions` table and the `Exception` work status lifecycle
- Capturing today's silent failures: unmatched ACKs, non-`AA` ack codes, auto-declines, duplicate
  patients, unlinked attachment requests, inbound replies with no correlation path
- Gateway failure cases from PRD-29: delivery failures, counterparty rejections, unresolvable Direct
  addresses
- Manual reassociation of an orphaned message or document to a workspace, audited
- Patient duplicate detection — flagging, not automatic merging
- The exception queue tab and an exception panel on the workspace

**Out of Scope:**
- Automatic patient merging; duplicates are flagged for a human because merging clinical records
  wrongly is worse than having two
- A full master patient index, MRN assignment or probabilistic matching — the matching here is
  deterministic on name, date of birth and available identifiers
- Retrying inbound parsing with alternative parsers
- Changing the 360X protocol behaviour of any existing PRD; this PRD observes and records
- Adding `referral_id` to `attachment_requests` as a schema change owned here — it is proposed, and
  the claims PRD owns the column if accepted

---

## User Stories & Acceptance Criteria

### As an operator, I want inbound processing to be idempotent across restarts so that a rebuild does not reprocess the mailbox

**AC1:** Processed message ids are stored in a `processed_messages` table, not a file on disk.  
**AC2:** Reprocessing the same `Message-ID` is a no-op and is recorded as a duplicate rather than
creating a second referral.  
**AC3:** The existing `.processed_messages.json` is imported once on first run and then ignored.  
**AC4:** An operator can deliberately replay a specific message id, and the replay is audited.  
**AC5:** The ignore rules that prevent self-send feedback loops (`IGNORED_SENDERS`,
`OWN_OUTBOUND_SUBJECTS`) keep working and their matches are recorded as ignored rather than silently
discarded.

### As a care coordinator, I want to know when a message arrived that we could not place so that nothing disappears

**AC6:** An inbound ACK with no matching control id creates an exception with the raw message retained,
instead of returning `{ matched: false }` and dropping it.  
**AC7:** An ACK with a non-`AA` code creates an exception naming the code rather than being ignored.  
**AC8:** An inbound message that parses but matches no workspace creates an unmatched-message
exception with its sender, subject and body retained.  
**AC9:** A duplicate or out-of-order protocol message — one whose transition is invalid from the
current state — creates an exception rather than throwing away the message.  
**AC10:** Every exception names what arrived, why it could not be placed, and what a human can do
about it.

### As a care coordinator, I want to attach an orphaned message to the right referral so that the record is complete

**AC11:** An exception offers reassociation to a workspace, with candidate workspaces ranked by
patient name, sender address and recency.  
**AC12:** Reassociating attaches the message to the workspace's thread and document collection, emits
`workspace.reassociated`, and resolves the exception.  
**AC13:** Reassociation records the original exception, the chosen workspace, the actor and the
reason — the full audit the source document requires.  
**AC14:** Reassociating a protocol message does **not** replay its state transition automatically;
advancing state is an explicit, separate action so a mis-association cannot corrupt the protocol
state.

### As a care coordinator, I want auto-declined referrals to be reviewable so that I can tell when the rules are wrong

**AC15:** An auto-declined referral creates a durable record carrying the inbound content and the
decline reasons, reachable from the exception queue.  
**AC16:** The `referral.auto_declined` event is associated with that record instead of `entityId: 0`.  
**AC17:** A coordinator can convert an auto-declined record into a real referral and workspace when the
decline was wrong, and the conversion is audited.

### As a care coordinator, I want duplicate patients flagged so that I can see when the same person was created twice

**AC18:** Ingest detects an existing patient with the same last name and date of birth and flags a
potential duplicate rather than silently creating another row.  
**AC19:** The flag is an exception a human resolves by confirming they are the same person or
different people; no automatic merge occurs.  
**AC20:** Confirming "same person" records the decision without merging clinical data, and the
limitation is stated plainly in the UI.

### As a care coordinator, I want to see all exceptions in one place so that they get worked

**AC21:** Exceptions appear in the Exception tab of the queue view (PRD-20), with type, age and
affected workspace.  
**AC22:** An exception on a workspace sets its work status to `Exception` and shows an exception panel.  
**AC23:** Resolving an exception returns the work status to what it was, or to `Triage` when that is
ambiguous, and is audited.  
**AC24:** An exception with no associated workspace — an orphaned inbound message — is still listed and
still workable.

---

## Technical Specifications

### Dependencies

- [[PRD-18 - Workspace Entity & Dual Status]] — the `Exception` work status and `exception_reason`
- [[PRD-20 - Shared Queues & Queue View]] — the Exception tab
- [[PRD-24 - Parties & Participants]] — sender-to-party matching for candidate ranking
- [[PRD-29 - 360X Protocol Gateway]] — delivery failures and counterparty rejections
- [[PRD-27 - Notifications]] — exception notifications
- `src/modules/prd01/inboxMonitor.ts`, `src/modules/prd06/ackService.ts`,
  `src/modules/prd02/referralService.ts` — the three correlation paths being hardened

### Engineering Constraints

- **Retain the raw artifact.** An exception without the original message is not workable. Store the
  raw content on the exception row; it is the only copy, because today it is discarded.
- **Never auto-replay a protocol transition on reassociation.** Attaching a message to a workspace is
  a records operation; advancing `referrals.state` is a protocol operation. Coupling them would let a
  mis-association corrupt the authoritative external state, which is the one thing the epic's
  dual-state rule exists to protect.
- **Flag duplicates, do not merge.** Automatic patient merging in a clinical system is a
  patient-safety risk. Deterministic detection, human decision, no merge in this PRD.
- Keep `referrals.source_message_id` and its unique constraint. The `processed_messages` table adds
  durability and observability; it does not replace the constraint that actually prevents duplicates.
- Import `.processed_messages.json` once, then stop reading it. Do not maintain both.
- `getOverdueMessages()`, `processAck()`'s success path and the existing ignore rules keep their
  current behaviour. This PRD adds recording on the paths that currently discard.
- Exceptions are raised fire-and-forget from the detecting code path, so raising one cannot fail
  ingest. But unlike an audit event, an exception that fails to persist is data loss — so log loudly
  and retry once.
- Candidate ranking is deterministic and explainable; a coordinator must be able to see why a
  workspace was suggested.

### Refinement findings and decisions

Every codebase claim in the draft was verified and all of them held. What follows is what changed, or
what the implementation found.

**1. Two real bugs, both caught by tests written for the acceptance criteria.**

- **The work-status restore used the wrong exception.** `resolveException()` restored
  `prior_work_status` from the exception being resolved. With two exceptions open at once only the
  FIRST captured a real prior status — the second was raised against a workspace already in
  `Exception`, so its value is null by design. Resolving them in order therefore restored `Triage` and
  silently discarded the `In-Progress` the workspace was actually in. Fixed to use the EARLIEST
  recorded non-null prior status, which is the status before the whole exception episode began, and
  pinned by a test that resolves in both orders.
- **Recency alone qualified a workspace as a candidate.** The ranking comment claimed "recency can
  only ever break a tie"; the code added it *before* the "no reasons, not a candidate" gate. So in a
  fresh database every recently created workspace was a candidate on recency alone — the suggestion
  list was simply every workspace, which is worse than no suggestions. Recency now applies only once
  something substantive has already matched.

**2. A gap the smoke check exposed: an unranked orphan was unresolvable.** With the recency fix, a
genuinely unrelated artifact correctly ranks nothing — and the UI then offered no way to attach it,
because reassociation was only reachable by clicking a candidate. The empty state now carries a
manual attach-by-workspace-id path. Without it the only available action was "dismiss", which is
exactly the data loss this PRD exists to stop.

**3. `raiseException()` must not await its own audit event.** The first version did, so a failure
writing `workflow_events` threw and LOST THE EXCEPTION — inverting the priority this whole feature
defends. The exception row is the durable record and frequently the only copy of the artifact; the
audit event is derived. The emit is now fire-and-forget with logging, and the insert is what is
awaited.

**4. Tolerance has to wrap the whole block, not just the raise.** In `processAck()` the workspace
lookup sat outside `raiseExceptionSafely()`, so a failure there threw straight out of ACK processing
— violating the stated rule that raising an exception must never fail the operation that detected
it. An ACK is protocol traffic; bookkeeping around it must not be able to reject it.

**5. `awaited_by_party_id` and `exception_id` are plain integers, not foreign keys.** PRD-20's `0019`
demonstrated that a real FK on an existing table forces a hand-edited recreation. For
`processed_messages.exception_id` there is a second reason: the exception row is sometimes written
AFTER the processed row, and a constraint would order the two writes for no benefit.

**6. `NextActionWorkspaceNotFoundError`-style naming applies here too.**
`ExceptionWorkspaceNotFoundError` is named distinctly from `workspaceService`'s
`WorkspaceNotFoundError`, because two same-named classes in different modules make `instanceof`
silently false for whichever the route did not import — turning a 404 into a 500.

**7. `AckResult` gained `exceptionId` rather than changing `matched`.** `matched` is what existing
callers branch on and its meaning has not changed: an unmatched ACK is still unmatched. It is now
also *retained*.

**8. The dedupe index is PARTIAL, on open rows only.** One open exception per
(`exception_type`, `message_control_id`), so a retry storm cannot fill the queue with the same
complaint — but the same message failing again AFTER a resolution can legitimately raise a fresh one.
Verified empirically across four cases: the open pair is refused, a different type for the same
control id is allowed, a resolved pair can be re-raised, and null control ids never collide.

**9. Raw content is capped at 256 KB and the truncation is RECORDED.** A C-CDA can be hundreds of
kilobytes and this column is the only copy, so the cap is generous — but an exception row that
silently lost half its artifact is worse than one that says it did, because a coordinator would
otherwise conclude the message was malformed.

**10. The auto-decline record is written BEFORE the RRI is sent.** A send failure must not lose the
artifact: that combination is exactly what makes an auto-decline unreviewable, because the
counterparty may not even have been told. The worst case is now a retained record whose RRI never went
out, which a human can see.

**11. `entityId` for an auto-decline is NEGATIVE.** AC16 asks for the event to be associated with the
durable record instead of `entityId: 0`. `auto_declined_referrals` is a different keyspace from
`referrals`, so a positive id would be misread as a referral id by any consumer that ignores
`entityType`. The negative sign makes that impossible, and `0` remains the fallback when recording
itself failed.

**12. PRD-18's reserved slot is now filled.** `hasOpenInternalItems()` ORs in an unresolved
exception, exactly where PRD-18's comment said PRD-28's source would go, and no caller changed. A
protocol event that closes the loop while an exception is open therefore derives
`Follow-up-Required` rather than `Resolved` — which is right: closing the loop with an unplaced
artifact against the referral should not read as resolved.

**13. Verified on real data — and the honest result is zero.** `seed-analytics-demo.ts` inserts
referrals DIRECTLY rather than through `ingestReferral()`, so none of the capture points fire on that
dataset and it produces no exceptions, no processed-message rows and no auto-declines. That is
correct, not a gap: the paths are on the ingest pipeline, which that script bypasses by design. They
are exercised end to end in `scripts/smoke.ts` through the real `processAck()`, `recordAutoDeclined()`
and `recordProcessed()`, against a live server — 44 checks.

### Data Models

```typescript
// src/db/schema.ts — new
export const processedMessages = sqliteTable(
  'processed_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    messageId: text('message_id').notNull().unique(),     // RFC-822 Message-ID
    senderAddress: text('sender_address'),
    subject: text('subject'),
    outcome: text('outcome').notNull(),
      // 'referral-created' | 'ack-matched' | 'duplicate' | 'ignored' | 'exception' | 'replayed'
    referralId: integer('referral_id').references(() => referrals.id),
    exceptionId: integer('exception_id'),
    processedAt: integer('processed_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    messageIdx: index('idx_processed_messages_message').on(table.messageId),
    outcomeIdx: index('idx_processed_messages_outcome').on(table.outcome, table.processedAt),
  }),
);

export const workspaceExceptions = sqliteTable(
  'workspace_exceptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id),  // null => orphan
    exceptionType: text('exception_type').notNull(),
      // 'unmatched-ack' | 'ack-error-code' | 'unmatched-message' | 'out-of-order'
      // | 'duplicate-message' | 'auto-declined' | 'duplicate-patient'
      // | 'delivery-failed' | 'counterparty-rejected' | 'unresolvable-address'
      // | 'unlinked-attachment-request'
    summary: text('summary').notNull(),            // what arrived and why it could not be placed
    remediation: text('remediation'),              // what a human can do about it
    rawContent: text('raw_content'),               // the retained artifact — often the only copy
    rawContentType: text('raw_content_type'),
    senderAddress: text('sender_address'),
    messageControlId: text('message_control_id'),
    relatedPatientName: text('related_patient_name'),
    metadata: text('metadata'),                    // JSON, type-specific
    priorWorkStatus: text('prior_work_status'),    // restored on resolution
    resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
    resolvedByActor: text('resolved_by_actor'),
    resolution: text('resolution'),                // 'reassociated' | 'converted' | 'confirmed-distinct'
                                                   // | 'confirmed-same' | 'dismissed' | 'retried'
    resolutionNote: text('resolution_note'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_exceptions_workspace').on(table.workspaceId, table.resolvedAt),
    openIdx: index('idx_workspace_exceptions_open').on(table.resolvedAt, table.exceptionType),
  }),
);

export const autoDeclinedReferrals = sqliteTable(
  'auto_declined_referrals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceMessageId: text('source_message_id').notNull().unique(),
    referrerAddress: text('referrer_address').notNull(),
    patientName: text('patient_name'),
    patientDob: text('patient_dob'),
    declineReasons: text('decline_reasons').notNull(),   // JSON array
    rawCcdaXml: text('raw_ccda_xml'),
    convertedReferralId: integer('converted_referral_id').references(() => referrals.id),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
);
```

`auto_declined_referrals` is what makes AC15–AC17 possible: today this content is sent back as an RRI
and then discarded.

```typescript
// src/modules/workspace/correlationService.ts — new
export interface CorrelationKeys {
  externalReferralId?: string;
  senderAddress?: string;
  recipientAddress?: string;
  patientLastName?: string;
  patientDob?: string;
  messageControlId?: string;
}

export interface CorrelationCandidate {
  workspaceId: number; referralId: number;
  patientName: string; initiatingOrgName: string | null;
  score: number;
  reasons: string[];        // explainable: 'patient name match', 'sender address match', ...
}

export async function correlate(keys: CorrelationKeys): Promise<
  { matched: true; workspaceId: number } | { matched: false; candidates: CorrelationCandidate[] }
>;

export async function recordProcessed(input: {
  messageId: string; senderAddress?: string; subject?: string;
  outcome: ProcessedOutcome; referralId?: number; exceptionId?: number;
}): Promise<void>;

export async function isAlreadyProcessed(messageId: string): Promise<boolean>;
export async function importLegacyProcessedFile(path: string): Promise<number>;
export async function replayMessage(messageId: string, actor: ActingUser): Promise<void>;
export async function findPotentialDuplicatePatients(
  lastName: string, dob: string,
): Promise<number[]>;
```

```typescript
// src/modules/workspace/exceptionService.ts — new
export async function raiseException(input: {
  workspaceId?: number; exceptionType: ExceptionType;
  summary: string; remediation?: string;
  rawContent?: string; rawContentType?: string;
  senderAddress?: string; messageControlId?: string;
  relatedPatientName?: string; metadata?: Record<string, unknown>;
}): Promise<number>;

export async function listOpenExceptions(
  user: ActingUser, filters?: { exceptionType?: ExceptionType; workspaceId?: number },
): Promise<WorkspaceException[]>;

/** Attaches the artifact to a workspace. Never replays a protocol transition — see AC14. */
export async function reassociate(
  exceptionId: number, workspaceId: number, actor: ActingUser, note: string,
): Promise<void>;

export async function convertAutoDeclined(
  exceptionId: number, actor: ActingUser, note: string,
): Promise<{ referralId: number; workspaceId: number }>;

export async function resolveException(
  exceptionId: number, resolution: ExceptionResolution, actor: ActingUser, note?: string,
): Promise<void>;
```

Migration: `0021_vengeful_rhodey.sql` — three tables, all additive, no table recreation (finding 5).
Audit events: `workspace.exception_raised`, `workspace.exception_resolved`,
`workspace.reassociated`, `workspace.auto_declined_recorded`,
`workspace.auto_declined_converted`, `workspace.message_replayed`,
`workspace.duplicate_patient_flagged`.

### API Design

**Endpoint:** `GET /api/exceptions?type=unmatched-ack&open=1`
```json
{
  "count": 2,
  "exceptions": [
    { "id": 7, "exceptionType": "unmatched-ack", "workspaceId": null,
      "summary": "ACK received for control id MSG00291, which matches no outbound message",
      "remediation": "Attach to the correct referral, or dismiss if sent in error",
      "senderAddress": "referrals@northside.direct.example.org",
      "messageControlId": "MSG00291", "relatedPatientName": "R. Alvarez",
      "createdAt": "2026-09-14T11:02:00Z" }
  ]
}
```

**Endpoint:** `GET /api/exceptions/:id/candidates`
```json
{ "candidates": [ { "workspaceId": 12, "referralId": 31, "patientName": "R. Alvarez", "initiatingOrgName": "Northside Primary Care", "score": 0.86, "reasons": ["patient name match", "sender address match", "created within 7 days"] } ] }
```

**Endpoint:** `POST /api/exceptions/:id/reassociate`
```json
{ "workspaceId": 12, "note": "control id mangled by the sending system; patient and dates match" }
```

**Endpoint:** `POST /api/exceptions/:id/resolve`
```json
{ "resolution": "dismissed", "note": "test message from the counterparty's staging system" }
```

**Endpoint:** `POST /api/exceptions/:id/convert` — auto-declined → real referral and workspace.

**Endpoint:** `POST /api/messages/:messageId/replay` — operator replay; audited.

**Page:** `GET /exceptions` — the exception queue, and the Exception tab in the queue view.

---

## Test Plan

**Unit Tests:**
- `isAlreadyProcessed()` true after `recordProcessed()`, false for an unseen id
- `importLegacyProcessedFile()` imports each id once and is idempotent on a second run
- An unmatched ACK raises an `unmatched-ack` exception retaining the raw message
- A non-`AA` ack code raises `ack-error-code` naming the code
- An out-of-order protocol message raises `out-of-order` and does not throw away the content
- `correlate()` returns a direct match on `messageControlId`, and ranked candidates otherwise
- Candidate `reasons` are populated for every scoring contribution — no unexplained scores
- `findPotentialDuplicatePatients()` matches on last name plus date of birth and ignores case
- `reassociate()` attaches the artifact, emits `workspace.reassociated`, resolves the exception, and
  leaves `referrals.state` unchanged
- `convertAutoDeclined()` creates a referral and workspace and links the original record
- `resolveException()` restores `prior_work_status`, or `Triage` when it was null

**Integration Tests:**
- Deliver an ACK with a mangled control id and assert an exception with candidates, then reassociate
  and assert the thread contains the message and the protocol state is untouched
- Restart the process and assert no mailbox message is reprocessed
- Auto-decline a referral, find it in the exception queue, convert it, and assert a working workspace
- Ingest the same patient twice and assert a duplicate-patient exception, then resolve it both ways
- Fail a PRD-29 delivery and assert a `delivery-failed` exception with the party's protocol mode
  unchanged
- Raise an exception on a workspace and assert its work status becomes `Exception` and the Exception
  tab count increases

**Edge Cases:**
- Raw content exceeding a sensible column size — truncated with the truncation recorded
- Exception raised for a workspace that is later archived
- Two exceptions for the same inbound message — deduplicated on message id plus type
- Reassociating to a workspace that already has that message — rejected as a duplicate
- Replaying a message that succeeded the first time — creates no second referral
- An orphaned exception with no candidates at all — still listed, dismissible

**Regression:**
- `processAck()`'s matched path, the ignore rules, `referrals.source_message_id` uniqueness, and the
  PRD-01/PRD-06 suites are unchanged

---

## Deliverables

- `processed_messages`, `workspace_exceptions`, `auto_declined_referrals` in `src/db/schema.ts` +
  migration `0021_add_correlation_and_exceptions.sql`
- `src/modules/workspace/correlationService.ts`, `src/modules/workspace/exceptionService.ts`
- `inboxMonitor.ts` switched from `.processed_messages.json` to the table, with one-time import
- Exception raising added to `ackService.processAck()`, `referralService.autoDecline()` and
  `ingestReferral()` patient handling
- Gateway failure exceptions wired from PRD-29
- `src/views/exceptionQueue.html` + exception panel in the workspace
- Routes listed above, plus `GET /exceptions` and `GET /api/processed-messages`
- `src/views/exceptionQueue.html`, and the exception panel in `workspaceDetail.html`
- `hasOpenInternalItems()` ORs in an unresolved exception, filling PRD-18's reserved slot
- `threadHasControlId()` added to `threadService`, so reassociation refuses a message the workspace
  already carries
- `tests/unit/workspace/exceptionService.test.ts` — 59 tests covering both services; three new tests
  in `tests/unit/prd06/ackService.test.ts` asserting the two discard paths end to end through the
  real `processAck()`
- 44 new smoke checks driving the real modules against a live server

**Not built, and why:**

- **`referral_id` on `attachment_requests`.** Still only a proposal, as the draft scoped it: the
  claims PRD owns that column. `unlinked-attachment-request` exists as an exception type so the
  capture point is ready, and nothing raises it yet.
- **A correlation path for inbound `InfoReply`.** The draft noted it has none, and it still has none:
  the only producer is a demo route that supplies the referral id in the URL. Adding a path would
  mean inventing an inbound format no counterparty sends. `unmatched-message` is the type such a
  message would land under.
- **PRD-29 gateway failure capture.** `delivery-failed`, `counterparty-rejected` and
  `unresolvable-address` are defined and raisable, and `ack-error-code` covers the rejection case
  that actually occurs today. Wiring the gateway's own failure paths is a change to PRD-29's module
  and is left to it rather than reached into from here.
- **Automatic patient merging.** Explicitly out of scope, and the UI says so where a coordinator
  confirms "same person": the two rows remain separate and their clinical data is not combined.

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-01 - Receive & Acknowledge]] — inbound idempotency being replaced
- [[PRD-06 - Close Loop]] — ACK correlation being hardened
- [[PRD-18 - Workspace Entity & Dual Status]] — the `Exception` work status
- [[PRD-20 - Shared Queues & Queue View]] — the Exception tab
- [[PRD-29 - 360X Protocol Gateway]] — delivery and rejection failures
- [[PRD-25 - Activity History & Audit]] — exception events in the feed
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-16  
**Version:** 1.1

**v1.1 — refinement and implementation.** Thirteen findings recorded above. Every codebase claim in
the draft was verified and all held. Two real bugs were found by tests written for the acceptance
criteria — the work-status restore used the wrong exception's prior status, and recency alone
qualified a workspace as a correlation candidate — and a third gap surfaced only in the live smoke
check: with recency correctly demoted, an unranked orphan had no reassociation path at all, so a
manual attach-by-id was added. Two ordering mistakes were also corrected: `raiseException()` awaited
its own audit event (so an audit failure lost the exception), and `processAck()`'s tolerance wrapped
only the raise rather than the workspace lookup it depends on.
