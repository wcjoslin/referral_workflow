---
up: "[[📋 PRD Index]]"
prev: "[[PRD-29 - 360X Protocol Gateway]]"
---

# PRD-30: Guest Participation & Secure Invitations

**Status:** Drafting  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

A referral has two sides, and until now only one of them can see anything. The receiving
organization's only window into a referral is whatever Direct messages arrive in their inbox. If they
have a question, they telephone. If the coordinator has a question, they telephone back. The source
document identifies precisely this as the most differentiated pattern in the adjacent market: Unite
Us lets users at partner organizations communicate based on a shared referral, which "removes the
separate task of locating contacts and gives the receiving organization a direct way to request
information."

This PRD lets a party be invited into a single workspace and act inside it. That is what makes the
protocol gateway (PRD-29) meaningful — without guest access, the gateway only serves the licensed
side, and the counterparty still needs their own 360X implementation to participate.

The design constraint that matters most here is scope. An invitation grants access to **one
workspace**, for **one referral**, for **one patient**, with an expiry. It is not an account. A guest
cannot browse other workspaces, cannot see a queue, cannot see internal comments, cannot see another
patient, and has no presence in the application outside the workspace they were invited to. This is
how the epic can extend the source document's position — external parties become acting participants
— without taking on federated identity, and without turning a referral invitation into a standing
door into PHI.

A guest is deliberately **not** a row in `users`. Internal staff and external guests have different
lifecycles, different scoping and different audit requirements, and merging them is how an external
party accidentally ends up in an internal picker.

### Goal

The primary goal of this feature is to:
1. Let a coordinator **invite a party into one workspace** with a scoped, expiring, revocable link
2. Give that guest a **workspace view containing only what they are entitled to see**, with internal
   material structurally absent rather than hidden
3. Let a guest **act** — post shared comments, upload documents, and make the 360X assertions their
   party role permits
4. Make every guest action and every guest **read** auditable, since access to PHI by an external
   party is the thing a compliance reviewer will ask about first

### Scope

**In Scope:**
- Invitations: create, deliver by email, accept, expire, revoke, re-issue
- A guest identity distinct from `users`, scoped to one workspace and bound to one party
- A guest workspace view: header, protocol timeline, shared comments, shared documents, available
  assertions
- Guest actions: post shared comments, upload documents, submit assertions (through PRD-29)
- Access enforcement: a guest request can only ever resolve to its own workspace, and only to
  shared-visibility material
- Audit of guest invitation, acceptance, every action and every document view
- Expiry and revocation taking effect immediately, including mid-session

**Out of Scope:**
- Passwords, SSO, guest self-registration, guest profile management
- A guest account spanning multiple workspaces or a guest "inbox" of their referrals — each
  invitation is independent, and a cross-workspace guest portal is a later phase
- Internal comments, work status, queues, assignment, participants, analytics, other patients —
  none of these are reachable by a guest by any route
- Artifact rendering and delivery — PRD-29
- Patient or caregiver access — explicitly excluded by the epic
- Rate limiting and abuse protection beyond token expiry; a production deployment needs more and the
  PRD should say so

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to invite the receiving organization into this referral so that they can respond without me phoning them

**AC1:** A Manager participant can invite a party by choosing the party and supplying a recipient
email address; the party's Direct address is offered as the default recipient.  
**AC2:** The invitation is delivered through the existing SMTP transport and contains a single-use
tokenized link, the patient's name, the referring organization, and an expiry date.  
**AC3:** The invitation link resolves to the workspace without a password.  
**AC4:** Creating an invitation emits `workspace.guest_invited`; accepting it emits
`workspace.guest_accepted` with the accepting party.

### As an invited specialist, I want to see the referral and respond, so that I can accept or decline without implementing a protocol

**AC5:** The guest view shows the workspace header, the protocol timeline, shared comments, shared
documents, and the assertions available to their party role — and nothing else.  
**AC6:** The guest view contains no internal comment, work status, owner, queue, participant, or
other-patient data — asserted by inspecting the served payload, not by CSS.  
**AC7:** A guest can post a comment, and it is created with `Shared` visibility with no option to
choose `Internal`.  
**AC8:** A guest can upload a document, and it is created with `Shared` visibility and never
transmitted until 360X context is attached to it.  
**AC9:** A guest can submit an assertion permitted for their party role, and it flows through the
PRD-29 gateway identically to a licensed user's assertion.

