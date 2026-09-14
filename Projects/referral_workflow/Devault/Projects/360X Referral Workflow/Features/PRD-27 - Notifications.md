---
up: "[[📋 PRD Index]]"
prev: "[[PRD-26 - Next Action & Due Dates]]"
---

# PRD-27: Notifications

**Status:** Drafting  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

The application cannot tell anyone anything. There is no notification infrastructure of any kind — no
table, no badge, no bell, no digest. The nearest things are a `console.warn` in the overdue checker
and the demo's server-sent-event stream (`GET /demo/events/:referralId`), which polls
`referrals.state` every 1500 ms to drive a progress animation on the walkthrough page. Outbound email
exists, but only as protocol transport: `nodemailer` sends Direct messages and MDNs, never a message
to a colleague.

That is workable while every action is initiated by whoever is looking at the screen. It stops working
the moment the epic's collaboration features land. Assignment (PRD-21) means work arrives for someone
who is not looking. Mentions (PRD-22) are pointless if the mentioned person never learns of them.
Overdue detection (PRD-26) computes a fact that nobody sees. Guest actions (PRD-30) happen when no
internal user is watching. Exceptions (PRD-28) are precisely the cases that need attention now.

The source document's MVP list is specific about what must notify: "new assignment, pending response,
state change, new document, comment mention, overdue action, and exception." This PRD delivers that,
plus the guest-facing notifications the epic's departure from the document makes necessary.

### Goal

The primary goal of this feature is to:
1. Deliver **in-app notifications** for the seven events the source document specifies, plus guest
   invitation and guest activity
2. Resolve **recipients from real relationships** — owner, participants, mentioned users — rather than
   broadcasting to everyone
3. Keep the **internal/external boundary intact**: a guest is never notified of an internal event, and
   a notification never carries clinical detail out by email
4. Reuse the **existing SMTP transport and SSE pattern** rather than adding infrastructure

### Scope

**In Scope:**
- A `notifications` table addressable to an internal user or a guest
- A notification service with one `notify()` entry point subscribed to the epic's events
- The nine triggers: assignment, pending response, state change, new document, comment mention,
  overdue, exception, guest invitation, guest action
- A navigation bell with an unread count, a notification list, and mark-as-read
- Per-user mute preferences per notification type
- Optional email delivery for a defined subset, through the existing transport
- Guest notification of shared activity on their workspace, by email

**Out of Scope:**
- Push notifications, SMS, Slack or Teams integration
- A general webhook or subscription API for external systems — on the epic's backlog, and already an
  idea in the vault backlog
- Digest scheduling and quiet hours beyond a simple per-type mute
- Real-time delivery guarantees; the bell polls or uses SSE and a missed poll is acceptable
- Replacing the demo SSE stream, which keeps serving the walkthrough page

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want to be told when work is assigned to me so that I do not need to watch a queue

**AC1:** Being assigned as owner creates a notification for the new owner naming the patient, the
referral and who assigned it.  
**AC2:** Assigning myself does not notify me.  
**AC3:** Being unassigned by someone else notifies the previous owner.  
**AC4:** Each notification links directly to the workspace.

### As a care coordinator, I want to be told when something changes on a referral I am involved in so that I do not have to keep checking

**AC5:** A protocol state change notifies the owner and all participants.  
**AC6:** A new document notifies the owner and all participants.  
**AC7:** An inbound response that clears a pending request notifies the owner.  
**AC8:** A comment mention notifies only the mentioned user, not the whole participant list.  
**AC9:** An exception notifies the owner, and the queue's managers when there is no owner.  
**AC10:** An overdue next action notifies the owner once per due date, and the queue's managers when
there is no owner.

### As a care coordinator, I want to control what reaches me so that the bell stays useful

**AC11:** The bell shows an unread count, and opening the list does not mark everything read —
notifications are marked read individually or explicitly all at once.  
**AC12:** Each notification type can be muted per user, and a muted type is not created rather than
created and hidden.  
**AC13:** An action that generates several notifications for the same user on the same workspace within
a short window is collapsed into one, so a burst of activity does not produce a wall of entries.  
**AC14:** Notifications older than a configured retention period are pruned.

### As an invited specialist, I want to be told when there is something new for me so that I do not have to keep the tab open

**AC15:** An invitation is delivered by email with a link, containing the patient name and referring
organization only — no clinical detail.  
**AC16:** A new shared comment or shared document notifies the guest by email, with a link and no
clinical content in the body.  
**AC17:** No internal event — assignment, work status, internal comment, routing, exception — ever
notifies a guest, asserted by test against an allow list.  
**AC18:** A revoked or expired guest receives no further notifications.

### As a care coordinator, I want to know when the other side acts so that I can respond

**AC19:** A guest posting a shared comment, uploading a document or making an assertion notifies the
owner and participants.  
**AC20:** The notification names the party and the guest, so the internal reader knows which
organization acted.

---

