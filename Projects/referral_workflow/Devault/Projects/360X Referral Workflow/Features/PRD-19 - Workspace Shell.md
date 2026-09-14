---
up: "[[📋 PRD Index]]"
prev: "[[PRD-18 - Workspace Entity & Dual Status]]"
---

# PRD-19: Workspace Shell

**Status:** Ready for Dev  
**Team:** Clinical Workflow & Collaboration  
**Module:** `workspace/`, `views/`  
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]

---

## Overview

### Context

The closest thing to a workspace today is the referral review page
(`GET /referrals/:id/review` → `src/views/referralReview.html`, 1225 lines). It already does a
surprising amount of what the epic needs: a journey timeline derived from the protocol state, the
embedded message thread with lazy content loading, the clinical data panel, the department routing
controls, and a sticky C-CDA viewer in the right pane. What it *is*, though, is a clinical decision
screen — its centre of gravity is the accept/decline action, and its panels are gated on which
protocol state allows which action.

The workspace is a different job. It answers "who owns this, what is the next action, what is
available to read, and what has happened" for anyone who opens it — a coordinator triaging, a manager
checking a queue, a guest from the receiving organization. It needs a header that states ownership
and accountability, both status dimensions side by side, and a panel layout that grows to hold a
conversation, a document collection, a participant roster and an activity feed.

This PRD builds that page as a new route and leaves the review page alone. Two surfaces is a
deliberate choice: the review page stays the focused clinical disposition screen it was designed to
be, and the workspace is free to be the operational surface without compromising either. They link
to each other.

This PRD is the shell only. It renders what exists after PRD-17 and PRD-18 and reserves labelled,
empty slots for the panels that PRD-21 through PRD-29 fill, so each of those lands as an isolated
change to one panel rather than a rewrite of the page.

### Goal

The primary goal of this feature is to:
1. Give every referral a **single addressable workspace page** that anyone involved can open
2. Put **accountability in the header** — patient, reason, organizations, owner, due date, next
   action — alongside the two status dimensions rendered as visibly different things
3. **Reuse the components that already work** — the journey timeline, the message thread, the C-CDA
   viewer, the badge and card vocabulary — rather than rebuilding them
4. Establish a **panel contract** so each later PRD adds one self-contained panel

### Scope

**In Scope:**
- `GET /workspaces/:id` rendering a new `src/views/workspaceDetail.html`
- `GET /api/workspaces/:id` returning the workspace payload
- The workspace header, including dual status badges and a protocol-mode indicator
- Panels that can be built from what already exists: summary, protocol timeline, message thread,
  clinical data, routing/department, prior auth, C-CDA viewer
- Labelled placeholder slots for: conversation (PRD-22), documents (PRD-23), activity (PRD-25),
  owner control (PRD-21), participants and parties (PRD-24)
- Navigation entry, plus links from the dashboard rows and from the review page
- A **minimal flat index** at `GET /workspaces` so the nav entry has a destination — see the
  decision below; explicitly not PRD-20's queue view
- Work status control in the header, wired to `setWorkStatus()` from PRD-18
- A **resync control** exposing PRD-18's `resyncWorkStatus()`, without which a coordinator who
  overrides the work status once can never hand it back to the protocol mapping

**Out of Scope:**
- Any change to `/referrals/:id/review` beyond adding a link to the workspace
- The contents of the placeholder panels — each is its own PRD
- Queue and list views — PRD-20
- Guest-facing rendering of this page — PRD-30 defines the guest view and what it omits
- Live updates; the page loads its payload once and reloads after a write, matching every other view

---

## Decisions taken before implementation

A codebase pass turned up four things the draft assumed. Recorded here so the ACs below are
buildable as written.

**1. The nav entry needed a destination — a minimal flat index at `GET /workspaces`.**
AC15 asks for a "Workspaces" nav entry, but `/workspaces` with no id had nothing to render and the
list view is PRD-20. Without one the workspace is reachable only by typing a URL or from a dashboard
row, which makes the deliverable much less useful than it looks.

So this PRD adds a flat index: every workspace, with patient, both statuses and owner. Deliberately
**not** PRD-20's queue view — no tabs, no filters, no queue grouping, no assignment, no
`allQueuesAccess` scoping. Those are what PRD-20 adds, and it may replace this page outright rather
than extend it. The index exists to make the detail page reachable, nothing more.

