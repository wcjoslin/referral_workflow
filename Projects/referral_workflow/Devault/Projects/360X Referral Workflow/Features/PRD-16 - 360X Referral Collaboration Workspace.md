---
up: "[[📋 PRD Index]]"
prev: "[[PRD-15 - Analytics Agent AI]]"
---

# PRD-16: 360X Referral Collaboration Workspace (Epic)

**Status:** Drafting  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`  
**Epic:** This document *is* the epic — PRD-17 through PRD-30 are its children

---

## Overview

### Context

The project so far has recreated a broad referral surface: a message inbox, the full 360X protocol
state machine, claims attachments, prior authorization, department routing, an event log and an
analytics dashboard. What it does not have is a **place where people work on a referral together**.

A competitive review of the 360X landscape (`360x_Software_Collaboration_Enhancements.docx`) found
that the market gap is not another status tracker. Epic/Netsmart and NextGen have production or
well-documented 360X implementations, Kno2 and ReferralMD claim explicit support, and all of them
expose referral *states*, prescribed next actions, clinical-document exchange and notifications.
None of the publicly documented implementations provides a persistent referral-level workspace that
combines conversation, documents, ownership, participants and audit history around the 360X referral
object. The strongest collaboration patterns come from adjacent platforms: Unite Us attaches chat to
a shared referral, Findhelp makes progress and next steps visible to every party, ReferralMD pairs
work queues with messaging and referral-associated tasks.

The differentiation this epic pursues, stated plainly: move the product from answering
**"what status is this referral in?"** to answering **"who owns the next action, what information is
available, and what has happened?"**

A second, equally important move: rather than detecting whether a counterparty has implemented 360X
and degrading when they have not, **the workspace becomes the 360X enablement layer**. Neither party
needs its own 360X implementation. Each party brings a Direct address; any participant — a licensed
user or an invited guest — can attach 360X context to their messages and documents from inside the
workspace, and the system renders that into conformant protocol artifacts and owns the state machine.
Parties with no Direct address still get a fully usable workspace with local status updates.

### Goal

The primary goal of this epic is to:
1. Make every recognized 360X referral a **persistent, accountable unit of collaborative work** —
   one workspace with an owner, a next action, a conversation, a document collection, participants
   and a complete history.
2. Keep the **authoritative external protocol state and the internal work state visibly separate**,
   so operational progress is never confused with what the counterparty has been told.
3. Deliver **360X capability to both sides of the referral** through the workspace, so a counterparty
   who has never implemented the protocol can still participate in a closed loop.
4. Build all of it on the referral entity, state machine, event log, message thread, queues and
   document handling that already exist, rather than on a new collaboration platform.

### Scope

**In Scope (delivered by children PRD-17 … PRD-30):**
- A workspace object per referral, created automatically from a recognized 360X request
- Dual status model: authoritative 360X status and Concord-local work status
- Workspace header with patient, reason, organizations, owner, due date and next action
- Unified activity timeline over protocol events, user actions, guest actions and artifacts
- A referral document collection with source, type, sender, received date and protocol relationship
- One referral conversation with per-comment internal/shared visibility
- One owning shared queue and one primary assignee, with reassignment recorded
- Internal participants, and external parties as invited, acting collaborators
- 360X context authoring and protocol-artifact rendering for every party
- Notifications for assignment, pending response, state change, new document, mention, overdue,
  exception
- Automation: auto-create, correlate, route, update state, compute next action, flag overdue and
  unmatched records, close on a valid outcome

**Out of Scope (retained MVP exclusions from the source document §9):**
- Exchanging proprietary comments, tasks, roles or work status over 360X — only conformant protocol
  artifacts and approved clinical documents cross the boundary
- Multi-party referrals beyond the initiating and receiving parties
- Full project-style task lists, subtasks and checklists
- Simultaneous document editing or version co-authoring
- Cross-organization chat as a standalone product surface
- Patient or caregiver participation
- AI-authored clinical responses
- A new policy engine beyond routing, deadlines and exceptions

---

## The minimum workspace object

From the source document §7, mapped onto this codebase. "Exists" means the field or table is already
in `src/db/schema.ts`; "New" means a child PRD creates it.

| Workspace attribute | Status | Where | Delivered by |
|---|---|---|---|
| Concord workspace ID | New | `referral_workspaces.id` | PRD-18 |
| External 360X referral ID + correlation identifiers | New | `referral_workspaces.externalReferralId`, `correlationKey` | PRD-18, PRD-28 |
| Patient and referral summary | Exists | `patients`, `referrals.reasonForReferral`, `clinicalData` | PRD-19 (display) |
| Initiating and receiving organizations | New | `workspace_parties` | PRD-24 |
| Authoritative 360X state | Exists | `referrals.state` + `src/state/referralStateMachine.ts` | — |
| Concord-local work status | New | `referral_workspaces.workStatus` + `src/state/workStatusMachine.ts` | PRD-18 |
| Single internal owner and owning queue | New | `referral_workspaces.ownerUserId`, `queueId` | PRD-21, PRD-20 |
| Current next action and due date | New | `referral_workspaces.nextAction`, `nextActionDueAt` | PRD-26 |
| Linked immutable messages and documents | Partial | `referral_messages` exists; `workspace_documents` new | PRD-23 |
| Referral comments | New | `referral_comments` | PRD-22 |
| Internal participants + external party visibility | New | `workspace_participants`, `workspace_parties` | PRD-24, PRD-30 |
| Append-only activity history | Partial | `workflow_events` exists but has no per-entity reader | PRD-25 |

---

## Architectural rules

### Two state models, never conflated

The source document's risk table is explicit and this epic adopts it as a hard rule:

- **360X status** (`referrals.state`) is *externally authoritative*. It changes only through a valid
  protocol event, always via `transition()` in `src/state/referralStateMachine.ts`.
- **Work status** (`referral_workspaces.workStatus`) represents *internal processing*. It changes
  only through a user action or an internal rule, always via `transition()` in the new
  `src/state/workStatusMachine.ts`.
- Neither silently overwrites the other. A protocol event may *propose* a work status change; the
  proposal is advisory and never overrides a work status a person has set.
- The two are rendered as two visually distinct badges everywhere they appear.

**Closure conflict.** A referral may reach `Closed-Confirmed` externally while internal follow-up is
still open. The protocol lifecycle closes; the work status becomes `Follow-up-Required` and local
archival is blocked. The external state is never reopened to represent internal work.

### Protocol modes

Counterparty capability is a property of *how a party participates*, not a precondition for the
workspace. Each party on a workspace carries one of:

| Mode | Meaning | Behaviour |
|---|---|---|
| `native-360x` | The party's own system speaks 360X over Direct | Artifacts exchanged as they are today |
| `workspace-mediated` | The party has a Direct address but no 360X implementation; they act inside the workspace | The gateway renders their action into a conformant artifact and delivers it to their Direct address |
| `local-only` | The party has no Direct address | Artifacts are still generated and stored for the record; nothing is transmitted; protocol state advances locally |

### Boundary discipline

Only conformant 360X artifacts and approved clinical documents cross the organizational boundary.
Internal comments, work status, queue membership, assignment history and internal participant rosters
do not — and every child PRD that touches outbound data must carry a test asserting it.

---

## Feature map

**Refinement status.** PRD-17 and PRD-18 are refined and Ready for Dev. PRD-19 … PRD-30 are first
drafts at Drafting; the migration numbers they quote are indicative and get assigned when each is
implemented, and PRD-20, PRD-24, PRD-29 and PRD-30 carry known-issue notes recorded during the
PRD-17/18 refinement.

| PRD | Feature | Phase | Module |
|---|---|---|---|
| [[PRD-17 - Identity & Acting User\|PRD-17]] | Identity & Acting User Model | 1 — Foundation | `workspace/` |
| [[PRD-18 - Workspace Entity & Dual Status\|PRD-18]] | Workspace Entity & Dual Status Model | 1 — Foundation | `workspace/`, `state/` |
| [[PRD-19 - Workspace Shell\|PRD-19]] | Workspace Shell (`/workspaces/:id`) | 2 — Surface & enablement | `workspace/`, `views/` |
| [[PRD-21 - Ownership & Assignment\|PRD-21]] | Ownership & Assignment | 2 — Surface & enablement | `workspace/` |
| [[PRD-24 - Parties & Participants\|PRD-24]] | Parties & Participants | 2 — Surface & enablement | `workspace/` |
| [[PRD-30 - Guest Participation\|PRD-30]] | Guest Participation & Secure Invitations | 2 — Surface & enablement | `workspace/` |
| [[PRD-29 - 360X Protocol Gateway\|PRD-29]] | 360X Protocol Gateway & Context Authoring | 2 — Surface & enablement | `workspace/` |
| [[PRD-22 - Referral Conversation\|PRD-22]] | Referral Conversation (dual-visibility) | 3 — Collaboration artifacts | `workspace/` |
| [[PRD-23 - Document Collection\|PRD-23]] | Referral Document Collection | 3 — Collaboration artifacts | `workspace/` |
| [[PRD-25 - Activity History & Audit\|PRD-25]] | Unified Activity History & Audit | 3 — Collaboration artifacts | `workspace/`, `analytics/` |
| [[PRD-20 - Shared Queues & Queue View\|PRD-20]] | Shared Queues & Referral Queue View | 4 — Operational layer | `workspace/`, `views/` |
| [[PRD-26 - Next Action & Due Dates\|PRD-26]] | Next Action & Due Dates (SLA) | 4 — Operational layer | `workspace/` |
| [[PRD-27 - Notifications\|PRD-27]] | Notifications | 4 — Operational layer | `workspace/` |
| [[PRD-28 - Correlation & Exception Queue\|PRD-28]] | Correlation, Reconciliation & Exception Queue | 4 — Operational layer | `workspace/`, `prd01/` |

### Sequencing

```
Phase 1  PRD-17 (identity) ──┬────────────────────────────────┐
         PRD-18 (workspace + dual status) ──┐                 │
                                            ▼                 │
