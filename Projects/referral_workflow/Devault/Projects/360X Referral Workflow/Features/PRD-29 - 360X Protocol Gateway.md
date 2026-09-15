---
up: "[[📋 PRD Index]]"
prev: "[[PRD-28 - Correlation & Exception Queue]]"
---

# PRD-29: 360X Protocol Gateway & Context Authoring

**Status:** Drafting  
**Team:** Clinical Workflow & Interoperability  
**Module:** `workspace/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

360X only closes a loop when both sides implement it. That is the adoption problem the whole
competitive landscape shares: Epic/Netsmart has a production deployment between two specific systems;
NextGen documents a real protocol UX but still ships initiator access through a pilot; every vendor's
reach is limited by how many counterparties have done their own implementation. The source document's
answer was capability detection with graceful degradation — detect that the other side cannot speak
360X, fall back to a simple Direct message or a fax, and keep the workspace useful locally.

This PRD takes the opposite approach, and it is the central bet of the epic: **the workspace supplies
the protocol, so neither party has to implement it.** A party brings only a Direct address — which is
commonplace, unlike a 360X implementation. Inside the workspace, any participant attaches 360X
context to what they are already doing: a coordinator posts "accepted, booking for the 22nd"; a
specialist at the receiving organization uploads a consult note and marks it as the final outcome.
The gateway turns each of those into the conformant artifact — RRI, SIU, C-CDA consult note, status
message — carrying the preserved referral identifier, validates it against the protocol state
machine, stores it immutably, and delivers it to the other party's Direct address.

This is close to what Kno2 markets as portal and API enablement, which the source document records as
explicit 360X support. The difference is where it happens: not in a separate portal the counterparty
must adopt as a new system, but inside the shared workspace they were already invited to for this one
referral.

Everything needed to produce conformant artifacts already exists in this codebase. `rriBuilder.ts`
builds accept/decline responses, `siuBuilder.ts` builds scheduling notifications, `ccdaBuilder.ts`
builds consult notes, `mdnService.ts` builds delivery notifications, and `referralStateMachine.ts`
guards the lifecycle. This PRD adds no message-building code. It adds the authoring surface, the
assertion model, the authorization rules, and the delivery decision.

### Goal

The primary goal of this feature is to:
1. Let **any participant** — licensed user or invited guest — attach 360X context to a message or
   document without knowing anything about HL7, C-CDA or Direct
2. **Render every assertion into a conformant artifact** using the existing builders, guarded by the
   existing state machine, with the referral identifier preserved across organizations
3. **Always record, conditionally transmit** — the artifact is stored immutably whether or not there
   is anywhere to send it, so the record is complete even for a party with no Direct address
4. Make **counterparty 360X capability irrelevant to adoption** — a party needs a Direct address, not
   an implementation

### Scope

**In Scope:**
- The assertion model: the set of protocol statements a participant can make, and the party role
  permitted to make each
- An authoring surface in the workspace: compose a message or attach a document, then attach 360X
  context to it
- Rendering each assertion into a conformant artifact via the existing builders
- Validation against `referralStateMachine.transition()` before anything is rendered or sent
- Immutable persistence of every rendered artifact as a workspace document, with `delivery_mode`
- The delivery decision: transmit to a party's Direct address when there is one, record locally when
  there is not
- Transport identity: Mode A (address on file) as the default, with the data model shaped for Mode B
  (delegated mailbox)
- Capability verification — marking a party `native-360x` or `workspace-mediated` after a real
  exchange
- Party-role authorization of assertions

**Out of Scope:**
- Any new message-building code; the existing builders are used unchanged, and extending a builder's
  output is a change to that builder's own PRD
- Guest identity, invitation and scoping — PRD-30, which this PRD depends on for the guest half
- Fax as a transport; a fax-only counterparty is `local-only`
- Inbound parsing changes; inbound 360X continues through PRD-01 and PRD-06 unchanged
- Correlating an inbound artifact that does not match a workspace — PRD-28
- Becoming a HISP, issuing certificates, or identity-proofing an organization

---

## Assertion model

An **assertion** is a protocol statement a participant makes from inside the workspace. Each maps to
one artifact and one protocol transition.

| Assertion | Artifact | Protocol transition | Permitted party role |
|---|---|---|---|
| `acknowledge` | MDN (`mdnService.ts`) | `Received → Acknowledged` | receiving |
| `accept` | RRI (`rriBuilder.ts`) | `Acknowledged → Accepted` | receiving |
| `decline` | RRI (`rriBuilder.ts`) | `Acknowledged → Declined` | receiving |
| `needs-information` | RRI + info request (`prd09/infoRequestService.ts`) | `Acknowledged → Pending-Information` | receiving |
| `supply-information` | Direct message with attachments | `Pending-Information → Acknowledged` | initiating |
| `scheduled` | SIU (`siuBuilder.ts`) | `Accepted → Scheduled` | receiving |
| `no-show` | Direct notification (`prd11/noShowService.ts`) | `Scheduled → No-Show` | receiving |
| `encounter` | Interim update | `Scheduled → Encounter` | receiving |
| `interim-update` | Direct message, no state change | — | receiving |
| `final-outcome` | C-CDA Consult Note (`ccdaBuilder.ts`) | `Encounter\|Consult → Closed` | receiving |
| `acknowledge-outcome` | ACK | `Closed → Closed-Confirmed` | initiating |
| `cancel` | Cancellation notice | any non-terminal `→ Declined` | initiating |

A participant sees only the assertions available from the current protocol state *and* permitted for
their party role. The receiving party cannot cancel the referral; the initiating party cannot return
the outcome. A licensed internal user acts on behalf of the party their organization holds on this
workspace.

---

## Transport identity

Signing a Direct message as an organization requires that organization's HISP credentials. The
workspace cannot conjure them, so the PRD supports two modes and is explicit about what each proves.

**Mode A — address on file (default).** The party's Direct address identifies them inside the
workspace and inside the payload: it appears in the HL7 sender fields and as the C-CDA
author/authenticator, and it is recorded in the audit trail as the acting party. Outbound transport is
signed by the Concord customer's HISP and addressed *to* the other party's Direct address. What this
proves: the content was authored by that party, recorded at a known time, and delivered to their
address. What it does not prove: cryptographic non-repudiation of the party as transport sender.

**Mode B — delegated mailbox (upgrade path).** The party connects their own Direct mailbox credentials,
or the Concord customer is their HISP. Outbound messages are genuinely signed as them and
non-repudiation is complete.

The data model must not require rework to move a party from Mode A to Mode B: transport identity is a
per-party attribute resolved at send time, never baked into a stored artifact. Mode A is what ships;
Mode B is a configuration change plus credential storage, and credential storage is deliberately out
of scope here.

### Known issues for refinement — sender identity

Address cardinality was the third gap here and is now **resolved in PRD-24 v1.1**: a party holds a
canonical intake address on `workspace_parties.direct_address` plus every observed address in
`party_addresses`. Two sender-identity gaps remain, and are this PRD's own to close when it is
refined.

1. **Send-to routing — resolved, and stated here so this PRD inherits it rather than re-deciding.**
   Reply to the address the inbound message actually arrived from, falling back to the party's
   canonical intake address, and record the chosen address on the assertion so the audit trail names
   where it went. Note that `findPartyByDirectAddress()` can resolve a party by *domain* alone; a
   party matched that way has no confirmed reply address, so routing falls back to intake and the
   assertion records `matchedOn: 'domain'` rather than implying the address was verified.
2. **Sender identity is configurable per organization**, and this PRD does not yet branch on it.
   Proposed `config.workspace.senderIdentityMode: 'individual' | 'organization'`. Under
   `individual`, the acting internal user's own `users.direct_address` (PRD-17) is the
   sender/author, falling back to `config.receiving.directAddress` when they have none — which one
   seeded clinician deliberately does not, so the fallback is exercised. Under `organization`,
   outbound always uses the organizational address and the individual is named as author inside the
   payload only. Both branches need tests; real deployments differ, so neither is the "wrong" one.
3. **Per-individual sending does not change who signs transport.** Under Mode A the licensed party's
   HISP still signs, whichever address appears as sender in the payload. State that explicitly so
   `senderIdentityMode: 'individual'` is not mistaken for non-repudiation of that individual.

---

## User Stories & Acceptance Criteria

### As a specialist at a receiving organization with no 360X implementation, I want to accept a referral from inside the workspace so that the referring provider gets a real protocol response

**AC1:** From a workspace in `Acknowledged`, a participant acting for the receiving party sees
`accept`, `decline` and `needs-information` and no others.  
**AC2:** Submitting `accept` renders a conformant RRI through `rriBuilder.ts` — not a hand-built
message — with the referral identifier preserved.  
**AC3:** The protocol state moves `Acknowledged → Accepted` through
`referralStateMachine.transition()`, and an invalid assertion for the current state is rejected
before anything is rendered or sent.  
**AC4:** The rendered artifact is stored as an immutable workspace document with its type, source,
sender party and timestamp.  
**AC5:** The message thread shows the assertion and its artifact as one entry, using
`threadService.recordThreadMessage()` and the existing `referral_messages` table.

### As a care coordinator, I want to attach 360X context to a document I am sending so that the other side receives a protocol artifact rather than a loose attachment

**AC6:** When attaching a document, a participant can mark it as the referral's final outcome, an
interim update, or supplied information, and can set its document type and LOINC code.  
**AC7:** A document marked `final-outcome` is packaged as a C-CDA Consult Note through
`ccdaBuilder.ts` and drives `→ Closed`.  
**AC8:** A document with no 360X context attached is stored in the collection and never transmitted —
attaching context is the only thing that sends anything.

### As a care coordinator, I want to work a referral whose counterparty has no Direct address so that a missing address does not stop the workflow

**AC9:** An assertion against a `local-only` party still validates, renders and stores its artifact,
marked `delivery_mode: local-only`, and still advances the protocol state.  
**AC10:** The workspace states plainly that the artifact was recorded but not transmitted, and the
timeline marks it distinctly from a transmitted artifact.  
**AC11:** When a Direct address is later added to the party, previously local-only artifacts are
listed as available to transmit, and transmitting them is an explicit action — never automatic
backfill.

### As a care coordinator, I want to know which mode each side is operating in so that I understand what the other party is actually receiving

**AC12:** After a successful transmission to a party, `capability_verified_at` is set and the party's
mode is recorded as verified rather than assumed (via `markCapabilityVerified()` from PRD-24).  
**AC13:** A party whose own system responds with valid 360X artifacts is marked `native-360x`; a party
who only ever acts inside the workspace is marked `workspace-mediated`.  
**AC14:** A delivery failure does not silently downgrade a party's mode; it raises an exception for
PRD-28 and leaves the mode alone.

### As a compliance reviewer, I want to see who authored each artifact and under which transport mode so that the record stands on its own

**AC15:** Every stored artifact records: the asserting participant or guest, the party they acted for,
that party's Direct address, the transport mode in effect, and the delivery outcome.  
**AC16:** Under Mode A the artifact payload names the asserting party as author/authenticator, and the
audit event records that transport was signed by the licensed party — both facts are visible, neither
is implied.  
**AC17:** No internal artifact — comment, work status, queue, participant roster, assignment history —
appears in any rendered artifact, asserted by test.

---

## Technical Specifications

### Dependencies

- [[PRD-24 - Parties & Participants]] — parties, Direct addresses, protocol modes (hard prerequisite)
- [[PRD-30 - Guest Participation]] — for the guest half; the licensed-user half ships without it
- [[PRD-23 - Document Collection]] — artifact persistence target
- [[PRD-18 - Workspace Entity & Dual Status]] — workspace rows
- Existing builders, used unchanged: `src/modules/prd02/rriBuilder.ts`,
  `src/modules/prd03/siuBuilder.ts`, `src/modules/prd04/ccdaBuilder.ts`,
  `src/modules/prd01/mdnService.ts`, `src/modules/prd09/infoRequestService.ts`,
  `src/modules/prd11/noShowService.ts`
- `src/state/referralStateMachine.ts` — the only protocol guard
- `src/modules/messaging/threadService.ts` — `recordThreadMessage()`
- `nodemailer` via the existing SMTP transport for delivery

### Engineering Constraints

- **No new message-building code.** The gateway's job is to choose a builder, supply it with
  parameters, and route its output. If an assertion cannot be expressed through an existing builder,
  the correct response is to raise it as a gap against that builder's PRD, not to hand-build a
  message here.
- **Validate before render, render before send, store before send.** An invalid assertion produces no
  artifact. A rendered artifact is persisted before any transmission is attempted, so a delivery
  failure never loses the record.
- Protocol state changes only through `referralStateMachine.transition()`. The gateway calls it; it
  does not reimplement the guard or write `referrals.state` from a string literal.
- Assertion submission must be **idempotent per assertion id**. A retried submission from a
  double-clicked button or a reconnecting guest must not emit a second artifact.
- Transport identity is resolved at send time from the party row. Never store "signed by" in a way
  that a Mode A → Mode B migration would have to rewrite.
- Delivery is attempted asynchronously after the transaction commits; the response to the participant
  reports "recorded" and the delivery outcome arrives as an event. Do not hold a request open on SMTP.
- A delivery failure raises an exception for PRD-28 and leaves both the artifact and the party's
  protocol mode untouched.
- Guest-submitted assertions carry the guest actor prefix and are authorized by party role, never by
  trusting a client-supplied party id.

### Data Models

```typescript
// src/db/schema.ts — new
export const workspaceAssertions = sqliteTable(
  'workspace_assertions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),
    assertionKey: text('assertion_key').notNull().unique(),  // client-supplied idempotency key
    assertionType: text('assertion_type').notNull(),         // see the assertion table
    assertedByPartyId: integer('asserted_by_party_id').references(() => workspaceParties.id).notNull(),
    assertedByActor: text('asserted_by_actor').notNull(),    // 'user:<id>' | 'guest:<id>'
    context: text('context'),                                // JSON: appointment, LOINC, reason codes, note
    fromState: text('from_state'),
    toState: text('to_state'),
    artifactDocumentId: integer('artifact_document_id'),     // FK to workspace_documents (PRD-23)
    deliveryMode: text('delivery_mode').notNull(),           // 'transmitted' | 'local-only'
    transportMode: text('transport_mode').notNull(),         // 'address-on-file' | 'delegated-mailbox'
    deliveryStatus: text('delivery_status').notNull().default('Pending'),
                                                             // 'Pending' | 'Delivered' | 'Failed' | 'Not-Transmitted'
    deliveryError: text('delivery_error'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_assertions_workspace').on(table.workspaceId, table.createdAt),
    keyIdx: index('idx_workspace_assertions_key').on(table.assertionKey),
  }),
);
```

```typescript
// src/modules/workspace/assertionCatalog.ts — new
export type AssertionType =
  | 'acknowledge' | 'accept' | 'decline' | 'needs-information' | 'supply-information'
  | 'scheduled' | 'no-show' | 'encounter' | 'interim-update'
  | 'final-outcome' | 'acknowledge-outcome' | 'cancel';

