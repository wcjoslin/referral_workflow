---
up: "[[📋 PRD Index]]"
prev: "[[PRD-21 - Ownership & Assignment]]"
---

# PRD-22: Referral Conversation (Dual-Visibility)

**Status:** Refined — ready for implementation  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

There is nowhere to write anything down. The `referral_messages` thread records protocol exchanges —
what was sent and received — but it is entirely machine-authored and read-only in the UI; there is no
POST endpoint, no author model, and no notion of a note. A coordinator who learns something by phone
("the referring office is faxing the missing imaging Tuesday") has no place to put it except the
decline-reason field or a sticky note.

The source document identifies the conversation as the single most differentiated element in the
adjacent market: Unite Us's strongest feature is secure communication with users at partner
organizations *based on a shared referral*, and its lesson is stated directly — "collaboration becomes
materially better when the conversation is attached to the referral rather than to a generic message
channel."

Because the epic admits guests into the workspace (PRD-30), the conversation has to carry two kinds of
speech in one place: internal notes that must never leave the organization, and messages meant for the
other party. This PRD implements one chronological thread with per-comment visibility. That choice
buys continuity — a reader sees the discussion in the order it happened rather than reconstructing it
from two panes — and it costs safety margin, because a single mis-set toggle discloses an internal
note to an external party. Every safety requirement below is therefore an acceptance criterion rather
than a recommendation: `Internal` is the default, `Shared` needs an explicit confirmation, the two are
unmistakably different on screen, and internal comments are structurally absent from the guest
payload rather than filtered out of it.

This PRD also answers an open question the source document leaves standing: whether comment edits are
prohibited or versioned, and how deletion is represented.

Finally, it discharges an obligation PRD-18 left open by name. `workspaceService.ts` documents two
future sources for `hasOpenInternalItems()` — "an unresolved exception (PRD-28) and an unacknowledged
mention (PRD-22)" — and returns `false` because neither existed. This PRD supplies the second, which
makes the `Closed-Confirmed → Follow-up-Required` branch reachable for the first time.

### Goal

The primary goal of this feature is to:
1. Give every workspace **one conversation** attached to the referral, authored by real people
2. Let a comment be **internal to the organization or shared with the other party**, with internal as
   the default and sharing as a deliberate act
3. Make the internal/shared boundary **structural** — internal comments cannot reach a guest or an
   outbound artifact by any code path
4. Settle the **audit semantics**: edits are versioned, deletions are tombstoned, nothing is ever
   hard-deleted
5. Fill **PRD-18's `hasOpenInternalItems()` extension point** with the unacknowledged-mention source
   it was written to receive

### Scope

**In Scope:**
- `referral_comments`, `comment_revisions` and `comment_mentions`: one thread per workspace, authored
  by a user or a guest
- Per-comment `Internal` / `Shared` visibility with an explicit confirmation to share
- Posting, editing (as a new revision), and deleting (as a tombstone)
- `@mentions` resolving to internal users on internal comments and to parties on shared comments
- Mention acknowledgement, and the unacknowledged-mention source for `hasOpenInternalItems()`
- The conversation panel in the `#wsConversation` slot, with visually unmistakable separation
- Guest-authored comments, always `Shared`, with the visibility choice unavailable
- A shared comment's guest-exposure lock, derived from `workspace_guests.lastSeenAt`

**Out of Scope:**
- Real-time delivery, typing indicators, presence — the panel loads and reloads like every other view
- Threaded replies, reactions, attachments on comments (a document is a document, PRD-23)
- Rich text or markdown rendering beyond line breaks and escaped text
- **Interleaving comments with the protocol thread.** The conversation panel shows comments only;
  the unified feed that merges comments, protocol messages and assertions is PRD-25's `#wsActivity`
  panel and is explicitly not built twice.
- Transmitting a shared comment over 360X as a protocol artifact — a shared comment is visible in the
  workspace to an invited guest; sending something to a counterparty is an assertion, PRD-29
- **Guest editing and guest deletion.** A guest posts and reads. An edit surface on the guest API
  adds attack surface to the highest-risk route in the application for no workflow gain; an internal
  user can tombstone a guest's comment if one needs removing.
- Notifying a mentioned user — PRD-27 consumes the events this PRD emits
- A general read-receipt feature. The only read fact this PRD needs already exists as
  `workspace_guests.lastSeenAt`; see the refinement notes.
