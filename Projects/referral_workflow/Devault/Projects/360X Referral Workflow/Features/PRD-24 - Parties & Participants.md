---
up: "[[📋 PRD Index]]"
prev: "[[PRD-23 - Document Collection]]"
---

# PRD-24: Parties & Participants

**Status:** Ready for Dev  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

A 360X referral involves at least two organizations and, on the Concord side, several people. The
system records neither. The only trace of the other organization is `referrals.referrer_address` — a
single Direct address with no organization name, no role and no capability information. The receiving
organization exists only as configuration (`config.receiving`). Internally, there is no notion of who
besides the owner is involved.

This PRD introduces the two concepts the rest of the epic depends on, and insists they stay distinct:

- **Parties** are the organizations on the referral. Each has a name, a Direct address, a role
  (initiating or receiving), and a protocol mode. A party is not a user of the application; it is a
  counterparty in an exchange. The party's Direct address is what makes protocol emission possible at
  all — a party without one can only be served by local status updates.
- **Participants** are internal staff involved in this workspace beyond the owner, with a role of
  Manager, Collaborator or Viewer — the simplified SFT member model the source document calls for.

Keeping them separate matters because they answer different questions and have different rules. A
party determines where artifacts go and what protocol mode applies. A participant determines who
inside the organization can see and do what, and who gets notified. Collapsing them into one
"members" list is how systems end up accidentally treating an external organization as an internal
user, which is exactly the risk the source document flags.

This PRD is the prerequisite for guest participation (PRD-30) and for the protocol gateway (PRD-29):
the guest mechanism invites a *party*, and the gateway routes artifacts to a *party's* Direct address.

### Goal

The primary goal of this feature is to:
1. Model the **organizations on a referral** explicitly, with their Direct address, role and protocol
   mode, rather than inferring them from a single address column
2. Model the **internal people involved** beyond the owner, with Manager / Collaborator / Viewer roles
3. Render both in the workspace so anyone opening it can see **who is involved on each side**
4. Provide the party and participant lookups that the gateway, guest access, notifications and
   document-access rules all depend on

### Scope

**In Scope:**
- A `workspace_parties` table with organization name, canonical intake Direct address, party role,
  protocol mode
- A `party_addresses` child table recording every Direct address actually observed for a party, so
  one organization's several addresses resolve to one party
- A `workspace_participants` table for internal staff with Manager / Collaborator / Viewer roles
- Seeding both on workspace creation: the initiating party from `referrals.referrer_address`, the
  receiving party from `config.receiving`, and the owner as a Manager participant
- A `backfillParties()` script and route for the workspaces that already exist
- Adding, editing and removing participants; editing party details including protocol mode
- The parties and participants panel in the `#wsParticipants` slot
- Protocol mode resolution: `native-360x`, `workspace-mediated` or `local-only`
- Lookups: participants of a workspace, parties of a workspace, party by Direct address

**Out of Scope:**
- Guest invitations and external access — PRD-30 invites a party but does not belong here
- Artifact rendering and delivery — PRD-29
- Enforcing participant roles as authorization; this PRD stores and displays them, PRD-30 and PRD-20
  enforce access
- A global organization directory or address book; parties are per-workspace rows, and a shared
  directory is a later optimisation
- Federated identity of any kind — a party is never a row in `users`
- Multi-party referrals beyond initiating and receiving; the `other` role exists for observers such
  as a payer contact but is not a supported protocol participant

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to see both organizations on a referral so that I know who I am dealing with without opening the raw message

**AC1:** The workspace shows the initiating and receiving party with organization name, Direct address
and party role.  
**AC2:** Parties are seeded automatically on workspace creation — the initiating party from
`referrals.referrer_address`, the receiving party from `config.receiving` — with no manual step.  
**AC3:** A party with no organization name available shows the Direct address domain as a provisional
name and is flagged as unverified rather than left blank. This applies to the **initiating** party
only: the receiving party is our own organization, and naming ourselves by guessing at our own domain
would be absurd, so its name comes from the new `config.receiving.orgName` and is verified from the
start.  
**AC3a:** `backfillParties()` seeds parties for workspaces that already exist, is idempotent on
`(workspace_id, party_role)`, and **re-derives for workspaces it has already seen** rather than
skipping them. Party seeding lives in `createWorkspace()`, which `backfillWorkspaces()` only calls
for workspaces it is creating — so without this the demo's existing workspaces would show an empty
panel forever. This is the same defect that shipped in PRD-18's first backfill; the AC exists so it
does not ship twice.  
**AC4:** Party details are editable by a Manager participant, and every edit is audited.

