---
up: "[[📋 PRD Index]]"
prev: "[[PRD-23 - Document Collection]]"
---

# PRD-24: Parties & Participants

**Status:** Drafting  
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
- A `workspace_parties` table with organization name, Direct address, party role, protocol mode
- A `workspace_participants` table for internal staff with Manager / Collaborator / Viewer roles
- Seeding both on workspace creation: the initiating party from `referrals.referrer_address`, the
  receiving party from `config.receiving`, and the owner as a Manager participant
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
name and is flagged as unverified rather than left blank.  
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

### As an engineer, I want reliable party and participant lookups so that the gateway, guest access and notifications all resolve the same answers

**AC13:** `getParties(workspaceId)` returns parties ordered initiating, receiving, other.  
**AC14:** `getParticipants(workspaceId)` returns participants with their user details resolved.  
**AC15:** `findPartyByDirectAddress(workspaceId, address)` performs a case-insensitive match, because
Direct addresses arrive with inconsistent casing.  
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
- Direct addresses are compared case-insensitively and stored as received. Add a lowercase index
  expression rather than normalising on write, so the original form is preserved for the audit record.
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
    directAddress: text('direct_address'),           // null => local-only
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
    addressIdx: index('idx_workspace_parties_address').on(table.directAddress),
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

export async function seedParties(workspaceId: number, referralId: number): Promise<Party[]>;
export async function getParties(workspaceId: number): Promise<Party[]>;
export async function findPartyByDirectAddress(workspaceId: number, address: string): Promise<Party | null>;
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

Migration: `0013_add_parties_and_participants.sql`.

Audit events: `workspace.party_seeded`, `workspace.party_updated`,
`workspace.protocol_mode_changed`, `workspace.participant_added`,
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
- `referrals.referrer_address` malformed or missing a domain — provisional name handling, no crash
- Receiving config absent — receiving party created as `local-only` with a provisional name
- Direct address arriving in mixed case across messages — one party row, not two
- A participant whose user row is later deactivated — still listed, marked inactive
- Two parties with the same Direct address on one workspace — rejected

**Regression:**
- Outbound paths continue to read `referrals.referrer_address`; PRD-01 … PRD-07 suites unchanged

---

## Deliverables

- `workspace_parties`, `workspace_participants` in `src/db/schema.ts` + migration
  `0013_add_parties_and_participants.sql`
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
**Last Updated:** 2026-09-14  
**Version:** 1.0