- Cross-organization chat as a product surface beyond this referral — later phase

---

## Comment model

A comment has two parts, and conflating them is the mistake the first draft made.

**Identity** is the comment: who wrote it, in which workspace, when it first appeared, and whether it
has been tombstoned. Identity never changes. It is what a `PATCH` targets, what a tombstone marks,
and what a mention hangs off.

**Content** is a revision: the body text and the visibility, at one point in time. Content is
append-only. An edit supersedes the current revision and inserts the next one; nothing is overwritten,
so "what did this say, and who could read it, on Tuesday" is answerable.

```
referral_comments   id=41  author=user:5  created=Mon 15:02  deleted_at=NULL
  └── comment_revisions  #1  "Referring office faxing imaging Tuesday"   Internal  superseded=Mon 16:40
  └── comment_revisions  #2  "Referring office faxing imaging Weds"      Internal  superseded=NULL   ← current
```

The current revision is the one with `superseded_at IS NULL`, and a **partial unique index** enforces
that there is exactly one per comment. Two concurrent edits therefore cannot both win: the second is
refused by the database with `CommentRevisionConflictError`, surfaced as `409`. That is a better
answer than the draft's "order preserved by timestamp", which would have left two rows claiming to be
current.

### The share lock

AC9 needs to know whether an external reader has already seen a shared comment, so that a retroactive
downgrade to `Internal` can be refused. **Serving is reading.** A comment is locked once any guest on
the workspace has been active later than the moment it first became shared — `requireGuest()` already
stamps `workspace_guests.lastSeenAt` on every authenticated guest request, so the fact is recorded
without a read-receipt table and without client cooperation.

This is deliberately conservative in the safe direction. A guest who loaded the page and did not
scroll counts as having seen it; a comment with no guests on the workspace at all stays downgradeable,
which is correct, because a comment shared with nobody has been disclosed to nobody. A comment that
was shared, downgraded and shared again locks against the *earliest* share, which over-locks rather
than under-locks.

---

## Refinement decisions

| # | Decision | Effect |
|---|---|---|
| 1 | **Two tables**: identity in `referral_comments`, content in `comment_revisions` | A `PATCH`, a tombstone and a mention all target a stable id; the current thread is one join; per-revision visibility is structural rather than a convention. |
| 2 | **The author edits; anyone internal may tombstone** | Only the author changes their own words. Any internal user can take a comment down and the tombstone records who. A wrongly-shared internal note or a PHI slip can be pulled by whoever notices, not only by whoever wrote it. |
| 3 | **Fill PRD-18's extension point** | `comment_mentions.acknowledged_at`, an async sibling OR-ed into `hasOpenInternalItems()`, and an ack route. A `Closed-Confirmed` referral with an unread mention derives `Follow-up-Required` instead of `Resolved`. |

Resolved without needing a decision:

- **`comment_reads` is not built.** See the share lock above: `workspace_guests.lastSeenAt` already
  carries the only read fact any acceptance criterion needs. The draft's own note warned that the
  table "should not grow into a general read-receipt feature without its own PRD"; not creating it is
  the stronger form of that warning. Its `reader_user_id` column was referenced by no criterion at
  all.
- **Mentions are supplied as resolved ids, not parsed from the body.** The client sends
  `{ users: [3], parties: [2] }` alongside whatever text the author typed. The server validates the
  ids and stores rows; it does not re-derive them from the text on read, so renaming a user does not
  rewrite history, and it does not verify that the body contains matching `@` text, because a
  mismatch there is a harmless client bug rather than a safety problem.
- **Mentions resolve against the whole active roster, not the participant list.** Nothing internally
  restricts which workspaces a user may see, so narrowing mentions to existing participants would
  block the one gesture that matters — pulling in somebody not yet involved.
  `resolveNotificationRecipients()` stays what it is: a *notification* set, not a *mention* set.
- **A tombstoned comment is absent from the guest payload, not marked as deleted.** Internally the
  tombstone is visible, with who and when, because that is the audit record. A `[deleted]` marker in a
  guest's view only invites the question of what it said.