**2. The work-status control needs a resync alongside it.**
PRD-18 built `resyncWorkStatus()` and called it a required escape hatch: without it one manual
override freezes the work status for the life of the workspace. AC7 as drafted wires only
`setWorkStatus()`, which *sets* the manual flag — so the drafted UI could create the frozen state and
offered no way out of it. The header therefore shows a "follow protocol again" action whenever
`workStatusIsManual` is true, and hides it when the mapping is already in control.

**3. `PriorAuthSummary` and `PartySummary` do not exist.**
The payload names both as though they were existing types. `PartySummary` is PRD-24's and the field
stays `[]` until then. `PriorAuthSummary` is this PRD's to define — the prior-auth panel is in scope
here — built over the existing `prior_auth_requests` / `prior_auth_responses` tables.

**4. `queueName` is always `null` in Phase 2.**
There is no queues table until PRD-20, so `queueId` has nothing to resolve against. The field stays
in the payload because PRD-20 fills it, and the header renders "Unassigned" per AC2. Worth stating so
a reader does not go looking for the join.

**Closure-rule correction (PRD-18 v1.2).** Settled while implementing this PRD, because this is the
page that surfaces it: `hasOpenInternalItems()` is `false` in Phase 1, so `Closed-Confirmed` derives
`Resolved`. Previously every closed referral derived `Follow-up-Required` — 30 of the 100 demo
referrals — which would have made this page's first impression a queue full of false follow-ups.

---

## User Stories & Acceptance Criteria

### As a care coordinator, I want one page per referral that tells me who owns it and what happens next, so that I can stop reconstructing that from a status column

**AC1:** `GET /workspaces/:id` renders a page whose header shows patient name and DOB, reason for
referral, initiating and receiving organization, owner, owning queue, next action and due date.  
**AC2:** Any header field with no value yet shows an explicit empty state (an em dash or "Unassigned"),
never a blank or `undefined`.  
**AC3:** The page renders for a referral in every protocol state, including `Declined` and
`Closed-Confirmed`, without error.  
**AC4:** An unknown or non-numeric workspace id returns a 404 page, not a stack trace.

### As a care coordinator, I want the 360X status and the internal work status shown as two different things, so that I never mistake one for the other

**AC5:** The header shows two labelled badges — "360X Status" and "Work Status" — visually distinct in
shape or colour treatment, never adjacent pills of the same style.  
**AC6:** Hovering or expanding each badge explains what it means: one is what the counterparty has
been told, the other is internal processing.  
**AC7:** The work status is changeable from the header by a control that calls `setWorkStatus()`, and
only offers transitions the machine permits from the current status.  
**AC7a:** When `workStatusIsManual` is true the header offers a "follow protocol again" action that
calls `resyncWorkStatus()`; when it is false the action is absent and the header says the status is
tracking the protocol. Without this the UI can reach a state it cannot leave.  
**AC8:** There is no control anywhere on the page that changes the 360X status directly; protocol
state changes only through protocol actions.

### As a care coordinator, I want to see the protocol history and the message thread in the workspace, so that I do not have to open a second page to read what was exchanged

**AC9:** The protocol timeline renders with the same step/dot/label/time structure as the review
page's journey timeline, including the No-Show, Consult and Declined branches.  
**AC10:** The message thread renders with the same expand-on-click, lazy content loading and
IN/OUT/ack affordances as the review page, reusing `GET /api/referrals/:id/thread` and
`GET /api/referrals/:id/thread/:messageId/content` unchanged.  
**AC11:** When the referral has an inbound C-CDA, the viewer pane renders it; when it does not, the
layout collapses to a single column without leaving an empty pane.

### As an engineer, I want a defined panel contract, so that PRD-21 through PRD-29 each add one panel without touching the rest of the page

**AC12:** Each panel is a `.card` with a stable container id, and a documented render function that
takes its slice of the payload and owns only its own DOM.  
**AC13:** Placeholder panels render a labelled "coming in PRD-NN" empty state rather than being absent,
so the layout is the real layout from day one.  
**AC14:** Adding a panel requires changes to `workspaceDetail.html` and the `/api/workspaces/:id`
payload only — no change to any other view.

### As a care coordinator, I want to get to the workspace from wherever I am, so that it becomes the place I work

**AC15:** A "Workspaces" nav entry appears on every page rendered through `injectNav()`, pointing at
`GET /workspaces` — the flat index, which lists every workspace with patient, both statuses and
owner, and links each row to its detail page.  
**AC16:** Each dashboard row links to the workspace, and the row preview dropdown gains a
"Open workspace →" link alongside its existing "Open full view →".  
**AC17:** The review page shows a link to the workspace, and the workspace shows a link back to the
review page labelled as the clinical disposition screen.

---

## Technical Specifications