### As a compliance reviewer, I want every external access to PHI recorded so that I can answer who saw what

**AC10:** Every guest document view writes an audit event naming the guest, the party, the document
and the time.  
**AC11:** Every guest action records the guest, the party they acted for, and the invitation used.  
**AC12:** The workspace activity feed distinguishes guest actions from internal actions visibly, and
the activity feed shown *to* the guest omits internal events.

### As a care coordinator, I want to cut off access when the referral is done or the invitation was a mistake, so that access does not outlive its purpose

**AC13:** Revoking an invitation takes effect on the next request, including for a guest with the page
already open, who receives a clear "access ended" state rather than a broken page.  
**AC14:** An expired invitation cannot be used, and the expired link explains how to request a new
one rather than 404ing silently.  
**AC15:** Re-issuing an invitation invalidates the previous token.  
**AC16:** A default expiry is configured centrally and every invitation has one — an invitation with
no expiry cannot be created.

### As an engineer, I want guest scoping enforced in one place, so that no future route can accidentally widen it

**AC17:** All guest routes resolve through a single guard that maps a token to exactly one
`(workspaceId, partyId)` pair, and no guest route accepts a workspace id from the client.  
**AC18:** A guest request carrying a valid token but a mismatched workspace in the path is rejected,
not served.  
**AC19:** A guest identity can never be inserted into `users`, and no internal picker
(owner, participant, mention) returns a guest.

---

## Technical Specifications

### Dependencies

- [[PRD-24 - Parties & Participants]] — an invitation invites a party (hard prerequisite)
- [[PRD-18 - Workspace Entity & Dual Status]], [[PRD-19 - Workspace Shell]] — the workspace to scope to
- [[PRD-29 - 360X Protocol Gateway]] — the assertion path a guest uses
- [[PRD-22 - Referral Conversation]] — shared comments
- [[PRD-23 - Document Collection]] — shared documents and upload
- `nodemailer` via the existing SMTP transport for invitation delivery
- Node `crypto` for token generation — no new dependency

### Engineering Constraints

- **One guard, one scope.** Every guest route goes through a single `requireGuest()` middleware that
  resolves the token to one `(workspaceId, partyId)` and attaches it to the request. No guest handler
  reads a workspace id from the path or body. This is the single most important constraint in the PRD;
  it is what makes AC17–AC19 enforceable rather than aspirational.
- **Omit, do not hide.** The guest payload is built by a dedicated function that constructs only
  guest-visible fields. It must not be the internal payload with fields deleted, and it must not rely
  on the client to hide anything.
- Guests are a separate table. A guest is never a `users` row, never appears in `GET /api/users`, and
  never appears in the owner, participant or internal mention pickers.
- Tokens are high-entropy, stored hashed, single-use for acceptance and then exchanged for a
  workspace-scoped session cookie with the same expiry as the invitation. A raw token is never
  logged, never written to the audit metadata, and never included in an error message.
- Revocation and expiry are checked **per request**, not at acceptance. A revoked guest with an open
  page loses access on their next call.
- Guest-authored content defaults to `Shared` and the API rejects an attempt to set `Internal` —
  visibility is not a client choice for a guest.
- Invitation email content must not include clinical detail beyond the patient name and referring
  organization; the referral content lives behind the link, not in the mail.
- Rate limiting is out of scope but the absence must be documented as a production gap in the PRD's
  own engineering constraints, so it is not mistaken for a completed control.

### Data Models

```typescript
// src/db/schema.ts — new
export const workspaceInvitations = sqliteTable(
  'workspace_invitations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),
    partyId: integer('party_id').references(() => workspaceParties.id).notNull(),
    recipientEmail: text('recipient_email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),     // hash only; the raw token is never stored
    invitedByUserId: integer('invited_by_user_id').references(() => users.id).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    revokedByUserId: integer('revoked_by_user_id').references(() => users.id),
    supersededById: integer('superseded_by_id'),          // set when re-issued
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_invitations_workspace').on(table.workspaceId, table.revokedAt),
    tokenIdx: index('idx_workspace_invitations_token').on(table.tokenHash),
  }),
);

export const workspaceGuests = sqliteTable(
  'workspace_guests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    invitationId: integer('invitation_id').references(() => workspaceInvitations.id).notNull(),
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),
    partyId: integer('party_id').references(() => workspaceParties.id).notNull(),
    displayName: text('display_name'),                    // self-supplied on acceptance, optional
    sessionTokenHash: text('session_token_hash'),
    sessionExpiresAt: integer('session_expires_at', { mode: 'timestamp' }),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_guests_workspace').on(table.workspaceId),
    sessionIdx: index('idx_workspace_guests_session').on(table.sessionTokenHash),
  }),
);
```