- **The service never returns a tombstoned body.** `listComments()` returns `body: null` for a
  tombstoned comment, so no view can render it by accident. The pre-tombstone text is reachable only
  through the explicit audit path, `getCommentHistory()`, which has no guest route.
- **Comment bodies are capped at 4000 characters.** The most user-controlled string in the
  application should not be unbounded in either the column or the render.
- **`DELETE` returns `200` with the tombstoned comment**, not the draft's `204`, so the panel can
  re-render from the response instead of reloading the thread.

### What the codebase pass changed

Facts the draft got wrong or missed, all verified against the working tree:

1. **`requireGuest()` already maintains the read fact.** `guestAccess.ts:166-169` sets
   `workspace_guests.lastSeenAt` on every authenticated guest request, and `acceptInvitation()`
   (`invitationService.ts:469`) sets it at acceptance. This is what removes `comment_reads`.
2. **PRD-18 named this PRD in code, with instructions.** `workspaceService.ts:159-198` documents the
   unacknowledged mention as an intended source, and says: "give this function an async sibling and
   OR the two in `hasOpenInternalItems()`; do not fork the rule." The fiddly part is that
   `resolveProposedStatus()` (line 354) consults the *synchronous*
   `workspaceHasOpenItems()` at line 361 and is called from three sites (474, 584, 593), so filling
   the source means making that helper async and threading it through — not adding a second rule.
3. **The author union is enforceable by the database, not only by a service guard.** Verified
   empirically: drizzle-kit 0.27 emits `CONSTRAINT "..." CHECK(...)` on the SQLite create-table path,
   and SQLite rejects both-set and neither-set for `(a IS NULL) <> (b IS NULL)`. The same holds for
   the mention target union. This only works because the tables are new — SQLite cannot add a check
   constraint to an existing table.
4. **The partial unique index is real too.** A `uniqueIndex()` carrying `.where(sql)`
   emits `CREATE UNIQUE INDEX ... WHERE "superseded_at" IS NULL` and SQLite enforces it, which is
   what makes "exactly one current revision" a database invariant rather than a service convention.
5. **The guest payload's placeholder keys are typed `never[]`.** `guestAccess.ts:209-210` declares
   `sharedComments: never[]` and `sharedDocuments: never[]`; `guestWorkspace.html:175` already
   branches on `sharedComments.length`. Filling the first changes the exported interface, and the
   Phase-2a assertion at `tests/unit/workspace/guestAccess.test.ts:618` must be rewritten to assert
   real behaviour rather than relaxed.
6. **A guest must not receive the author's job role.** The draft's `Comment` shape carries
   `authorJobRole`, and the guest payload was to be `listComments(_, 'shared')` directly. Internal
   job titles are internal. The guest gets a narrower `GuestSharedComment` type with its own exported
   key allow-list, following PRD-30's `GUEST_PAYLOAD_KEYS` idiom.
7. **Events already have a home and a key convention.** `emitEvent()` writes `workflow_events` keyed
   on `entityType: 'referral', entityId: <referral id>` with `metadata.workspaceId` alongside
   (`partyService.ts:319`, `protocolGateway.ts:559`). Comment events follow that shape exactly; AC20
   needs no new mechanism, and PRD-25's feed reads the table it already reads.
8. **`confirmShared` is a deliberateness marker, not a security control.** Any client can set the
   flag. It protects against an accidental default and a mis-clicked toggle, which is a real class of
   error, and it protects against nothing else. Stated plainly here for the same reason PRD-17 states
   the acting-user cookie's posture: the structural control is item 3 of the goal, that internal rows
   never enter the guest query.
9. **Migration number.** `0016`, not the draft's `0014` — `0014` went to PRD-30 and `0015` to PRD-29.
10. **Each view defines its own `esc()`.** `workspaceDetail.html:367`, `guestWorkspace.html:117` and
    five others. Comment bodies render through the local one in each, consistent with the existing
    idiom rather than introducing a shared helper for this PRD alone.

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to record what I learn about a referral so that my colleagues do not have to ask me

**AC1:** A comment can be posted to a workspace and appears in the conversation with author,
timestamp and visibility.  
**AC2:** A new comment defaults to `Internal`. A request omitting visibility yields `Internal`, never
`Shared`.  
**AC3:** Comments render in chronological order with the author's display name and job role.  
**AC4:** An empty or whitespace-only comment is rejected with `400`.  
**AC5:** A body longer than 4000 characters is rejected with `400`.