### As a care coordinator, I want to know whether the other side can actually receive 360X messages so that I know what will happen when I act

**AC5:** Each party displays its protocol mode with a plain-language explanation: their own system
speaks 360X; they work inside this workspace; or they have no Direct address so updates stay local.  
**AC6:** A party with no Direct address resolves to `local-only` and cannot be set to any other mode
until an address is supplied.  
**AC7:** Protocol mode is settable manually and records who set it and when, so an incorrect
auto-detection can always be corrected.  
**AC8:** `capability_verified_at` is set when a party's mode has been confirmed by an actual
successful exchange (written by PRD-29), and the panel distinguishes "assumed" from "verified".

### As a care coordinator, I want to add colleagues to a referral so that the people helping me can see it and be notified

**AC9:** A participant can be added by choosing a user and a role of Manager, Collaborator or Viewer.  
**AC10:** The workspace owner is automatically a Manager participant, and cannot be removed while they
are the owner.  
**AC11:** Removing a participant is audited and does not delete anything they authored.  
**AC12:** The same user cannot be added twice; changing their role updates the existing row.
Re-adding a **previously removed** participant revives their row by clearing `removed_at` rather than
inserting a second one, so the unique constraint is `(workspace_id, user_id)` with `removed_at` out
of it. Their history lives in the `participant_added` / `participant_removed` events, not in
duplicate rows — the same position PRD-21 takes, where the audit log is the record and the table
holds current state.

### As an engineer, I want reliable party and participant lookups so that the gateway, guest access and notifications all resolve the same answers

**AC13:** `getParties(workspaceId)` returns parties ordered initiating, receiving, other.  
**AC14:** `getParticipants(workspaceId)` returns participants with their user details resolved.  
**AC15:** `findPartyByDirectAddress(workspaceId, address)` matches case-insensitively, because Direct
addresses arrive with inconsistent casing, and resolves in three steps: the party's canonical intake
address, then any address in `party_addresses`, then the address's **domain** against the domains of
the party's known addresses. The domain step is what lets a first message from a departmental or
per-clinician address correlate instead of raising a PRD-28 exception; it returns the party with a
`matchedOn: 'domain'` marker so the caller can tell an exact match from an inferred one.  
**AC15a:** An inbound message from an address not yet on file records that address against the
matched party, with the message that introduced it. The observation point is
`recordThreadMessage()` — the single funnel all nine messaging services already call — so no
individual service learns about parties.  
**AC15b:** Two parties on one workspace may never claim the same address. Uniqueness is enforced on
`party_addresses.(workspace_id, lower(address))` rather than on the party row, because that is the
table that now holds every address.  
**AC16:** `resolveNotificationRecipients(workspaceId)` returns the owner plus all participants, with
Viewers included and parties excluded — parties are notified only through PRD-30.

---

## Technical Specifications

### Dependencies

- [[PRD-17 - Identity & Acting User]] — `users` for participants
- [[PRD-18 - Workspace Entity & Dual Status]] — workspace rows to attach to
- [[PRD-19 - Workspace Shell]] — the `#wsParticipants` slot
- `src/config.ts` — `config.receiving` for the receiving party's identity

### Engineering Constraints

- **Parties and participants are separate tables and must stay separate.** A party must never be
  insertable into `users` or `workspace_participants`. This is the concrete mechanism that keeps the
  source document's "external organizations are not workspace users" position true even though
  PRD-30 lets them act.
