---
title: Feature - Human-Readable Message Type Labels
tags: [feature, ux, inbox]
aliases: [Message Type Labels, Readable Message Types]
up: "[[📋 PRD Index]]"
same: "[[Feature - Human-Readable Email Summaries]]"
---

## Human-Readable Message Type Labels in Inbox

**Status:** Ready for Dev
**Team:** Engineering
**Epic:** [[📋 PRD Index|Referral Workflow]]
**Priority:** Low

### Context

The message history inbox (`/messages`) displays raw technical identifiers as message type badges — `RRI`, `SIU`, `ConsultNote`, `InterimUpdate`, `InfoRequest`. These values are HL7 standard codes and internal system identifiers that clinician users are not expected to recognize. The filter dropdown repeats the same raw values. This creates unnecessary friction for clinical and administrative staff reviewing message history.

The fix is purely a UI presentation layer change — the underlying DB values and JS filter logic remain unchanged. A mapping function in the template converts raw types to plain English at render time.

---

### Goal

- Replace all raw technical message type strings visible in the UI with plain English descriptions
- Maintain correct filter behavior (filter values still match raw DB values)
- Zero changes to database schema, TypeScript services, or stored data

---

### User Stories

- As a clinician reviewing message history, I want message type labels to use plain English descriptions so that I can understand what each message represents without HL7 knowledge.
- As an admin filtering message history, I want the type filter dropdown to show human-readable labels so that I can select the right type without guessing what `RRI` or `SIU` means.

---

### Acceptance Criteria

- **AC1:** The message type badge in `messageHistory.html` displays plain English for all five types: `RRI` → `Referral Response`, `SIU` → `Appointment Notification`, `ConsultNote` → `Consult Note`, `InterimUpdate` → `Interim Update`, `InfoRequest` → `Information Request`.
- **AC2:** The filter dropdown in `messageHistory.html` shows plain English labels while keeping raw DB values as the `value` attribute so filtering continues to work correctly.
- **AC3:** The `InfoRequest` type is added to the filter dropdown (currently missing).
- **AC4:** Any unknown/future message type falls back to displaying the raw value unchanged.
- **AC5:** No changes to TypeScript source files, DB schema, or stored data.

---

## Technical Specifications

### Dependencies

- None — pure HTML/JS template change.

### Engineering Constraints

- Filter comparison logic uses `m.messageType === selectedFilter` against raw DB values. The `value` attribute on `<option>` elements must remain the raw DB string; only the display text changes.
- The mapping function must have a fallback (`?? type`) so unknown future types display gracefully.

### Implementation

**File:** `src/views/messageHistory.html`

Add a JS helper to the inline `<script>` block:

```js
function formatMessageType(type) {
  const labels = {
    RRI: 'Referral Response',
    SIU: 'Appointment Notification',
    ConsultNote: 'Consult Note',
    InterimUpdate: 'Interim Update',
    InfoRequest: 'Information Request',
  };
  return labels[type] ?? type;
}
```

Apply in the type badge render (currently line ~149):
```js
<span class="type-badge">${formatMessageType(m.messageType)}</span>
```

Update filter dropdown option text (currently lines ~65–71), keeping `value` attributes as-is:
```html
<option value="RRI">Referral Response</option>
<option value="SIU">Appointment Notification</option>
<option value="InterimUpdate">Interim Update</option>
<option value="ConsultNote">Consult Note</option>
<option value="InfoRequest">Information Request</option>  <!-- add this -->
```

### Test Plan

- **Manual:** `npm run dev` → visit `localhost:3001/messages` → confirm badges show plain English
- **Manual:** Use filter dropdown → confirm each filter still correctly narrows the message list
- **Unit Tests:** No new tests required — this is a pure presentation layer change with no logic

### Deliverables

- `src/views/messageHistory.html` — add `formatMessageType()` helper, apply to badge render, update filter dropdown labels, add missing `InfoRequest` option

---

## Design Notes

No visual design changes — only the text content of the existing `type-badge` spans and dropdown options changes. No new CSS or layout work needed.

---

## Related Documents

- [[📋 PRD Index|PRD Index]]
- [[Feature - Human-Readable Email Summaries]]