### As a care coordinator, I want to share a message with the other organization deliberately, so that I never disclose an internal note by accident

**AC6:** Posting or editing to `Shared` without `confirmShared: true` is rejected with `422`.  
**AC7:** The confirmation names the party or parties who will be able to read the comment, and says
whether any of them currently has an active guest.  
**AC8:** Internal and shared comments are unmistakably different on screen — differing background
treatment *and* an explicit label, not colour alone.  
**AC9:** A shared comment cannot be changed back to `Internal` once any guest on the workspace has
been active since it first became shared; the attempt is rejected with `409` and a message explaining
that an external reader has already had access.  
**AC10:** An internal comment can be changed to shared, and that change is recorded as a new revision
with the same confirmation step.  
**AC11:** A refused downgrade is recorded as `workspace.comment_downgrade_refused`, because an
attempted retroactive downgrade is exactly what an auditor wants to see.

### As an invited specialist, I want to ask a question in the workspace so that I do not have to telephone

**AC12:** A guest can post a comment; it is created `Shared` and the visibility control is not
offered.  
**AC13:** The guest comment API rejects a client-supplied visibility other than `Shared` rather than
coercing it, so a client bug surfaces instead of hiding.  
**AC14:** A guest sees only shared, non-tombstoned comments; internal comments are excluded in SQL and
never enter the guest code path.  
**AC15:** The guest payload's comment shape is asserted against an exported key allow-list, and
carries no internal field — no job role, no tombstone metadata, no share-lock state.  
**AC16:** A guest comment is attributed to the guest and the party they act for, in the internal view
and in the emitted event.

### As a care coordinator, I want to mention a colleague so that they know to look

**AC17:** An `@mention` on an internal comment resolves against active internal users; an unknown or
deactivated user id is rejected with `400`.  
**AC18:** An `@mention` on a shared comment resolves against the workspace's parties, not internal
users — mentioning a colleague in a comment the other side can read is rejected with `422`.  
**AC19:** A party id that is not on this workspace is rejected with `400`.  
**AC20:** Each mention emits `workspace.comment_mention` carrying the mentioned identity, for PRD-27.  
**AC21:** A mention can be acknowledged; acknowledgement is recorded with who and when.  
**AC22:** An unacknowledged mention on a workspace makes `hasOpenInternalItems()` true, and a
`Closed-Confirmed` referral with one derives `Follow-up-Required` rather than `Resolved`.  
**AC23:** A mention on a superseded revision or a tombstoned comment is not open — editing a comment
to remove a mention retracts it.

### As an auditor, I want a complete and honest comment history so that the record cannot be quietly rewritten

**AC24:** Editing a comment supersedes the current revision and inserts the next one; the previous
text remains retrievable through `getCommentHistory()` and the thread shows that the comment was
edited, with the edit time and the revision count.  
**AC25:** Only the author may edit a comment; another user's attempt is rejected with `403`.  
**AC26:** Any internal user may tombstone any comment, including a guest's; the tombstone records the
actor and the time.  
**AC27:** A tombstoned comment's row survives, its body is never returned by `listComments()`, and the
thread shows that a comment was deleted, by whom and when.  
**AC28:** No code path hard-deletes a comment, a revision or a mention row.  
**AC29:** Editing a tombstoned comment is rejected with `409`.  
**AC30:** Visibility is recorded per revision and never mutated in place, so a later change cannot
disguise what was visible when.  
**AC31:** Exactly one revision per comment has `superseded_at IS NULL`, enforced by a partial unique
index; a concurrent second edit is refused with `409` rather than creating a second current revision.

### As an engineer, I want the boundary enforced in code so that no future change can leak an internal note

**AC32:** A test asserts that no internal comment appears in `buildGuestPayload()` output.  
**AC33:** A test asserts that no comment of either visibility appears in any artifact produced by
`rriBuilder.ts`, `siuBuilder.ts`, `ccdaBuilder.ts` or `mdnService.ts`.  
**AC34:** A comment with exactly one author is accepted; both authors set, or neither, is refused by
the database check constraint as well as by the service guard.  
**AC35:** Comment bodies containing HTML or script tags render escaped in the internal panel and the
guest panel, verified by the render smoke check rather than by a unit test.