```typescript
// src/modules/workspace/invitationService.ts — new
export class InvitationExpiredError extends Error {}
export class InvitationRevokedError extends Error {}
export class InvitationScopeMismatchError extends Error {}

export interface Invitation {
  id: number; workspaceId: number; partyId: number; partyOrgName: string;
  recipientEmail: string; expiresAt: Date;
  acceptedAt: Date | null; revokedAt: Date | null;
  invitedByDisplayName: string;
}

export async function createInvitation(
  workspaceId: number, partyId: number, recipientEmail: string, actor: ActingUser, expiresInHours?: number,
): Promise<{ invitation: Invitation; inviteUrl: string }>;   // raw token appears only in inviteUrl
export async function listInvitations(workspaceId: number): Promise<Invitation[]>;
export async function revokeInvitation(invitationId: number, actor: ActingUser): Promise<void>;
export async function reissueInvitation(
  invitationId: number, actor: ActingUser,
): Promise<{ invitation: Invitation; inviteUrl: string }>;
export async function acceptInvitation(
  rawToken: string, displayName?: string,
): Promise<{ guest: GuestContext; sessionToken: string }>;
```

```typescript
// src/modules/workspace/guestAccess.ts — new
export interface GuestContext {
  guestId: number;
  workspaceId: number;       // the only workspace this guest can ever reach
  partyId: number;
  partyRole: PartyRole;
  partyOrgName: string;
  displayName: string | null;
  expiresAt: Date;
}

/** The single guard. Resolves the session cookie; throws on expiry, revocation or scope mismatch. */
export async function requireGuest(req: Request, pathWorkspaceId?: number): Promise<GuestContext>;

export function formatGuestActor(guest: GuestContext): string;   // => `guest:${guest.guestId}`

/** Built from scratch — never the internal payload with fields removed. */
export async function buildGuestPayload(guest: GuestContext): Promise<GuestWorkspacePayload>;

export interface GuestWorkspacePayload {
  workspace: { referralState: ReferralState; patientName: string; patientDob: string;
               reasonForReferral: string | null; initiatingOrg: string; receivingOrg: string };
  protocolTimeline: TimelineStep[];
  sharedComments: SharedComment[];
  sharedDocuments: SharedDocument[];
  availableAssertions: AssertionSpec[];
  party: { orgName: string; partyRole: PartyRole; protocolMode: ProtocolMode };
  guest: { displayName: string | null; expiresAt: string };
}
```

Note the absence: no `workStatus`, no `ownerUserId`, no `queueId`, no `nextAction`, no participants,
no internal comments, no `exceptionReason`. That absence is the security control.

Migration: `0019_add_guest_participation.sql`.
Config: `config.workspace.guestInvitationExpiryHours` (default 336 — 14 days) and
`config.workspace.guestSessionExpiryHours` (default 24).

Audit events: `workspace.guest_invited`, `workspace.guest_reissued`, `workspace.guest_revoked`,
`workspace.guest_accepted`, `workspace.guest_action`, `workspace.guest_document_viewed`,
`workspace.guest_access_denied`.

### API Design

**Internal (licensed users):**

`POST /api/workspaces/:id/invitations`
```json
{ "partyId": 2, "recipientEmail": "referrals@lakeside.direct.example.org", "expiresInHours": 336 }
```
```json
{ "success": true, "invitationId": 9, "expiresAt": "2026-09-28T00:00:00Z", "emailSent": true }
```
The raw token is never returned to the inviter — it exists only in the delivered email. `403` unless
the acting user is a Manager participant.

`GET /api/workspaces/:id/invitations` → `{ "invitations": [Invitation] }` — status only, no tokens.

`DELETE /api/workspaces/:id/invitations/:invitationId` — revoke, effective immediately.

`POST /api/workspaces/:id/invitations/:invitationId/reissue` — invalidates the previous token.

**Guest-facing:**