### Dependencies

- [[PRD-17 - Identity & Acting User]] and [[PRD-18 - Workspace Entity & Dual Status]] — prerequisites
- `@kno2/ccdaview` (already mounted at `/static/ccdaview`) for the document pane
- No new dependency

### Engineering Constraints

- **Follow the existing view pattern exactly.** There is no template engine, no client framework and
  no build step for UI. A route reads its `.html` file with `fs.readFileSync` on each request,
  replaces `<!--__NAV__-->` via `injectNav()` and a `/*__WORKSPACE_DATA__*/` token with
  `window.__WORKSPACE_DATA__ = ...`, and sends it. Do not introduce a templating layer here.
- **Reuse the component vocabulary rather than inventing one.** `.card`, `.field`/`.label`/`.value`,
  the `stateBadge()` state-to-class map from `dashboard.html`, `.thread-entry` and its children,
  `.tl-step`/`.tl-dot`/`.tl-connector` from the review page's timeline, `.document-list` from
  `claimsRequestDetail.html`, `.response-timeline` from `priorAuthDetail.html`.
- The design-token `:root` block is copy-pasted into every view today. Copy it again rather than
  refactoring all 21 views in this PRD; a shared stylesheet is a separate cleanup.
- Two status badges must not be styled as two instances of the same pill. Give the work status a
  distinct treatment (for example an outlined chip with a leading glyph) so they are never confused
  at a glance. This is an acceptance criterion, not a preference.
- Writes are `fetch()` with a JSON body, then an inline status message, then `location.reload()` —
  the pattern used by every existing view. There is no `express.urlencoded`.
- Escape all interpolated database strings. Use the `esc()` idiom from `dashboard.html`; several
  existing views interpolate unescaped and this page must not add to that.
- The page must render correctly with a null owner, null queue, null next action and no participants,
  because for all of Phase 2 that is the normal state.

### Data Models

No new tables. The payload assembled by the route:

```typescript
// src/modules/workspace/workspaceView.ts — new
export interface WorkspacePayload {
  workspace: {
    id: number;
    referralId: number;
    workStatus: WorkStatus;
    allowedWorkStatuses: WorkStatus[];   // from the machine, for the header control
    ownerUserId: number | null;
    ownerDisplayName: string | null;     // resolved for display
    queueId: number | null;
    queueName: string | null;     // always null until PRD-20 — no queues table yet
    workStatusIsManual: boolean;  // drives the resync control (AC7a)
    nextAction: string | null;
    nextActionDueAt: string | null;      // ISO
    externalReferralId: string | null;
    exceptionReason: string | null;
    archivedAt: string | null;
  };
  referral: {
    id: number;
    state: ReferralState;
    reasonForReferral: string | null;
    declineReason: string | null;
    referrerAddress: string;
    routingDepartment: string;
    routingEquipment: string[];
    priorityFlag: boolean;
    createdAt: string;
    hasCcda: boolean;
  };
  patient: { firstName: string; lastName: string; dateOfBirth: string };
  parties: PartySummary[];               // always [] until PRD-24, which defines the type
  clinicalData: ExtendedReferralData | null;
  assessment: RoutingAssessment | null;
  priorAuth: PriorAuthSummary[];
  actingUser: ActingUser;
  departments: string[];
  slots: { conversation: false; documents: false; activity: false; participants: false };
}
```

The `slots` flags let each later PRD flip its own panel on without the shell needing to know what
the panel contains.

**Panel contract**

| Panel | Container id | Render function | Source |
|---|---|---|---|
| Header | `#wsHeader` | `renderHeader(p)` | this PRD |
| Protocol timeline | `#wsTimeline` | `renderTimeline(p)` | this PRD (ported from review page) |
| Message thread | `#wsThread` | `loadThread(referralId)` | this PRD (reused as-is) |
| Clinical data | `#wsClinical` | `renderClinical(p)` | this PRD |
| Routing | `#wsRouting` | `renderRouting(p)` | this PRD |
| Prior auth | `#wsPriorAuth` | `renderPriorAuth(p)` | this PRD |
| C-CDA viewer | `#wsCcdaPanel` | `mountViewer(referralId)` | this PRD |
| Owner control | `#wsOwner` | `renderOwner(p)` | PRD-21 |
| Parties & participants | `#wsParticipants` | `renderParticipants(p)` | PRD-24 |
| Conversation | `#wsConversation` | `renderConversation(p)` | PRD-22 |
| Documents | `#wsDocuments` | `renderDocuments(p)` | PRD-23 |
| Activity | `#wsActivity` | `renderActivity(p)` | PRD-25 |