---

## Technical Specifications

### Dependencies

- [[PRD-17 - Identity & Acting User]] — comment authors and mention targets
- [[PRD-18 - Workspace Entity & Dual Status]] — the workspace a thread belongs to, and the
  `hasOpenInternalItems()` extension point this PRD fills
- [[PRD-19 - Workspace Shell]] — the `#wsConversation` slot and its `slots.conversation` flag
- [[PRD-24 - Parties & Participants]] — shared-comment mention targets
- [[PRD-30 - Guest Participation]] — guest authorship, the guest payload, and `lastSeenAt`

### Engineering Constraints

- **Do not extend `referral_messages`.** That table is the protocol thread: machine-authored, tied to
  message control ids and ack status. A comment is a different thing with different lifecycle rules,
  and mixing them would make both harder to reason about. PRD-25 may interleave them for display; the
  storage stays separate.
- **Author is a union enforced by the database.** A comment has either `author_user_id` or
  `author_guest_id`, never both and never neither:
  `CHECK ((author_user_id IS NULL) <> (author_guest_id IS NULL))`. The service guard stays as well,
  so the error message is a sentence rather than a constraint name.
- **Append-only.** An edit sets `superseded_at` on the current revision and inserts the next. Nothing
  is overwritten and nothing is hard-deleted, anywhere, ever.
- **Exactly one current revision, enforced by a partial unique index**, not by a service convention.
- `Internal` is the default in the schema, the service and the API. A missing visibility is
  `Internal`.
- Guest-authored comments are forced to `Shared` server-side; a supplied visibility other than
  `Shared` is rejected rather than coerced.
- **The guest query filters in SQL.** `listComments(workspaceId, 'shared')` selects
  `visibility = 'Shared'` in the statement, so an internal row never enters the process's guest code
  path and cannot be exposed by a later rendering mistake.
- **The guest type is narrower than the internal one.** `GuestSharedComment` is built field by field
  with its own exported key allow-list — the "omit, do not hide" rule PRD-30 established.
- Escape all comment bodies on render using each view's local `esc()`.
- Mentions are stored as resolved ids at post time, per revision, not re-parsed from the body on read.
- **Do not fork `hasOpenInternalItems()`.** Follow PRD-18's written instruction: add an async sibling
  that ORs the existing synchronous rule with the new query, and make `resolveProposedStatus()` async
  so the closure branch consults one definition. `workspaceService` imports the mention query lazily,
  the same way `guestAccess` imports `protocolGateway`, to keep the module graphs acyclic.

### Data Models

```typescript
// src/db/schema.ts — new

/** Identity. Never changes. What a PATCH, a tombstone and a mention all target. */
export const referralComments = sqliteTable(
  'referral_comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),

    authorUserId: integer('author_user_id').references(() => users.id),
    authorGuestId: integer('author_guest_id').references(() => workspaceGuests.id),
    // Denormalised from the guest row for the same reason workspace_guests
    // denormalises its own pair: attribution reads one row. NULL for internal authors.
    authorPartyId: integer('author_party_id').references(() => workspaceParties.id),

    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),

    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
    deletedByActor: text('deleted_by_actor'),
  },
  (table) => ({
    workspaceIdx: index('idx_referral_comments_workspace').on(table.workspaceId, table.createdAt),
    authorUnion: check(
      'referral_comments_author_union',
      sql`(${table.authorUserId} IS NULL) <> (${table.authorGuestId} IS NULL)`,
    ),
  }),
);

/** Content. Append-only. Body and visibility at one point in time. */
export const commentRevisions = sqliteTable(
  'comment_revisions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    commentId: integer('comment_id').references(() => referralComments.id).notNull(),
    revisionNumber: integer('revision_number').notNull(), // 1-based
    body: text('body').notNull(),
    visibility: text('visibility').notNull().default('Internal'), // 'Internal' | 'Shared'
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    createdByActor: text('created_by_actor').notNull(),
    supersededAt: integer('superseded_at', { mode: 'timestamp' }),
  },
  (table) => ({
    numberIdx: uniqueIndex('idx_comment_revisions_number').on(table.commentId, table.revisionNumber),
    // Exactly one current revision per comment, enforced by the database.
    currentIdx: uniqueIndex('idx_comment_revisions_current')
      .on(table.commentId)
      .where(sql`${table.supersededAt} IS NULL`),
  }),
);

/** Resolved mention targets, per revision, with acknowledgement. */
export const commentMentions = sqliteTable(
  'comment_mentions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    commentId: integer('comment_id').references(() => referralComments.id).notNull(),
    revisionId: integer('revision_id').references(() => commentRevisions.id).notNull(),
    // Denormalised so hasOpenInternalItems(workspaceId) is one indexed query
    // rather than a join through comments.
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),

    mentionedUserId: integer('mentioned_user_id').references(() => users.id),
    mentionedPartyId: integer('mentioned_party_id').references(() => workspaceParties.id),

    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp' }),
    acknowledgedByActor: text('acknowledged_by_actor'),
  },
  (table) => ({
    workspaceIdx: index('idx_comment_mentions_workspace')
      .on(table.workspaceId, table.acknowledgedAt),
    userIdx: index('idx_comment_mentions_user').on(table.mentionedUserId, table.acknowledgedAt),
    targetUnion: check(
      'comment_mentions_target_union',
      sql`(${table.mentionedUserId} IS NULL) <> (${table.mentionedPartyId} IS NULL)`,
    ),
  }),
);
```