## Technical Specifications

### Dependencies

- [[PRD-17 - Identity & Acting User]] — internal recipients
- [[PRD-24 - Parties & Participants]] — `resolveNotificationRecipients()`
- [[PRD-21 - Ownership & Assignment]], [[PRD-22 - Referral Conversation]],
  [[PRD-23 - Document Collection]], [[PRD-26 - Next Action & Due Dates]],
  [[PRD-28 - Correlation & Exception Queue]], [[PRD-29 - 360X Protocol Gateway]],
  [[PRD-30 - Guest Participation]] — event sources
- `nodemailer` via the existing SMTP transport and `config.smtp`

### Engineering Constraints

- **One entry point.** Every trigger calls a single `notify()` with a typed payload. Do not scatter
  insert statements across seven services; a single funnel is what makes muting, collapsing and the
  guest allow list enforceable in one place.
- **Notification creation must never fail a user action.** Call it fire-and-forget like `emitEvent()`,
  with the same `void notify(...).catch(...)` idiom, so a mail failure cannot roll back an assignment.
- **Guest notifications are allow-listed, not deny-listed.** A hard-coded set of guest-eligible
  notification types, and anything not in it is never delivered to a guest. A new internal type must
  be invisible to guests by default — that is the property a deny list cannot give.
- **Email bodies carry no clinical content.** Patient name, referring organization and a link. The
  content lives behind the link, which is the same discipline PRD-30 applies to the invitation email.
- Recipients are resolved at send time from the current owner and participants, not captured when the
  event was emitted, so a reassignment between event and delivery notifies the right person.
- The bell polls on an interval or reuses the SSE pattern already in `src/server.ts`. Do not
  introduce WebSockets.
- Muting prevents creation. A muted notification that exists but is hidden still shows in counts and
  still costs a row.
- Retention pruning runs in the same interval sweep as the overdue checker rather than adding a second
  scheduled job.

### Data Models

```typescript
// src/db/schema.ts — new
export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    // Exactly one recipient, internal or guest.
    recipientUserId: integer('recipient_user_id').references(() => users.id),
    recipientGuestId: integer('recipient_guest_id').references(() => workspaceGuests.id),

    workspaceId: integer('workspace_id').references(() => referralWorkspaces.id).notNull(),
    notificationType: text('notification_type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    linkPath: text('link_path').notNull(),
    triggeredByActor: text('triggered_by_actor'),
    collapseKey: text('collapse_key'),        // recipient + workspace + type, for AC13
    collapsedCount: integer('collapsed_count').notNull().default(1),
    emailSentAt: integer('email_sent_at', { mode: 'timestamp' }),
    readAt: integer('read_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    userIdx: index('idx_notifications_user').on(table.recipientUserId, table.readAt, table.createdAt),
    guestIdx: index('idx_notifications_guest').on(table.recipientGuestId, table.readAt),
    collapseIdx: index('idx_notifications_collapse').on(table.collapseKey, table.createdAt),
  }),
);

export const notificationPreferences = sqliteTable(
  'notification_preferences',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').references(() => users.id).notNull(),
    notificationType: text('notification_type').notNull(),
    muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
    emailEnabled: integer('email_enabled', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => ({ userIdx: index('idx_notification_prefs_user').on(table.userId) }),
);
```

```typescript
// src/modules/workspace/notificationService.ts — new
export type NotificationType =
  | 'assignment'          // PRD-21
  | 'unassignment'        // PRD-21
  | 'state_change'        // protocol transitions
  | 'pending_response'    // a request to the counterparty is outstanding
  | 'response_received'   // an inbound reply cleared a pending request
  | 'new_document'        // PRD-23
  | 'mention'             // PRD-22
  | 'overdue'             // PRD-26
  | 'exception'           // PRD-28
  | 'guest_invited'       // PRD-30, delivered to the guest
  | 'guest_activity'      // a guest acted; delivered internally
  | 'shared_activity';    // internal shared comment or document; delivered to the guest

/** The only notification types a guest may ever receive. Allow list, per AC17. */
export const GUEST_ELIGIBLE_TYPES: readonly NotificationType[] =
  ['guest_invited', 'shared_activity'] as const;

export interface NotifyInput {
  workspaceId: number;
  type: NotificationType;
  title: string;
  body: string;
  linkPath: string;
  triggeredByActor?: string;
  audience:
    | { kind: 'owner' }
    | { kind: 'participants' }                     // owner + all participants
    | { kind: 'users'; userIds: number[] }
    | { kind: 'queue-managers' }
    | { kind: 'guest'; guestId: number };
}

/** Fire-and-forget. Resolves recipients, applies mutes, collapses, creates rows, queues email. */
export async function notify(input: NotifyInput): Promise<void>;

export async function listNotifications(
  userId: number, opts?: { unreadOnly?: boolean; limit?: number },
): Promise<Notification[]>;
export async function getUnreadCount(userId: number): Promise<number>;
export async function markRead(notificationId: number, userId: number): Promise<void>;
export async function markAllRead(userId: number): Promise<void>;
export async function setPreference(
  userId: number, type: NotificationType, patch: { muted?: boolean; emailEnabled?: boolean },
): Promise<void>;
export async function pruneOld(): Promise<number>;
```