- Direct addresses are compared case-insensitively and stored as received, so the original form is
  preserved for the audit record. The comparison uses a `lower(address)` **expression index** — the
  first in this schema, since every existing index is over plain columns. **Verified rather than
  assumed:** `drizzle-kit` 0.27 emits
  `CREATE UNIQUE INDEX ... ON party_addresses (workspace_id, lower("address"))` for a mixed
  column-plus-expression index, and SQLite enforces it — an insert of `echen@lakeside.direct`
  against a stored `ECHen@Lakeside.Direct` fails with
  `UNIQUE constraint failed: index 'idx_party_addresses_unique'`. So no normalise-on-write and no
  generated column are needed. `schema.ts` will need `sql` from `drizzle-orm` and `uniqueIndex` from
  `drizzle-orm/sqlite-core`, neither of which it imports today.
- **Address cardinality — decided.** A party holds a **canonical intake address** on
  `workspace_parties.direct_address` (what PRD-29 sends *to*) plus every address ever seen from it in
  a `party_addresses` child table. An organization receives a domain or subdomain from its HISP and
  provisions addresses at whatever granularity it chooses — organizational intake, departmental,
  per-clinician, often all at once — so one column cannot model it, and `findPartyByDirectAddress()`
  is the thing that breaks: a follow-up from a clinician's own address would fail to correlate.
  `party_addresses` self-populates from observed traffic and therefore needs no admin UI. Internal
  users have their own addresses on `users.direct_address` (PRD-17); that is additive to the
  organization's, not a substitute for it.
- **`referral_messages.sender_address` already records every address, in both directions** — inbound
  from `referralService.ts:145`, outbound from `config.receiving.directAddress` in five services. So
  `party_addresses` is not speculative: `SELECT DISTINCT sender_address FROM referral_messages WHERE
  referral_id = ? AND direction = 'inbound'` is both its derivation rule and its backfill source for
  workspaces that already have message history.
- **`createWorkspace(referralId)` does not load the referral**, so `seedParties()` reads
  `referrals.referrer_address` itself rather than receiving it. Stated because the obvious
  alternative — widening `createWorkspace`'s signature — would touch its two existing callers for no
  gain.
- **`config.receiving` carries only `directAddress` today.** Add `orgName`
  (`RECEIVING_ORG_NAME`, and to `.env.example`) so the receiving party has a real name. Without it
  the only available name for our own organization is a guess at our own domain.
- **`referrals.referrer_address` is `notNull`, so a missing address is unreachable** — but
  `messageProcessor.ts:23` defaults the parsed From header to `''`, so an *empty* address is
  reachable and is what "malformed" concretely means here. Handle `''`, not null.
- **`workspaceView.ts` already holds this PRD's three placeholders**: `PartySummary =
  Record<string, never>` (line 49), `parties: []` (line 242) and `slots.participants: false` (line
  270). Those are the three sites to flip, exactly as PRD-21 flipped `slots.owner`.
- `referrals.referrer_address` remains the protocol reply-to. The party row is derived from it, not a
  replacement for it — the existing outbound paths keep reading the referral column.
- Protocol mode has exactly the three values in the epic. Do not add a fourth for "fax" — a fax-only
  counterparty is `local-only` with a note, because nothing in this codebase sends faxes.
- Roles are stored, not enforced, by this PRD. Say so explicitly in the code comments so a later
  reader does not assume `Viewer` is a security boundary before PRD-30 and PRD-20 make it one.
- Seeding runs inside `createWorkspace()` so a workspace never exists without its parties.

### Data Models

```typescript
// src/db/schema.ts — new
export const workspaceParties = sqliteTable(
  'workspace_parties',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),
    orgName: text('org_name'),                       // null => provisional, derive from domain
    orgNameVerified: integer('org_name_verified', { mode: 'boolean' }).notNull().default(false),
    directAddress: text('direct_address'),           // CANONICAL INTAKE; null => local-only
    partyRole: text('party_role').notNull(),         // 'initiating' | 'receiving' | 'other'
    protocolMode: text('protocol_mode').notNull().default('local-only'),
                                                     // 'native-360x' | 'workspace-mediated' | 'local-only'
    protocolModeSetBy: text('protocol_mode_set_by'), // actor string; null => auto-resolved
    capabilityVerifiedAt: integer('capability_verified_at', { mode: 'timestamp' }),
    contactName: text('contact_name'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_parties_workspace').on(table.workspaceId, table.partyRole),
    // Lowercase expression index: addresses are stored as received but matched
    // case-insensitively. See the constraint above on drizzle-kit support.
    addressIdx: index('idx_workspace_parties_address').on(sql`lower(${table.directAddress})`),
  }),
);