`GET /guest/:token` — accept and redirect to the guest workspace, setting the session cookie.
Expired, revoked or unknown tokens render an explanatory page, never a stack trace.

`GET /guest/workspace` — the guest workspace page. Takes no id; the workspace comes from the session.

`GET /api/guest/workspace` → `GuestWorkspacePayload`.

`POST /api/guest/comments` → `{ "body": "..." }` — always `Shared`; an `Internal` visibility in the
body is rejected with `400`.

`POST /api/guest/documents` — upload; always `Shared`, never transmitted without 360X context.

`GET /api/guest/documents/:documentId/content` — `403` unless the document belongs to this workspace
and is `Shared`; every success writes `workspace.guest_document_viewed`.

`POST /api/guest/assertions` — delegates to PRD-29's `submitAssertion()` with the party resolved
from the guest context, never from the request body.

---

## Test Plan

**Unit Tests:**
- `createInvitation()` stores only a hash, and the raw token appears solely in the returned URL
- `createInvitation()` refuses without an expiry and applies the configured default
- `acceptInvitation()` succeeds once, then fails for the same raw token
- `acceptInvitation()` throws `InvitationExpiredError` past expiry and `InvitationRevokedError` after
  revocation
- `requireGuest()` throws on expired session, revoked invitation, and unknown cookie
- `requireGuest()` throws `InvitationScopeMismatchError` when the path workspace differs from the
  session's
- `reissueInvitation()` marks the old row superseded and invalidates its token
- `buildGuestPayload()` output contains none of: `workStatus`, `ownerUserId`, `queueId`, `nextAction`,
  participants, internal comments, `exceptionReason` — asserted by key inspection on the serialized
  payload
- `formatGuestActor()` produces `guest:<id>`
- A guest comment with `visibility: 'Internal'` in the body is rejected

**Integration Tests:**
- Invite, accept, post a shared comment, upload a document, submit an `accept` assertion, and assert
  each appears in the internal workspace with guest attribution
- Revoke mid-session and assert the guest's next request is denied with an access-ended state and a
  `workspace.guest_access_denied` event
- A guest attempting `GET /api/workspaces/:otherId` and `/guest/workspace` with a tampered cookie is
  denied in both cases
- A guest views a shared document and the internal activity feed shows the view with their identity
- `GET /api/users`, the owner picker, the participant picker and the internal mention picker return
  no guests

**Edge Cases:**
- Two invitations outstanding for the same party — the newer supersedes, the older token fails
- Invitation to a party with no Direct address — permitted (they can still collaborate); assertions
  they make are `local-only` per PRD-29
- Guest accepting after the referral reached `Closed-Confirmed` — read access works, assertions are
  empty
- Guest accepting after the workspace is archived — read-only, no actions
- Invitation email fails to send — the invitation is still created and shows as undelivered, with a
  resend action
- Extremely long or malformed token in the path — rejected without a database call

**Security Tests:**
- No raw token in any log line, audit metadata or error response
- A guest session cookie from workspace A cannot read workspace B by any route
- The guest payload is constructed, not filtered — verified by a test that adds a new internal field
  to the internal payload and asserts it does not appear in the guest payload

**Regression:**
- All internal routes reject guest session cookies; internal tests unaffected

---

## Deliverables

- `workspace_invitations`, `workspace_guests` in `src/db/schema.ts` + migration
  `0019_add_guest_participation.sql`
- `src/modules/workspace/invitationService.ts`, `src/modules/workspace/guestAccess.ts`
- `src/views/guestWorkspace.html` — a standalone view, not the internal page with panels hidden
- Internal invitation management in the `#wsParticipants` panel
- Guest and internal routes listed above
- `config.workspace.guestInvitationExpiryHours`, `config.workspace.guestSessionExpiryHours`
- `tests/unit/workspace/invitationService.test.ts`,
  `tests/unit/workspace/guestAccess.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]] — the departures this PRD implements
- [[PRD-24 - Parties & Participants]] — hard prerequisite
- [[PRD-29 - 360X Protocol Gateway]] — what a guest's assertions flow through
- [[PRD-22 - Referral Conversation]] — shared vs internal visibility
- [[PRD-23 - Document Collection]] — shared documents and access logging
- [[PRD-25 - Activity History & Audit]] — guest action and view auditing
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-14  
**Version:** 1.0