export interface AssertionSpec {
  type: AssertionType;
  label: string;                       // plain language, shown to a guest who knows no HL7
  permittedRoles: PartyRole[];
  fromStates: ReferralState[];
  toState: ReferralState | null;       // null => no protocol transition
  builder: 'rri' | 'siu' | 'ccda' | 'mdn' | 'direct' | 'ack';
  requiredContext: string[];           // e.g. ['appointmentDate','location'] for 'scheduled'
}

export const ASSERTION_CATALOG: Record<AssertionType, AssertionSpec>;

/** What this actor may assert right now — drives the authoring UI and re-checked server-side. */
export function availableAssertions(
  protocolState: ReferralState, partyRole: PartyRole,
): AssertionSpec[];
```

```typescript
// src/modules/workspace/protocolGateway.ts — new
export class AssertionNotPermittedError extends Error {}   // wrong party role
export class AssertionNotAvailableError extends Error {}   // wrong protocol state
export class MissingAssertionContextError extends Error {} // required context absent

export interface AssertionRequest {
  workspaceId: number;
  assertionKey: string;
  assertionType: AssertionType;
  partyId: number;                    // resolved server-side, never trusted from the client
  actor: string;
  context?: Record<string, unknown>;
  documentIds?: number[];             // documents to package with the artifact
}