/**
 * Every Direct address ever observed for a party, beyond its canonical intake.
 *
 * Self-populating from `recordThreadMessage()`, so it needs no admin UI: an
 * organization that provisions a new departmental address simply shows up with
 * it, and the next message from that address correlates on an exact match
 * instead of falling back to the domain.
 */
export const partyAddresses = sqliteTable(
  'party_addresses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // Denormalised from the party so uniqueness can be scoped per workspace.
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),
    partyId: integer('party_id').references(() => workspaceParties.id).notNull(),
    address: text('address').notNull(),              // stored as received
    addressKind: text('address_kind'),               // 'intake' | 'departmental' | 'individual' | null => unknown
    // The message that introduced this address, so the panel can say when and
    // in what it first appeared. Null for a seeded canonical intake.
    firstSeenMessageId: integer('first_seen_message_id').references(() => referralMessages.id),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    partyIdx: index('idx_party_addresses_party').on(table.partyId),
    // AC15b: two parties on one workspace may never claim the same address.
    uniqueIdx: uniqueIndex('idx_party_addresses_unique')
      .on(table.workspaceId, sql`lower(${table.address})`),
  }),
);

export const workspaceParticipants = sqliteTable(
  'workspace_participants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),
    userId: integer('user_id').references(() => users.id).notNull(),
    role: text('role').notNull(),                    // 'Manager' | 'Collaborator' | 'Viewer'
    addedByUserId: integer('added_by_user_id').references(() => users.id),
    addedAt: integer('added_at', { mode: 'timestamp' }).notNull(),
    removedAt: integer('removed_at', { mode: 'timestamp' }),   // soft removal, preserves history
  },
  (table) => ({
    workspaceIdx: index('idx_workspace_participants_workspace').on(table.workspaceId, table.removedAt),
    userIdx: index('idx_workspace_participants_user').on(table.userId, table.removedAt),
  }),
);
```

```typescript
// src/modules/workspace/partyService.ts — new
export type PartyRole = 'initiating' | 'receiving' | 'other';
export type ProtocolMode = 'native-360x' | 'workspace-mediated' | 'local-only';

export interface Party {
  id: number; workspaceId: number;
  orgName: string;                  // resolved: stored name, or derived from the address domain
  orgNameVerified: boolean;
  directAddress: string | null;
  partyRole: PartyRole;
  protocolMode: ProtocolMode;
  capabilityVerifiedAt: Date | null;
  contactName: string | null;
}

export interface PartyMatch {
  party: Party;
  /** How it resolved. A domain match is an inference, not an identification. */
  matchedOn: 'intake' | 'known-address' | 'domain';
}

/** Reads `referrals.referrer_address` itself — createWorkspace does not load the referral. */
export async function seedParties(workspaceId: number, referralId: number): Promise<Party[]>;
export async function getParties(workspaceId: number): Promise<Party[]>;
/** Intake, then known addresses, then domain (AC15). Null when none of the three hit. */
export async function findPartyByDirectAddress(
  workspaceId: number, address: string,
): Promise<PartyMatch | null>;
/** Called from recordThreadMessage(); a no-op when the address is already on file. */
export async function recordPartyAddress(
  workspaceId: number, address: string, messageId: number | null,
): Promise<void>;
/** Idempotent on (workspaceId, partyRole); re-derives for workspaces already seen (AC3a). */
export async function backfillParties(): Promise<{ created: number; updated: number; skipped: number }>;
export async function updateParty(
  partyId: number, patch: Partial<Pick<Party, 'orgName' | 'directAddress' | 'contactName'>>, actor: string,
): Promise<Party>;
export async function setProtocolMode(partyId: number, mode: ProtocolMode, actor: string): Promise<Party>;
/** Written by PRD-29 after a successful exchange. */
export async function markCapabilityVerified(partyId: number, mode: ProtocolMode): Promise<Party>;
```

```typescript
// src/modules/workspace/participantService.ts — new
export type ParticipantRole = 'Manager' | 'Collaborator' | 'Viewer';