Phase 2  PRD-19 (shell) ──► PRD-21 (ownership)                │
                       └──► PRD-24 (parties & participants) ◄─┘
                                    ├──► PRD-30 (guest participation)
                                    └──► PRD-29 (protocol gateway) ◄── PRD-30

Phase 3  PRD-22 (conversation) ──┐
         PRD-23 (documents) ─────┼──► PRD-25 (activity & audit)
                                 └────┘   (PRD-29 artifacts feed both)

Phase 4  PRD-20 (queues) · PRD-26 (SLA) · PRD-27 (notifications) · PRD-28 (reconciliation)
```

PRD-17 and PRD-18 are the only hard prerequisites. Within Phase 2, PRD-24 gates both PRD-30 and
PRD-29; PRD-30 gates the guest half of PRD-29, while its licensed-user half can ship without it.
Phases 3 and 4 are independently refinable and independently shippable behind the PRD-19 shell.

---

## Departures from the source document

Three deliberate changes of direction, recorded so they read as decisions rather than drift.

**1. External guest accounts are in scope, not excluded.**
The document lists "external guest accounts or federated workspace membership" as an MVP exclusion
and secure partner participation as a later phase. This epic brings guest participation into Phase 2.
*Reasoning:* the document's own whitespace analysis identifies referral-scoped cross-organization
collaboration as the differentiator, and its MVP would have delivered the local half only. Guest
participation is what makes the workspace the enablement layer rather than a private view.

**2. External parties are acting participants, not read-only.**
The document's risk position is to "display external organizations and Direct addresses as referral
participants, not workspace users." Here an external party can be invited into a single workspace and
can act within it, scoped by party role.
*Reasoning:* a receiving organization that cannot respond inside the workspace has to be chased by
phone, which is the problem the epic exists to solve. Federated identity is still not required — an
invitation is scoped to one workspace and carries no tenant-wide account.

**3. Counterparty capability is not a precondition.**
The document's position is capability detection with graceful degradation to basic Direct or fax.
This epic replaces that with protocol mediation: the gateway renders conformant artifacts on behalf
of a party who has not implemented 360X. Degradation now applies only to a party with no Direct
address at all.
*Reasoning:* this is closer to Kno2's portal/API enablement model, which the document records as
explicit 360X support, but delivered inside the shared workspace rather than a separate portal. It
removes bilateral deployment as an adoption blocker.

### Open questions the children must answer

Carried from the source document's risk table; each is assigned to the PRD that must decide it.

| Question | Owner |
|---|---|
| Are comment edits prohibited or versioned? How is deletion represented? | PRD-22 |
| Which receipts prove technical delivery versus human access? | PRD-25 |
| How is a completed protocol lifecycle with open internal follow-up represented? | PRD-18, PRD-26 |
| What enforces least-privilege access to PHI in queues and workspaces? | PRD-20, PRD-30 |
| Whose Direct identity signs an artifact rendered on a party's behalf? | PRD-29 |
| ~~How many Direct addresses does a party have, and which is canonical for sending?~~ **Answered in PRD-24 v1.1:** several — a canonical intake address on the party plus a `party_addresses` row per address observed. PRD-29 sends to the inbound address, falling back to intake. | PRD-24 ✅, then PRD-29 and PRD-30 |
| How are duplicate, late, unmatched and contradictory messages reconciled? | PRD-28 |

---

## Later-phase opportunities

Documented here, not specced, and not part of this epic's delivery:

- Cross-organization chat as a product surface beyond referral-scoped conversation (Unite Us pattern)
- Patient or caregiver progress visibility (Findhelp shared-journey pattern)
- Multiple owners, subtasks, checklists, service-level timers and escalation chains
- Provider matching, capacity, availability and scheduling coordination (ReferralMD pattern)
- AI referral-packet summaries (WellSky CarePort pattern)
- Referral-network analytics, leakage analysis and partner scorecards — extends
  `src/modules/analytics/analyticsQueries.ts`

---

## Technical Specifications

### Dependencies

No new runtime dependencies. Every child PRD builds on what is installed: `drizzle-orm` +
`better-sqlite3` for persistence, `express` for routes, `nodemailer` for outbound mail,
`xmlbuilder2` / `hl7` / `@kno2/bluebutton` for artifacts, `@kno2/ccdaview` for document rendering.

### Engineering Constraints

- **Reuse first.** Each child PRD must name the existing table, service, route or CSS component it
  extends rather than introducing a parallel mechanism. The workspace adds no second message store,
  no second event log and no second artifact builder.
- Every state change goes through a `transition()` guard. The two existing bypasses
  (`POST /referrals/:id/override` in `src/server.ts`, and the escalation path in
  `src/modules/prd09/pendingInfoChecker.ts`) are corrected by PRD-25.
- Audit writes stay fire-and-forget: `void emitEvent({...}).catch((err) => console.error(...))`.
- The `workflow_events.actor` prefix convention (`system`, `clinician:<id>`, `skill:<name>`,
  `payer:<name>`) is load-bearing — `analyticsQueries.ts` parses it. New actors extend it
  (`user:<id>`, `guest:<id>`, `party:<directAddress>`) and never change the existing prefixes.
- Views remain self-contained HTML in `src/views/` with a `<!--__NAV__-->` marker and a
  `/*__X_DATA__*/` token; there is no template engine and none is introduced.
- All writes are `fetch()` with JSON bodies — `express.json()` is the only body parser configured.
- Strict TypeScript, explicit return types, no `any` (`.eslintrc.json`).
- Jest thresholds: 80% lines/functions, 70% branches (`jest.config.ts`). Tests under
  `tests/unit/workspace/`.

### Data Models

The tables introduced across the epic, for orientation. Each child PRD owns its own definition.

```typescript
// PRD-18
referral_workspaces   // one per referral: work status, owner, queue, next action, correlation ids
// PRD-17
users                 // internal staff identity (no passwords)
// PRD-20
queues, queue_members // shared queues with least-privilege membership
// PRD-24
workspace_parties        // the organizations on the referral + Direct address + protocol mode
workspace_participants   // internal collaborators with Manager/Collaborator/Viewer roles
// PRD-30
workspace_invitations, workspace_guests   // single-workspace scoped external access
// PRD-22
referral_comments     // one thread, per-comment Internal/Shared visibility, versioned
// PRD-23
workspace_documents   // an index over artifacts that already exist, plus uploads
// PRD-27
notifications
// PRD-28
processed_messages, workspace_exceptions
```

### API Design

Route families introduced by the epic; details live in the child PRDs.

```
GET  /workspaces/:id                       workspace page (PRD-19)
GET  /api/workspaces/:id                   workspace payload
GET  /api/workspaces/:id/activity          unified history (PRD-25)
GET  /api/workspaces/:id/comments          conversation (PRD-22)
POST /api/workspaces/:id/comments
GET  /api/workspaces/:id/documents         document collection (PRD-23)
POST /api/workspaces/:id/owner             assignment (PRD-21)
POST /api/workspaces/:id/parties           parties & participants (PRD-24)
POST /api/workspaces/:id/invitations       guest invitations (PRD-30)
POST /api/workspaces/:id/assertions        360X context authoring (PRD-29)
GET  /queues, /queues/:slug                queue views (PRD-20)
GET  /api/notifications                    notifications (PRD-27)
```

---

## Test Plan

This epic has no implementation of its own. It imposes four cross-cutting test obligations that every
child PRD inherits:

**Boundary tests:**
- No internal artifact (comment, work status, queue, participant roster, assignment history) appears
  in any outbound payload produced by `prd02/rriBuilder.ts`, `prd03/siuBuilder.ts`,
  `prd04/ccdaBuilder.ts` or `prd01/mdnService.ts`
- No internal artifact appears in any guest-facing API response

**Dual-state tests:**
- A protocol transition never mutates a manually set work status
- A work status transition never mutates `referrals.state`
- `Closed-Confirmed` with open internal items yields `Follow-up-Required` and blocks archival

**Audit tests:**
- Every workspace mutation writes a `workflow_events` row with a correctly prefixed actor
- The per-entity activity reader returns events in order for a referral with a full lifecycle

**Regression tests:**
- The existing PRD-01 … PRD-15 test suites pass unchanged after each child PRD

---

## Deliverables

- This epic document
- 14 child PRDs (PRD-17 … PRD-30), each independently refinable and independently implementable
- Updates to [[📋 PRD Index]], [[../Backlog & Ideas/In Progress|In Progress]] and
  [[../Backlog & Ideas/Ideas|Ideas]]

No application code. Per `CLAUDE.md`, each child PRD is implemented on its own
`prd-<number>-<slug>` branch after it has been refined.

---

## Related Documents

- [[📋 PRD Index|PRD Index]]
- [[../Architecture/Technical Architecture|Technical Architecture]]
- [[../Architecture/360X Workflow Overview|360X Workflow Overview]]
- [[PRD-13 - Department Classification]] — routing basis reused by PRD-20
- [[PRD-14 - Analytics Agent (Phase 1)]] — the event log reused by PRD-25
- [[../Backlog & Ideas/Ideas|Ideas & Future Features]]
- Source: `360x_Software_Collaboration_Enhancements.docx` (competitive landscape + MVP recommendation)

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-14  
**Version:** 1.0
