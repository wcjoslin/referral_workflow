---
title: Feature - Human-Readable Email Summaries
tags: [feature, email, ux]
aliases: [Email Summaries, Readable Email]
up: "[[📋 PRD Index]]"
same: "[[Feature - Human-Readable Message Type Labels]]"
---

## Human-Readable HTML Email Summaries

**Status:** Ready for Dev
**Team:** Engineering
**Epic:** [[📋 PRD Index|Referral Workflow]]
**Priority:** Medium

### Context

All outbound emails in the referral workflow currently embed raw HL7 V2 pipe-delimited messages directly in the email body (e.g., `MSH|^~\&|ReferralWorkflow|...`). This format is machine-readable but unintelligible to the referring physicians and hospital staff who receive these emails. As a result, recipients cannot determine the outcome or meaning of a message without technical HL7 knowledge.

The goal is to replace all raw HL7 bodies with professionally formatted HTML summaries that surface the clinically and operationally relevant information in a scannable, readable layout.

---

### Goal

- Replace raw HL7 content in all outbound email bodies with styled HTML summaries
- Ensure all emails are interpretable by non-technical recipients (referring physicians, hospital scheduling staff) without HL7 knowledge
- Maintain full accuracy of clinical and operational data — no information loss, only improved presentation

---

### User Stories

- As a referring physician, I want to receive emails that clearly summarize the outcome of my referral so that I can understand the status without reading raw HL7.
- As a hospital scheduling coordinator, I want appointment confirmation emails to display patient name, date/time, provider, and location clearly so I can verify details at a glance.
- As a referring office coordinator, I want decline emails to clearly state the decline reason so that I can take appropriate next steps without contacting the specialist office.

---

### Acceptance Criteria

- **AC1:** All outbound emails from PRD-01 through PRD-09 use `html:` instead of `text:` in nodemailer, with structured HTML sections (patient, referral, decision/status).
- **AC2:** Raw HL7 pipe-delimited content is completely absent from all email bodies.
- **AC3:** Decision status (accepted, declined, scheduled, etc.) is visually distinguished via a colored badge in the HTML.
- **AC4:** All data fields previously present in the plain-text email are present in the HTML (no information loss).
- **AC5:** HTML uses inline styles only — no CSS classes, no external stylesheets — for maximum email client compatibility.
- **AC6:** Unit tests cover the shared `emailTemplate.ts` helper for all message types and edge cases (missing patient data, null decline reason).

---

## Technical Specifications

### Dependencies

- No new npm dependencies — `nodemailer` already supports `html:` on `sendMail()`.

### Engineering Constraints

- HTML must use inline styles and table-based layout (not flexbox/grid) for compatibility with Outlook, Apple Mail, Gmail.
- Styling must be simple and neutral — no branding colors, no external images.
- The `text:` property should be retained as a plain-text fallback (auto-generated summary) for email clients that don't render HTML.

### Data Models

```typescript
interface EmailSection {
  heading: string;
  rows: Array<[string, string]>;  // [label, value] pairs
}

interface EmailTemplateOptions {
  title: string;
  statusBadge?: {
    label: string;
    color: 'green' | 'red' | 'yellow' | 'blue' | 'gray';
  };
  sections: EmailSection[];
  note?: string;  // footer paragraph
}
```

### Visual Layout (per email type)

**RRI — Accepted:**
- Badge: `ACCEPTED` (green)
- Sections: Patient (name, DOB, ID), Referral (ID, from, to, date, reason), Decision (status: Accepted)

**RRI — Declined:**
- Badge: `DECLINED` (red)
- Sections: Patient, Referral, Decision (status: Declined, reason: `<declineReason>`)

**SIU — Appointment Scheduled:**
- Badge: `APPOINTMENT SCHEDULED` (blue)
- Sections: Patient, Referral, Appointment (date/time, location, provider, duration, type)

**PRD-04 — Consult Note:**
- Badge: `CONSULT NOTE READY` (blue)
- Sections: Patient, Referral (C-CDA attached as file)

**PRD-05 — Interim Encounter Update:**
- Badge: `ENCOUNTER UPDATE` (yellow)
- Sections: Patient, Referral, Encounter (status, event type)

**PRD-09 — Information Request:**
- Badge: `INFORMATION REQUESTED` (yellow)
- Sections: Patient, Referral, Request (missing fields listed)

**PRD-01 — MDN Receipt:**
- Badge: `REFERRAL RECEIVED` (gray)
- Sections: Message (original message ID, received at)

### Test Plan

- **Unit Tests:** `tests/unit/utils/emailTemplate.test.ts` — test `buildEmailHtml()` for each message type, badge color rendering, missing optional fields (null DOB, null decline reason, null patient).
- **Integration Tests:** Verify each service passes `html:` to `transport.sendMail()`.
- **Edge Cases:** Missing patient record, null `declineReason` on RRI, referral with no `reasonForReferral`, missing `patientDob`.

### Deliverables

- `src/utils/emailTemplate.ts` — shared HTML builder utility
- `src/modules/prd01/mdnService.ts` — updated to use HTML
- `src/modules/prd02/dispositionService.ts` — updated; requires patient DB lookup before send
- `src/modules/prd03/schedulingService.ts` — updated (patient data already in scope)
- `src/modules/prd04/consultNoteService.ts` — updated
- `src/modules/prd05/encounterService.ts` — updated
- `src/modules/prd09/infoRequestService.ts` — updated
- `tests/unit/utils/emailTemplate.test.ts` — new test file

---

## Design Notes

HTML layout uses a two-column table: left column = label (gray, 140px wide), right column = value. Status badge is a centered pill above the first section. Footer is a horizontal rule followed by a light gray italic note: "This is an automated message from the Referral Workflow system."

---

## Related Documents

- [[📋 PRD Index|PRD Index]]
- [[../Backlog & Ideas/In Progress|In Progress Work]]
- [[PRD-02 - Process & Disposition|PRD-02]]
- [[PRD-03 - Schedule Patient|PRD-03]]