export interface AssertionResult {
  assertionId: number;
  artifactDocumentId: number;
  fromState: ReferralState | null;
  toState: ReferralState | null;
  deliveryMode: 'transmitted' | 'local-only';
  deliveryStatus: 'Pending' | 'Not-Transmitted';
  idempotentReplay: boolean;
}

export async function submitAssertion(req: AssertionRequest): Promise<AssertionResult>;
/** Transmit a previously local-only artifact after a Direct address is added. Explicit, never automatic. */
export async function transmitPending(assertionId: number, actor: string): Promise<AssertionResult>;
export async function getAssertions(workspaceId: number): Promise<Assertion[]>;
```

Migration: `0018_add_workspace_assertions.sql`.

Audit events: `workspace.assertion_made`, `workspace.artifact_rendered`,
`workspace.artifact_transmitted`, `workspace.artifact_not_transmitted`,
`workspace.artifact_delivery_failed`, `workspace.capability_verified`.

### API Design

**Endpoint:** `GET /api/workspaces/:id/assertions/available`

**Response:**
```json
{
  "partyRole": "receiving",
  "protocolState": "Acknowledged",
  "available": [
    { "type": "accept", "label": "Accept this referral", "requiredContext": [] },
    { "type": "decline", "label": "Decline this referral", "requiredContext": ["reason"] },
    { "type": "needs-information", "label": "Request more information", "requiredContext": ["requested"] }
  ]
}
```

**Endpoint:** `POST /api/workspaces/:id/assertions`

**Request:**
```json
{
  "assertionKey": "b3f1c2-accept-1",
  "assertionType": "scheduled",
  "context": { "appointmentDate": "2026-09-22T14:30:00Z", "location": "Cardiology Suite 2", "provider": "Dr. Imani Ofori" },
  "documentIds": []
}
```

**Response:**
```json
{
  "success": true,
  "assertionId": 88,
  "artifactDocumentId": 341,
  "fromState": "Accepted",
  "toState": "Scheduled",
  "deliveryMode": "transmitted",
  "deliveryStatus": "Pending",
  "idempotentReplay": false
}
```

- `403` `AssertionNotPermittedError` — party role may not make this assertion
- `409` `AssertionNotAvailableError` — not available from the current protocol state, with the list
  that is
- `422` `MissingAssertionContextError` — naming the missing context fields
- A replayed `assertionKey` returns `200` with the original result and `idempotentReplay: true`

**Endpoint:** `POST /api/workspaces/:id/assertions/:assertionId/transmit` — transmit a local-only
artifact after a Direct address is added. `409` if the party still has no address.

---

## Test Plan

**Unit Tests:**
- `availableAssertions()` returns exactly the catalog intersection of state and party role, for every
  state and both roles
- `submitAssertion()` rejects an assertion not permitted for the party role (403 path)
- `submitAssertion()` rejects an assertion not available from the current state, and no artifact row
  is written
- `submitAssertion()` rejects missing required context, naming each missing field
- A replayed `assertionKey` returns the original result and writes nothing new
- Each assertion type dispatches to the expected existing builder, asserted by mock
- An assertion against a `local-only` party stores the artifact with `delivery_mode: local-only`,
  `delivery_status: Not-Transmitted`, and still transitions the protocol state
- Delivery failure sets `Failed`, records the error, raises an exception, and leaves the party's
  protocol mode unchanged
- `transmitPending()` refuses while the party has no Direct address

**Integration Tests:**
- Full mediated loop: initiating party sends a referral; a receiving-party guest acknowledges,
  accepts, schedules, records the encounter and returns the final outcome from inside the workspace;
  the initiating party acknowledges the outcome — assert `Closed-Confirmed`, one conformant artifact
  per step, and a complete thread
- The same loop against a `local-only` receiving party — identical state progression, every artifact
  `Not-Transmitted`, nothing sent
- Add a Direct address mid-loop, transmit the pending artifacts explicitly, and assert the earlier
  ones are not auto-sent
- A licensed internal user and a guest each make an assertion, and both appear with correct actors
  and party attribution

**Edge Cases:**
- Two participants submit conflicting assertions concurrently (`accept` and `decline`) — one wins by
  the state machine, the other gets 409, no artifact for the loser
- A guest whose invitation is revoked between loading the page and submitting — rejected
- An assertion referencing a document the actor cannot see — rejected
- SMTP unavailable — artifact stored, delivery `Pending` then `Failed`, exception raised, protocol
  state already advanced and not rolled back
- A counterparty replying with a native 360X artifact after a mediated exchange — party marked
  `native-360x`, no duplicate loop

**Boundary Tests (inherited from the epic):**
- No internal comment, work status, queue, participant or assignment data appears in any rendered
  artifact — asserted against every builder path
- Internal-visibility documents cannot be attached to an assertion

**Regression:**
- PRD-01 … PRD-12 flows and tests pass unchanged; the builders are called with unchanged signatures

---

## Deliverables

- `workspace_assertions` in `src/db/schema.ts` + migration `0018_add_workspace_assertions.sql`
- `src/modules/workspace/assertionCatalog.ts`
- `src/modules/workspace/protocolGateway.ts`
- Routes: available assertions, submit assertion, transmit pending
- 360X context authoring surface in `src/views/workspaceDetail.html` (composer + document context)
- Capability verification wired to `markCapabilityVerified()` (PRD-24)
- `tests/unit/workspace/assertionCatalog.test.ts`,
  `tests/unit/workspace/protocolGateway.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]] — the departure this PRD implements
- [[PRD-24 - Parties & Participants]] — hard prerequisite
- [[PRD-30 - Guest Participation]] — the guest half
- [[PRD-23 - Document Collection]] — artifact persistence
- [[PRD-28 - Correlation & Exception Queue]] — delivery failures and unmatched inbound artifacts
- [[PRD-02 - Process & Disposition]], [[PRD-03 - Schedule Patient]],
  [[PRD-04 - Generate Consult Note]], [[PRD-06 - Close Loop]] — the builders reused unchanged
- [[../Architecture/360X Workflow Overview|360X Workflow Overview]]
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-14  
**Version:** 1.0
