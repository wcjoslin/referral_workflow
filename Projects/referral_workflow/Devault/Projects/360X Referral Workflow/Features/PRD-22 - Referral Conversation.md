---
up: "[[📋 PRD Index]]"
prev: "[[PRD-21 - Ownership & Assignment]]"
---

# PRD-22: Referral Conversation (Dual-Visibility)

**Status:** Drafting  
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

### Goal

The primary goal of this feature is to:
1. Give every workspace **one conversation** attached to the referral, authored by real people
2. Let a comment be **internal to the organization or shared with the other party**, with internal as
   the default and sharing as a deliberate act
3. Make the internal/shared boundary **structural** — internal comments cannot reach a guest or an
   outbound artifact by any code path
4. Settle the **audit semantics**: edits are versioned, deletions are tombstoned, nothing is ever
   hard-deleted

### Scope

**In Scope:**
- A `referral_comments` table, one thread per workspace, authored by a user or a guest
- Per-comment `Internal` / `Shared` visibility with an explicit confirmation to share
- Posting, editing (as a new revision), and deleting (as a tombstone)
- `@mentions` resolving to internal users on internal comments and to parties on shared comments
- The conversation panel in the `#wsConversation` slot, with visually unmistakable separation
- Guest-authored comments, always `Shared`, with the visibility choice unavailable
- Read receipts sufficient to enforce the no-retroactive-downgrade rule

**Out of Scope:**
- Real-time delivery, typing indicators, presence — the panel loads and reloads like every other view
- Threaded replies, reactions, attachments on comments (a document is a document, PRD-23)
- Rich text or markdown rendering beyond line breaks and escaped text
- Transmitting a shared comment over 360X as a protocol artifact — a shared comment is visible in the
  workspace to an invited guest; sending something to a counterparty is an assertion, PRD-29
- Notifying a mentioned user — PRD-27 consumes the event this PRD emits
- Cross-organization chat as a product surface beyond this referral — later phase

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to record what I learn about a referral so that my colleagues do not have to ask me

**AC1:** A comment can be posted to a workspace and appears in the conversation with author, timestamp
and visibility.  
**AC2:** A new comment defaults to `Internal`.  
**AC3:** Comments render in chronological order with the author's display name and job role.  
**AC4:** An empty or whitespace-only comment is rejected.

### As a care coordinator, I want to share a message with the other organization deliberately, so that I never disclose an internal note by accident

**AC5:** Posting a `Shared` comment requires an explicit confirmation step naming the party or parties
who will be able to read it.  
**AC6:** Internal and shared comments are unmistakably different on screen — differing background
treatment *and* an explicit label, not colour alone.  
**AC7:** A shared comment cannot be retroactively changed to internal once any guest read of it is
recorded; the attempt is rejected with a message explaining why.  
**AC8:** An internal comment can be changed to shared, and that change is recorded as a revision with
the same confirmation step.

### As an invited specialist, I want to ask a question in the workspace so that I do not have to telephone

**AC9:** A guest can post a comment; it is created `Shared` and the visibility control is not offered.  
**AC10:** A guest sees only shared comments; internal comments are absent from the payload served to
them, not hidden by the client.  
**AC11:** A guest comment is attributed to the guest and the party they act for, both in the internal
view and in the activity feed.

### As a care coordinator, I want to mention a colleague so that they know to look

**AC12:** An `@mention` on an internal comment resolves against active internal users.  
**AC13:** An `@mention` on a shared comment resolves against the workspace's parties, not internal
users — mentioning a colleague in a comment the other side can read is not possible.  
**AC14:** Each mention emits an event carrying the mentioned identity for PRD-27 to act on.

### As an auditor, I want a complete and honest comment history so that the record cannot be quietly rewritten

**AC15:** Editing a comment creates a new revision row; the previous text remains retrievable and the
thread shows that the comment was edited, with the edit time.  
**AC16:** Deleting a comment sets a tombstone; the row survives, the body is no longer displayed, and
the thread shows that a comment was deleted by whom and when.  
**AC17:** No code path hard-deletes a comment row.  
**AC18:** Visibility at post time is recorded immutably on each revision, so a later change cannot
disguise what was visible when.

### As an engineer, I want the boundary enforced in code so that no future change can leak an internal note

**AC19:** A test asserts that no internal comment appears in `buildGuestPayload()` output.  
**AC20:** A test asserts that no comment of either visibility appears in any artifact produced by
`rriBuilder.ts`, `siuBuilder.ts`, `ccdaBuilder.ts` or `mdnService.ts`.  
**AC21:** The guest comment API rejects a client-supplied visibility other than `Shared`.