Trigger-to-audience map, which is the specification a reviewer should check against the source
document's list:

| Type | Audience | Email by default |
|---|---|---|
| `assignment` | the new owner (never self-assignment) | no |
| `unassignment` | the previous owner | no |
| `state_change` | participants | no |
| `pending_response` | owner | no |
| `response_received` | owner | no |
| `new_document` | participants | no |
| `mention` | the mentioned user only | no |
| `overdue` | owner, or queue managers when unowned | no |
| `exception` | owner, or queue managers when unowned | no |
| `guest_invited` | the guest | **yes** |
| `guest_activity` | participants | no |
| `shared_activity` | the guest | **yes** |

Guest-addressed types default to email because a guest has no bell to look at.

Migration: `0020_add_notifications.sql`.
Config: `config.workspace.notificationRetentionDays` (default 90),
`config.workspace.notificationCollapseWindowMinutes` (default 15).

### API Design

**Endpoint:** `GET /api/notifications?unreadOnly=1&limit=50`
```json
{ "unreadCount": 4, "notifications": [ { "id": 88, "type": "assignment", "title": "Referral assigned to you", "body": "R. Alvarez — Cardiology referral from Northside Primary Care", "linkPath": "/workspaces/12", "createdAt": "2026-09-14T15:40:00Z", "readAt": null, "collapsedCount": 1 } ] }
```

**Endpoint:** `GET /api/notifications/count` → `{ "unreadCount": 4 }` — the bell's poll target, kept
deliberately cheap.

**Endpoint:** `POST /api/notifications/:id/read` → `{ "success": true }`

**Endpoint:** `POST /api/notifications/read-all` → `{ "success": true, "marked": 4 }`

**Endpoints:** `GET`/`PATCH /api/notification-preferences`

**Page:** `GET /notifications` — the full list with type filters.

---

## Test Plan

**Unit Tests:**
- `notify()` with `audience: { kind: 'owner' }` on an unowned workspace creates nothing and does not
  throw
- Self-assignment creates no notification
- `audience: 'participants'` resolves owner plus participants and excludes removed participants
- A muted type creates no row
- Two notifications of the same type for the same recipient and workspace inside the collapse window
  become one row with `collapsedCount: 2`
- A guest audience with a type outside `GUEST_ELIGIBLE_TYPES` creates nothing — asserted for every
  non-eligible type
- A revoked or expired guest receives nothing
- `markRead()` by a user who does not own the notification is a no-op
- `pruneOld()` removes only rows past the retention period
- An email failure leaves the notification row created and `emailSentAt` null

**Integration Tests:**
- Assign a referral and assert exactly one notification for the new owner with a working link
- Mention a colleague and assert only that colleague is notified
- Let a due date pass, run the sweep, and assert one `overdue` notification for the owner
- A guest posts a shared comment and the owner and participants are notified naming the party
- An internal user posts a shared comment and the guest receives an email with a link and no clinical
  content
- Reassign between event emission and delivery and assert the current owner is notified

**Edge Cases:**
- Notification for a workspace archived before delivery — created, link renders a read-only workspace
- Recipient deactivated — no notification, no error
- Several hundred unread notifications — count query stays cheap, list paginates
- SMTP unavailable for an invitation — invitation still created and marked undelivered (PRD-30)
- A burst of twenty state changes — collapsed per the window

**Boundary Tests:**
- No email body contains clinical detail beyond patient name and referring organization
- Adding a new internal notification type does not make it guest-deliverable (allow-list proof)

**Regression:**
- The demo SSE stream and the walkthrough page are unchanged
- Protocol email via `nodemailer` is unaffected

---

## Deliverables

- `notifications`, `notification_preferences` in `src/db/schema.ts` + migration
  `0020_add_notifications.sql`
- `src/modules/workspace/notificationService.ts`
- `notify()` calls added at the nine trigger sites
- Navigation bell with unread count in `NAV_HTML`; `src/views/notifications.html`
- Routes listed above
- Retention pruning added to the existing interval sweep
- `config.workspace.notificationRetentionDays`,
  `config.workspace.notificationCollapseWindowMinutes`
- `tests/unit/workspace/notificationService.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-24 - Parties & Participants]] — recipient resolution
- [[PRD-21 - Ownership & Assignment]], [[PRD-22 - Referral Conversation]],
  [[PRD-23 - Document Collection]], [[PRD-26 - Next Action & Due Dates]],
  [[PRD-28 - Correlation & Exception Queue]], [[PRD-30 - Guest Participation]] — triggers
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-14  
**Version:** 1.0