An **open** mention is one that is unacknowledged, on the current revision, of a comment that is not
tombstoned, targeting a user. A party mention is a routing hint for PRD-27 and is never an internal
open item.

```typescript
// src/modules/workspace/commentService.ts — new
export type CommentVisibility = 'Internal' | 'Shared';
export const MAX_COMMENT_LENGTH = 4000;

export class CommentEmptyError extends Error {}
export class CommentTooLongError extends Error {}
export class CommentNotFoundError extends Error {}
export class CommentDeletedError extends Error {}
export class CommentNotAuthorError extends Error {}
export class ShareNotConfirmedError extends Error {}
export class VisibilityDowngradeError extends Error {}
export class GuestVisibilityError extends Error {}
export class SharedMentionError extends Error {}
export class MentionTargetError extends Error {}
export class CommentRevisionConflictError extends Error {}
export class CommentWorkspaceNotFoundError extends Error {}

export interface Comment {
  id: number;
  workspaceId: number;
  /** null when tombstoned — the service does not hand out a deleted body. */
  body: string | null;
  visibility: CommentVisibility;
  authorKind: 'user' | 'guest';
  authorDisplayName: string;
  authorJobRole: JobRole | null;
  authorPartyOrgName: string | null;
  /** Author since deactivated, or guest invitation since revoked. Still attributed. */
  authorInactive: boolean;
  mentions: { kind: 'user' | 'party'; id: number; displayName: string; acknowledgedAt: Date | null }[];
  createdAt: Date;
  editedAt: Date | null;
  revisionCount: number;
  deleted: boolean;
  deletedAt: Date | null;
  deletedByActor: string | null;
  /** True when a guest has been active since this first became shared (AC9). */
  shareLocked: boolean;
}

/** What a guest receives. Narrower on purpose; asserted against GUEST_COMMENT_KEYS. */
export interface GuestSharedComment {
  id: number;
  body: string;
  authorDisplayName: string;
  authorOrgName: string;
  createdAt: string;
  edited: boolean;
  own: boolean;
}
export const GUEST_COMMENT_KEYS: readonly string[];

export interface CommentRevisionRecord {
  revisionNumber: number;
  body: string;
  visibility: CommentVisibility;
  createdAt: Date;
  createdByActor: string;
  supersededAt: Date | null;
}

export async function listComments(workspaceId: number): Promise<Comment[]>;
export async function listSharedComments(
  workspaceId: number, viewerGuestId: number,
): Promise<GuestSharedComment[]>;
export async function getCommentHistory(commentId: number): Promise<CommentRevisionRecord[]>;

export async function postComment(input: {
  workspaceId: number;
  body: string;
  visibility?: CommentVisibility; // defaults to 'Internal'
  confirmShared?: boolean;
  author: { kind: 'user'; user: ActingUser } | { kind: 'guest'; guest: GuestContext };
  mentions?: { users?: number[]; parties?: number[] };
}): Promise<Comment>;

export async function editComment(input: {
  commentId: number;
  body: string;
  visibility: CommentVisibility;
  confirmShared?: boolean;
  user: ActingUser;
  mentions?: { users?: number[]; parties?: number[] };
}): Promise<Comment>;

export async function deleteComment(commentId: number, actor: string): Promise<Comment>;

export async function mentionTargets(workspaceId: number): Promise<{
  users: { id: number; displayName: string; jobRole: JobRole; isParticipant: boolean }[];
  parties: { id: number; orgName: string; partyRole: PartyRole; hasActiveGuest: boolean }[];
}>;
export async function acknowledgeMentions(
  workspaceId: number, userId: number, actor: string,
): Promise<number>;
export async function openMentionCount(workspaceId: number, userId: number): Promise<number>;
/** The source PRD-18's hasOpenInternalItems() ORs in. */
export async function hasUnacknowledgedMention(workspaceId: number): Promise<boolean>;
```