export interface Participant {
  id: number; userId: number; displayName: string; jobRole: JobRole;
  role: ParticipantRole; addedAt: Date; addedByDisplayName: string | null;
}

export async function getParticipants(workspaceId: number): Promise<Participant[]>;
export async function addParticipant(
  workspaceId: number, userId: number, role: ParticipantRole, actor: ActingUser,
): Promise<Participant>;
export async function removeParticipant(workspaceId: number, userId: number, actor: ActingUser): Promise<void>;
export async function resolveNotificationRecipients(workspaceId: number): Promise<number[]>;
```

Migration: `0013_add_parties_and_participants.sql` — 0013 confirmed next free (0012 is PRD-18).

Audit events: `workspace.party_seeded`, `workspace.party_updated`,
`workspace.protocol_mode_changed`, `workspace.party_address_observed`,
`workspace.participant_added`,
`workspace.participant_role_changed`, `workspace.participant_removed`.

### API Design

**Endpoint:** `GET /api/workspaces/:id/parties` → `{ "parties": [Party] }`

**Endpoint:** `PATCH /api/workspaces/:id/parties/:partyId`
```json
{ "orgName": "Lakeside Cardiology", "directAddress": "referrals@lakeside.direct.example.org" }
```
`409` when setting a protocol mode other than `local-only` on a party with no Direct address.

**Endpoint:** `POST /api/workspaces/:id/parties/:partyId/protocol-mode`
```json
{ "protocolMode": "workspace-mediated" }
```

**Endpoint:** `GET /api/workspaces/:id/participants` → `{ "participants": [Participant] }`

**Endpoint:** `POST /api/workspaces/:id/participants`
```json
{ "userId": 4, "role": "Collaborator" }
```
Idempotent on `userId`: an existing participant has their role updated rather than duplicated.

**Endpoint:** `DELETE /api/workspaces/:id/participants/:userId` — `409` if the user is the current
owner.

---

## Test Plan

**Unit Tests:**
- `seedParties()` creates an initiating party from the referrer address and a receiving party from
  config, with correct roles
- A party with no Direct address resolves to `local-only`; `setProtocolMode()` to another mode throws
- `orgName` falls back to the address domain and reports `orgNameVerified: false`
- `findPartyByDirectAddress()` matches regardless of case
- `findPartyByDirectAddress()` resolves intake, then a known address, then domain, and reports which
  via `matchedOn` — three separate tests, because a domain match must not be mistaken for an
  identification
- `findPartyByDirectAddress()` returns null when the domain matches nothing on the workspace
- `recordPartyAddress()` is a no-op for an address already on file, and bumps `last_seen_at`
- `recordPartyAddress()` rejects an address already claimed by a different party on that workspace
- `backfillParties()` seeds a workspace that has none, and **re-derives one it has already seen**
  rather than skipping — the PRD-18 backfill defect, asserted directly
- `backfillParties()` recovers observed addresses from existing `referral_messages` history
- The receiving party takes its name from `config.receiving.orgName` and is verified, while the
  initiating party falls back to its domain and is not
- `addParticipant()` on an existing participant updates the role instead of inserting
- `removeParticipant()` on the current owner throws
- `removeParticipant()` sets `removed_at` rather than deleting, and the user disappears from
  `getParticipants()`
- `resolveNotificationRecipients()` includes owner and all roles, excludes removed participants and
  excludes parties

**Integration Tests:**
- Create a workspace from ingest and assert both parties and the owner-as-Manager participant exist
- Edit a party name and protocol mode and assert both audit events with the acting actor
- Add a Collaborator and a Viewer, remove the Collaborator, and assert the participant panel and the
  activity feed agree

**Edge Cases:**
- `referrals.referrer_address` is the empty string — reachable because `messageProcessor.ts:23`
  defaults an unparseable From header to `''`. The column is `notNull`, so null is NOT a reachable
  case and no test should pretend otherwise
- An address with no `@`, or an `@` with nothing after it — domain derivation returns no domain and
  the party stays provisional rather than throwing
- Receiving config absent — receiving party created as `local-only` with a provisional name
- Direct address arriving in mixed case across messages — one party row and one `party_addresses`
  row, not two of either
- A participant whose user row is later deactivated — still listed, marked inactive (the same
  `ActingUser.active` path PRD-21 uses for a deactivated owner)
- A participant removed and then re-added — one row, revived, not two
- Two parties with the same Direct address on one workspace — rejected at `party_addresses`

**Regression:**
- Outbound paths continue to read `referrals.referrer_address`; PRD-01 … PRD-07 suites unchanged

---

## Deliverables

- `workspace_parties`, `party_addresses`, `workspace_participants` in `src/db/schema.ts` + migration
  `0013_add_parties_and_participants.sql`
- `config.receiving.orgName` in `src/config.ts` and `.env.example`
- `recordPartyAddress()` hooked into `recordThreadMessage()`
- `backfillParties()` plus its script and route, alongside the PRD-18 backfill
- `src/modules/workspace/partyService.ts`, `src/modules/workspace/participantService.ts`
- Party seeding wired into `createWorkspace()`
- Party and participant routes listed above
- Parties & participants panel in the `#wsParticipants` slot
- `tests/unit/workspace/partyService.test.ts`,
  `tests/unit/workspace/participantService.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-18 - Workspace Entity & Dual Status]], [[PRD-19 - Workspace Shell]] — prerequisites
- [[PRD-30 - Guest Participation]] — invites a party
- [[PRD-29 - 360X Protocol Gateway]] — delivers to a party's Direct address, verifies capability
- [[PRD-23 - Document Collection]] — document access rules use participants
- [[PRD-27 - Notifications]] — uses `resolveNotificationRecipients()`
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-15  
**Version:** 1.0 — first draft.

**Version:** 1.1 — Ready for Dev, after a codebase pass against the shipped PRD-17/18/19/21.

**The address cardinality is resolved**, which was this PRD's one recorded blocker. A party now holds
a canonical intake address plus a `party_addresses` child table of every address observed from it,
and `findPartyByDirectAddress()` resolves intake → known address → domain, reporting which. The
domain step is the part that earns its keep: without it a follow-up from a clinician's own address
raises a PRD-28 correlation exception instead of landing on the right workspace. The table
self-populates from `recordThreadMessage()`, so it needs no admin UI.

**The backfill gap is the finding most likely to have shipped as a bug.** Party seeding lives in
`createWorkspace()`, and `backfillWorkspaces()` only calls that for workspaces it is *creating* —
existing ones take a `continue` path. Every workspace in the demo would have shown an empty parties
panel forever. That is precisely the defect that shipped in PRD-18's first backfill and had to be
fixed mid-session, so AC3a now requires re-derivation and a test asserts it.

**Corrections to what the draft assumed:**

- **`config.receiving` has no organization name**, only `directAddress`. The draft had the receiving
  party seeded "from `config.receiving`", which could only have produced a provisional name guessed
  from our own domain. Adds `config.receiving.orgName`, and confines AC3's domain fallback to the
  initiating party.
- **`referrals.referrer_address` is `notNull`**, so the draft's "malformed or missing" edge case was
  half unreachable. `messageProcessor.ts:23` defaults an unparseable From header to `''`, so the real
  case is an empty string.
- **The data model contradicted its own constraint** — the constraint asked for a lowercase index
  expression while the schema showed a plain column index. Now an expression index, with a note that
  it would be the first in this schema and that `drizzle-kit`'s SQLite output should be confirmed
  before relying on it.
- **`createWorkspace(referralId)` does not load the referral**, so `seedParties()` reads the referrer
  address itself rather than having the signature widened.
- **AC12 was ambiguous against soft removal.** Re-adding a removed participant now revives the row,
  with the audit events as the history.

**Found already in place, which changed the design rather than the doc:**
`referral_messages.sender_address` has been recording every address in both directions all along, so
`party_addresses` has a real backfill source rather than only populating going forward; and
`recordThreadMessage()` is a single funnel called by nine services, so address observation hooks in
one place instead of nine.
