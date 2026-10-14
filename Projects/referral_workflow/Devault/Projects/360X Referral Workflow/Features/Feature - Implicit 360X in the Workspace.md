---
title: Feature - Implicit 360X in the Workspace
tags: [feature, workspace, 360x, email]
aliases: [Implicit 360X, 360X by Default]
up: "[[📋 PRD Index]]"
same: "[[PRD-29 - 360X Protocol Gateway]]"
---

## Implicit 360X in the Workspace

**Status:** In Progress
**Team:** Engineering
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]
**Priority:** High

### Context

PRD-24 gave every organization on a referral a declared **protocol mode** (`native-360x`,
`workspace-mediated`, `local-only`) and put a dropdown, a "Set mode" button, an explanatory sentence
and an "assumed / verified" tag on the party card. That asks a coordinator to state whether the other
organization can use 360X, which they usually cannot know and should not have to.

Outside the workspace, 360X context is silent: it rides along with a message, and a receiver whose
software does not understand it simply ignores it. The workspace gateway (PRD-29) did not behave that
way. It mailed the raw HL7 or C-CDA text as the message body under a `360X <type>` subject, so a
receiver without 360X software saw pipe-delimited HL7 instead of a readable note.

The declared mode also gated almost nothing: the gateway transmits whenever a Direct address is on
file. Its one behavioral use is that a `local-only` party is never shown as owing the next move.

---

### Goal

- 360X context is included on every workspace message by default, with nothing to assign or declare.
- A receiver that cannot process 360X gets a readable message and loses nothing.
- No user is asked about, or shown, another organization's 360X capability.

---

### User Stories

- As a referral coordinator, I want to send an update without declaring how the other organization
  handles 360X so that I can work the referral instead of configuring it.
- As a receiving clinician without 360X software, I want workspace messages to read as plain notes so
  that I can act on them without decoding HL7.
- As an organization with 360X software, I want the structured artifact and its identifiers on every
  message so that my system can process it automatically.

---

### Acceptance Criteria

- **AC1:** The party card has no protocol-mode selector, no "Set mode" button, no mode sentence and no
  assumed/verified capability tag. The guest page has no protocol-mode sentence.
- **AC2:** The stored protocol mode is derived, not declared: a party with a Direct address is
  `workspace-mediated`, a party without one is `local-only`, and adding or clearing the address moves
  it accordingly.
- **AC3:** A delivered workspace message has a plain-language subject and body. Neither contains raw
  HL7 or XML, and the subject does not mention 360X.
- **AC4:** A structured artifact (RRI, SIU, ACK, consult note, MDN) travels as an attachment.
- **AC5:** Every delivered workspace message carries `X-360X-Message-Type` and
  `X-360X-Message-Control-Id` headers, plus `X-360X-Referral-Id` when the referral has a known id.
- **AC6:** Delivery facts stay visible: "recorded, not sent" and "Send now" are unchanged, and a guest
  whose organization has no Direct address is still told nothing is transmitted to them.
- **AC7:** `360X Status`, `360X Actions` and `360X Protocol Journey` labels are unchanged.

---

## Technical Specifications

### Engineering Constraints

- No migration. `workspace_parties.protocol_mode` and the `/protocol-mode` endpoint stay, so history,
  next-action logic (PRD-26 AC12) and existing API callers keep working.
- The `X-360X-*` headers are this application's own convention. 360X itself carries context in XDM
  metadata and HL7 segments, which the attached artifact still contains; the headers only let a
  receiver route a message without opening the attachment.
- Only the gateway's delivery changes. The older PRD-03/04/05/09/11 senders are untouched.

### Test Plan

- **Unit Tests:** mode re-derivation in `updateParty()`; subject, body, attachment and headers of a
  delivered artifact for a structured and a plain-text assertion.
- **Edge Cases:** a referral with no external id omits `X-360X-Referral-Id`; clearing an address
  returns the party to `local-only`.

### Deliverables

- `messaging/mailer.ts` — accepts attachments and headers.
- `workspace/protocolGateway.ts` — builds the readable message with the artifact attached.
- `workspace/partyService.ts` — derives the mode from the address.
- `views/workspaceDetail.html`, `views/guestWorkspace.html` — capability UI removed.

---

## Related Documents

- [[PRD-24 - Parties & Participants]]
- [[PRD-29 - 360X Protocol Gateway]]
- [[PRD-30 - Guest Participation]]
- [[Feature - Human-Readable Email Summaries]]