Migration: `0016`.

Audit events: `workspace.comment_added`, `workspace.comment_edited`, `workspace.comment_shared`,
`workspace.comment_deleted`, `workspace.comment_mention`, `workspace.comment_mention_acknowledged`,
`workspace.comment_downgrade_refused` — all `entityType: 'referral'`, `entityId: <referral id>`, with
`metadata.workspaceId` alongside, matching the existing convention.

### API Design

**`GET /api/workspaces/:id/comments`** → internal audience, both visibilities
```json
{
  "comments": [
    { "id": 41, "body": "Referring office faxing imaging Weds", "visibility": "Internal",
      "authorKind": "user", "authorDisplayName": "Dana Ruiz", "authorJobRole": "coordinator",
      "createdAt": "2026-09-14T15:02:00Z", "editedAt": "2026-09-14T16:40:00Z",
      "revisionCount": 2, "deleted": false, "shareLocked": false, "mentions": [] }
  ],
  "openMentions": 1
}
```

**`POST /api/workspaces/:id/comments`**
```json
{ "body": "Can you confirm the referral includes the echo report?",
  "visibility": "Shared", "confirmShared": true, "mentions": { "parties": [2] } }
```
`400` empty, whitespace-only or over-length body, unknown mention target ·
`401` no acting user · `404` unknown workspace ·
`422` `Shared` without `confirmShared`, or a shared comment mentioning internal users

**`PATCH /api/workspaces/:id/comments/:commentId`**
```json
{ "body": "corrected text", "visibility": "Internal" }
```
`403` not the author · `409` downgrade of a share-locked comment, a tombstoned comment, or a
concurrent-edit conflict

**`DELETE /api/workspaces/:id/comments/:commentId`** → `200` with the tombstoned comment

**`GET /api/workspaces/:id/comments/:commentId/history`** → the full revision list. No guest route.

**`GET /api/workspaces/:id/mention-targets`** → the roster and the parties, with `isParticipant` and
`hasActiveGuest` so AC7's confirmation can name who will actually be able to read the comment.

**`POST /api/workspaces/:id/mentions/ack`** → `{ "acknowledged": 2 }`

**`POST /api/guest/comments`** — `{ "body": "..." }`. The workspace and the party come from the
session, never the body. `400` if any `visibility` other than `Shared` is supplied.

---

## Test Plan

**Unit Tests:**
- `postComment()` defaults to `Internal` when visibility is omitted
- `postComment()` rejects empty, whitespace-only and over-4000-character bodies
- `postComment()` rejects `Shared` without `confirmShared`
- `postComment()` from a guest forces `Shared`, rejects any other supplied visibility, and records
  the party
- `postComment()` rejects a shared comment carrying internal user mentions
- `postComment()` rejects an unknown user, an inactive user, and a party not on this workspace
- `editComment()` supersedes revision 1, inserts revision 2, leaves revision 1 retrievable, and
  reports `revisionCount: 2` with an `editedAt`
- `editComment()` from a non-author throws `CommentNotAuthorError`
- `editComment()` on a tombstoned comment throws `CommentDeletedError`
- `editComment()` downgrading `Shared → Internal` throws once a guest has been active since the
  share, and succeeds when no guest has