---

## Technical Specifications

### Dependencies

- [[PRD-17 - Identity & Acting User]] — comment authors and mention targets
- [[PRD-18 - Workspace Entity & Dual Status]] — the workspace a thread belongs to
- [[PRD-19 - Workspace Shell]] — the `#wsConversation` slot
- [[PRD-24 - Parties & Participants]] — shared-comment mention targets
- [[PRD-30 - Guest Participation]] — guest authorship and the guest payload

### Engineering Constraints

- **Do not extend `referral_messages`.** That table is the protocol thread: machine-authored, tied to
  message control ids and ack status. A comment is a different thing with different lifecycle rules,
  and mixing them would make both harder to reason about. The UI may interleave them for display; the
  storage stays separate.
- **Author is a union, not a nullable pair of foreign keys used carelessly.** A comment has either a
  `author_user_id` or an `author_guest_id`, never both and never neither; enforce it with a check
  constraint and a service-level guard.
- **Append-only with revisions.** An edit inserts a new row linked by `revision_of` and marks the
  prior row superseded. The current thread is the set of latest revisions that are not tombstoned.
  This is the answer to the source document's open question and must be stated as such in the PRD.
- Visibility is stored per revision, never mutated in place, so the history of what was visible when
  is intact.
- `Internal` is the default in the schema, the service and the API. A missing visibility is
  `Internal`, never `Shared`.
- Guest-authored comments are forced to `Shared` server-side; the API rejects any other value rather
  than silently coercing it, so a client bug surfaces instead of hiding.
- Escape all comment bodies on render using the `esc()` idiom; comment text is the most
  user-controlled string in the application.
- Mentions are stored as resolved ids in a JSON array at post time, not re-parsed from the body on
  read, so a renamed user does not change history.

### Data Models

```typescript
// src/db/schema.ts — new
export const referralComments = sqliteTable(
  'referral_comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),

    // Exactly one author. Enforced by check constraint + service guard.
    authorUserId: integer('author_user_id').references(() => users.id),
    authorGuestId: integer('author_guest_id').references(() => workspaceGuests.id),
    authorPartyId: integer('author_party_id').references(() => workspaceParties.id), // set for guests

    body: text('body').notNull(),
    visibility: text('visibility').notNull().default('Internal'),   // 'Internal' | 'Shared'
    mentions: text('mentions'),                    // JSON: {users:number[], parties:number[]}

    // Revision chain
    revisionOf: integer('revision_of'),            // id of the comment this revises
    supersededById: integer('superseded_by_id'),   // set on the prior revision
    editedAt: integer('edited_at', { mode: 'timestamp' }),

    // Tombstone
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
    deletedByActor: text('deleted_by_actor'),

    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    workspaceIdx: index('idx_referral_comments_workspace')
      .on(table.workspaceId, table.visibility, table.createdAt),
    revisionIdx: index('idx_referral_comments_revision').on(table.revisionOf),
  }),
);

export const commentReads = sqliteTable(
  'comment_reads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    commentId: integer('comment_id').references(() => referralComments.id).notNull(),
    readerGuestId: integer('reader_guest_id').references(() => workspaceGuests.id),
    readerUserId: integer('reader_user_id').references(() => users.id),
    readAt: integer('read_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({ commentIdx: index('idx_comment_reads_comment').on(table.commentId) }),
);
```

`comment_reads` exists for one specific purpose: AC7 needs to know whether a guest has seen a shared
comment. It is not a general read-receipt feature and should not grow into one without its own PRD.

```typescript
// src/modules/workspace/commentService.ts — new
export type CommentVisibility = 'Internal' | 'Shared';

export class CommentEmptyError extends Error {}
export class VisibilityDowngradeError extends Error {}
export class GuestVisibilityError extends Error {}

export interface Comment {
  id: number;
  body: string;
  visibility: CommentVisibility;
  authorKind: 'user' | 'guest';
  authorDisplayName: string;
  authorJobRole: JobRole | null;
  authorPartyOrgName: string | null;
  mentions: { users: number[]; parties: number[] };
  createdAt: Date;
  editedAt: Date | null;
  deleted: boolean;
  deletedByActor: string | null;
  revisionCount: number;
}

export async function listComments(
  workspaceId: number, audience: 'internal' | 'shared',
): Promise<Comment[]>;

export async function postComment(input: {
  workspaceId: number;
  body: string;
  visibility?: CommentVisibility;      // defaults to 'Internal'
  author: { kind: 'user'; user: ActingUser } | { kind: 'guest'; guest: GuestContext };
  mentions?: { users?: number[]; parties?: number[] };
}): Promise<Comment>;

export async function editComment(
  commentId: number, body: string, visibility: CommentVisibility, actor: string,
): Promise<Comment>;

export async function deleteComment(commentId: number, actor: string): Promise<void>;

export async function recordCommentRead(
  commentId: number, reader: { guestId?: number; userId?: number },
): Promise<void>;
```