### API Design

**Endpoint:** `GET /workspaces` — HTML page, the flat index. No filters or query parameters; PRD-20
owns those.

**Endpoint:** `GET /workspaces/:id` — HTML page.

**Endpoint:** `GET /api/workspaces/:id` — the `WorkspacePayload` above. 404 with
`{ "error": "Workspace not found" }` for an unknown id.

**Endpoint:** `POST /api/workspaces/:id/work-status`

**Request:**
```json
{ "workStatus": "Waiting-Internal", "reason": "Awaiting prior imaging from referrer" }
```

**Response:**
```json
{ "success": true, "workStatus": "Waiting-Internal" }
```

Returns 409 with the allowed transitions when the requested status is not reachable from the current
one.

**Endpoint:** `POST /api/workspaces/:id/resync`

Clears the manual flag and applies the mapping for the referral's current protocol state. No body.
Responds `{ "success": true, "workStatus": "<resulting status>" }`.

**Convenience:** `GET /referrals/:referralId/workspace` → 302 to `/workspaces/:id`, so existing
referral-centric links can be redirected without the caller knowing the workspace id. Verified not to
collide with the existing `/referrals/:id/*` routes (`review`, `disposition`, `schedule`,
`encounter`, `no-show`, `consult`, `consult/resolve`, `consult-note`, `override`, `ccda.xml`,
`medications`, `fhir-medications`).

---

## Test Plan

**Unit Tests:**
- `buildWorkspacePayload()` resolves owner and queue display names, and returns nulls rather than
  throwing when they are unset
- `allowedWorkStatuses` matches the machine's transition table for each current status
- `POST /api/workspaces/:id/work-status` returns 409 for a disallowed transition and does not write
- `GET /api/workspaces/:id` 404s for an unknown id

**Integration Tests:**
- Render the page for a referral in each protocol state and assert the header fields and both badges
- Render for a referral with no C-CDA and assert the single-column layout with no empty viewer pane
- Change work status from the header and assert the referral's protocol state is unchanged
- Navigate dashboard → workspace → review page → back to workspace

**Edge Cases:**
- Workspace with no owner, no queue, no next action, no participants (the Phase 2 normal case)
- Archived workspace — renders read-only with an archived banner
- Workspace in `Exception` — renders the exception reason prominently
- A referral with 50+ thread messages — the thread stays usable and does not block first paint
- Patient name and decline reason containing HTML-significant characters — escaped

**Regression:**
- `/referrals/:id/review` renders unchanged; its own tests pass
- The thread APIs are called with no signature change

---

## Deliverables

- `src/views/workspaceDetail.html`, `src/views/workspaceIndex.html`
- `src/modules/workspace/workspaceView.ts` (`buildWorkspacePayload`)
- Routes `GET /workspaces`, `GET /workspaces/:id`, `GET /api/workspaces/:id`,
  `POST /api/workspaces/:id/work-status`, `POST /api/workspaces/:id/resync`,
  `GET /referrals/:referralId/workspace`
- "Workspaces" nav entry in `NAV_HTML`; workspace links in `dashboard.html` and
  `referralReview.html`
- `tests/unit/workspace/workspaceView.test.ts`

---

## Related Documents

- [[PRD-16 - 360X Referral Collaboration Workspace|Epic]]
- [[PRD-18 - Workspace Entity & Dual Status]] — prerequisite
- [[PRD-10 - UI Modernization & CCDA Viewer]] — the viewer and design tokens being reused
- [[PRD-21 - Ownership & Assignment]], [[PRD-22 - Referral Conversation]],
  [[PRD-23 - Document Collection]], [[PRD-24 - Parties & Participants]],
  [[PRD-25 - Activity History & Audit]] — fill the reserved slots
- [[📋 PRD Index|PRD Index]]

---

## History

**Created:** 2026-09-14  
**Last Updated:** 2026-09-14  
**Version:** 1.0 — first draft.

**Version:** 1.1 — Ready for Dev. Codebase pass: added the minimal flat index at `/workspaces` so
AC15's nav entry has a destination; added AC7a so the resync escape hatch PRD-18 built is actually
reachable from the UI; recorded that `PriorAuthSummary` is defined here and `PartySummary` is PRD-24's;
recorded that `queueName` is always null until PRD-20; verified the thread APIs, the ccdaview mount,
the reused CSS vocabulary and the absence of a `/referrals/:id/workspace` route collision. Carries the
PRD-18 v1.2 closure-rule correction, settled here because this is the page that surfaces it.