- `editComment()` upgrading `Internal → Shared` requires `confirmShared`
- `editComment()` dropping a mention makes the old mention non-open
- `deleteComment()` sets the tombstone, returns `body: null`, and never removes the row
- `deleteComment()` by a non-author succeeds and records that actor
- `listComments()` returns latest revisions in chronological order, tombstones included as tombstones
- `listSharedComments()` returns only shared, non-tombstoned latest revisions
- `hasUnacknowledgedMention()` / `openMentionCount()` / `acknowledgeMentions()` round trip
- Author union: both set and neither set are both refused
- A second concurrent edit throws `CommentRevisionConflictError`

**Integration Tests:**
- Post internal and shared comments as a user and as a guest; assert the internal view shows all four
  and the guest payload shows only the two shared ones
- Edit a comment twice and assert the thread shows the latest text, an edited marker, and a
  three-revision history
- A guest loads the workspace, then the author attempts a downgrade and is refused; assert
  `workspace.comment_downgrade_refused` was emitted
- Mention a colleague on an internal comment, assert `workspace.comment_mention`, then assert a
  `Closed-Confirmed` referral derives `Follow-up-Required` until the mention is acknowledged and
  `Resolved` after (AC22 — PRD-18's branch, reachable for the first time)

**Edge Cases:**
- Comment body containing HTML, script tags, or a very long single word — escaped and wrapped
- Comment authored by a user later deactivated — still attributed, flagged inactive
- Comment authored by a guest whose invitation is later revoked — still attributed, still visible
  internally, still visible to other guests
- A workspace with no parties and no guests — sharing is permitted and downgrade stays possible
- A shared comment posted while no guest exists, then a guest is invited and loads the page — the
  comment locks from that load, not retroactively from the invitation

**Boundary Tests:**
- No internal comment appears in `buildGuestPayload()` output
- The guest comment shape matches `GUEST_COMMENT_KEYS` exactly
- No comment of either visibility appears in any builder output

**Smoke Check (what unit tests cannot catch):**
- The conversation panel renders in `#wsConversation` with both visibility treatments present
- A hostile comment body arrives escaped in the internal page and the guest page
- The guest page's conversation section renders and the internal note is absent from the bytes

**Regression:**
- `referral_messages` and the existing thread APIs are unchanged
- `slots.conversation` flips to `true` and the PRD-22 placeholder stops rendering

---

## Deliverables

- `referral_comments`, `comment_revisions`, `comment_mentions` in `src/db/schema.ts` + migration
  `0016`
- `src/modules/workspace/commentService.ts`
- The comment, history, mention-target, mention-ack and guest comment routes listed above
- `hasOpenInternalItems()` extended per PRD-18's instruction, with `resolveProposedStatus()` made
  async
- `sharedComments` filled in `buildGuestPayload()`, replacing `never[]`, with `GUEST_COMMENT_KEYS`
- Conversation panel in the `#wsConversation` slot with the share confirmation flow, and the guest
  conversation section in `guestWorkspace.html`
- `tests/unit/workspace/commentService.test.ts` and smoke-check additions

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-18 - Workspace Entity & Dual Status]] — the `hasOpenInternalItems()` extension point
- [[PRD-19 - Workspace Shell]] — the slot
- [[PRD-24 - Parties & Participants]] — shared mention targets
- [[PRD-25 - Activity History & Audit]] — comments in the unified feed
- [[PRD-27 - Notifications]] — consumes mention events
- [[PRD-30 - Guest Participation]] — guest authorship, the guest payload, `lastSeenAt`
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-15  
**Version:** 1.1 — Refined to implementation-ready. Three decisions taken: two tables rather than one
self-referencing chain, the author edits while anyone internal may tombstone, and PRD-18's
`hasOpenInternalItems()` extension point gets filled. Ten codebase findings recorded above; the two
that changed the design most:

- **`comment_reads` is not built at all.** `requireGuest()` already stamps
  `workspace_guests.lastSeenAt` on every authenticated guest request, which is exactly the fact the
  no-retroactive-downgrade rule needs. The draft's table had a `reader_user_id` column no acceptance
  criterion referenced, and its own note warned it must not grow into a read-receipt feature.
- **The draft's single-table revision chain had no stable comment identity.** `revision_of` pointing
  at the prior row means the id a tombstone, a mention and a `PATCH` target changes on every edit.
  Split into identity and content, with a partial unique index making "exactly one current revision"
  a database invariant — verified emitted and enforced before being written down here, as were both
  check constraints.