`listComments(workspaceId, 'shared')` is what the guest payload calls; it selects on
`visibility = 'Shared'` in SQL so internal rows never enter the process's guest code path.

Migration: `0014_add_referral_comments.sql`.

Audit events: `workspace.comment_added`, `workspace.comment_edited`, `workspace.comment_deleted`,
`workspace.comment_shared`, `workspace.comment_mention`.

### API Design

**Endpoint:** `GET /api/workspaces/:id/comments` → internal audience, both visibilities
```json
{ "comments": [ { "id": 41, "body": "Referring office faxing imaging Tuesday", "visibility": "Internal", "authorKind": "user", "authorDisplayName": "Dana Ruiz", "createdAt": "2026-09-14T15:02:00Z", "editedAt": null, "deleted": false, "revisionCount": 1 } ] }
```

**Endpoint:** `POST /api/workspaces/:id/comments`
```json
{ "body": "Can you confirm the referral includes the echo report?", "visibility": "Shared", "confirmShared": true, "mentions": { "parties": [2] } }
```
- `400` empty body
- `422` `visibility: "Shared"` without `confirmShared: true`
- `422` a shared comment mentioning internal users

**Endpoint:** `PATCH /api/workspaces/:id/comments/:commentId`
```json
{ "body": "corrected text", "visibility": "Internal" }
```
`409` `VisibilityDowngradeError` when downgrading a shared comment that has a recorded guest read.

**Endpoint:** `DELETE /api/workspaces/:id/comments/:commentId` — tombstones; `204`.

**Guest:** `POST /api/guest/comments` — `{ "body": "..." }`; visibility is not accepted. `400` if a
`visibility` other than `Shared` is supplied.

---

## Test Plan

**Unit Tests:**
- `postComment()` defaults to `Internal` when visibility is omitted
- `postComment()` rejects an empty or whitespace body
- `postComment()` from a guest forces `Shared` and rejects any other supplied visibility
- `postComment()` rejects a shared comment with internal user mentions
- `editComment()` inserts a revision, links `revision_of`, sets `superseded_by_id` on the prior row,
  and leaves the original body retrievable
- `editComment()` downgrading `Shared → Internal` throws once a guest read exists, succeeds when none
- `deleteComment()` sets the tombstone and never removes the row
- `listComments(_, 'shared')` returns only shared, non-tombstoned latest revisions
- Author union: neither author set, or both set, is rejected

**Integration Tests:**
- Post internal and shared comments as a user and a guest, and assert the internal view shows all
  four while the guest payload shows only the two shared ones
- Edit a comment twice and assert the thread shows the latest text, an edited marker, and a
  retrievable history of three revisions
- A guest reads a shared comment, then the author attempts to downgrade it and is refused
- Mention a colleague on an internal comment and assert a `workspace.comment_mention` event

**Edge Cases:**
- Comment body containing HTML, script tags, or a very long single word — escaped and wrapped
- Comment authored by a user later deactivated — still attributed
- Comment authored by a guest whose invitation is later revoked — still attributed, still visible
  internally
- Editing a tombstoned comment — rejected
- Two simultaneous edits of the same comment — both become revisions, order preserved by timestamp

**Boundary Tests:**
- No internal comment appears in `buildGuestPayload()` output
- No comment of either visibility appears in any builder output

**Regression:**
- `referral_messages` and the existing thread APIs are unchanged

---

## Deliverables

- `referral_comments`, `comment_reads` in `src/db/schema.ts` + migration
  `0014_add_referral_comments.sql`
- `src/modules/workspace/commentService.ts`
- Comment routes and the guest comment route listed above
- Conversation panel in the `#wsConversation` slot, with the share confirmation flow
- `tests/unit/workspace/commentService.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-19 - Workspace Shell]] — the slot
- [[PRD-24 - Parties & Participants]] — shared mention targets
- [[PRD-25 - Activity History & Audit]] — comments in the unified feed
- [[PRD-27 - Notifications]] — consumes mention events
- [[PRD-30 - Guest Participation]] — guest authorship and the guest payload
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-14  
**Version:** 1.0
