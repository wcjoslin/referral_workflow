---
title: PRD-10 - UI Modernization & CCDA Viewer
tags: [prd, ui, frontend, ccda]
aliases: [PRD-10]
up: "[[📋 PRD Index]]"
same: "[[PRD-11 - No-Show & Consult States]]"
---

# PRD-10: UI Modernization & CCDA Viewer

**Status:** Drafting  
**Team:** Frontend / Full-Stack  
**Module:** `views/` + `server.ts`  
**Epic:** Clinician Experience

---

## Overview

### Context

The referral workflow UI was built iteratively alongside the backend, resulting in 15 HTML templates with inconsistent styling, hardcoded hex colors scattered across individual `<style>` blocks, and a plain list-based clinical data display. The clinical information section of the referral review page shows problems, medications, allergies, and diagnostic results as unstyled bullet lists — far from the structured, scannable clinical document format that clinicians expect.

The goal is to align the UI with the Concord Technologies visual design language (dark teal navigation, teal accent colors, clean white card surfaces) and to render incoming C-CDA clinical documents using the `@kno2/ccdaview` Riot.js viewer library for a proper structured clinical document experience on the referral review page.

### Goal

The primary goal of this feature is to:
1. Establish a shared CSS design system using CSS custom properties (tokens) based on the Concord Technologies color palette, injected globally via the existing `NAV_HTML` mechanism in `server.ts`
2. Integrate `@kno2/ccdaview` into the referral review page to render incoming C-CDA documents as structured clinical documents, with color overrides to match the Concord palette
3. Apply the Concord design system consistently across all 15 HTML view templates

### Scope

**In Scope:**
- Shared CSS token system (`--color-*` custom properties) injected via `NAV_HTML` in `server.ts`
- Nav bar color update from `#1a1a2e` to `#0d2d3a` (dark teal)
- Split-panel layout on the referral review page: existing left panel (unchanged) + new right panel with `@kno2/ccdaview`
- Bootstrap 4 + ccdaview Concord color overrides
- Storage of raw C-CDA XML in the database (new `raw_ccda_xml` column on `referrals` table)
- Endpoint to serve raw C-CDA XML: `GET /referrals/:id/ccda.xml`
- ccdaview right panel hidden/collapsed gracefully when no raw XML is stored (pre-migration records or seeded demo referrals)
- Restyling of all 15 `src/views/*.html` templates to use Concord CSS tokens
- Static file serving for ccdaview, Bootstrap 4, and jQuery dist bundles

**Out of Scope:**
- Any modification to the existing left-panel clinical data display (problems, allergies, medications, AI assessment with FHIR+CCDA badges stay exactly as-is)
- Merging FHIR data into the ccdaview right panel — it renders only the original C-CDA XML
- XSLT-based CCDA rendering
- Replacing the vanilla JS / inline HTML template architecture with a framework (React, Vue, etc.)
- Changes to backend business logic, state machine, or HL7 message handling
- Restyling of the Mermaid.js diagrams in `workflowOverview.html`
- Mobile / responsive design (desktop-first only)
- Dark mode

---

## User Stories & Acceptance Criteria

### As a clinician, I want to see the original C-CDA referral document alongside the processed data so that I can cross-reference the raw clinical document while reviewing the enriched data.

**AC1:** The referral review page renders as a two-column split layout: the existing review panel on the left, and a scrollable `@kno2/ccdaview` document panel on the right.  
**AC2:** The left panel is unchanged — patient demographics, referral details, clinical info with `[C-CDA]`/`[FHIR]` source badges, AI assessment, and disposition decision render exactly as before.  
**AC3:** The right ccdaview panel contains only the original C-CDA XML with no FHIR data merged in.  
**AC4:** The right panel is scrollable and inset (fixed height, overflow scroll) so that an arbitrarily large C-CDA document does not overflow the page or push the disposition action card out of view.  
**AC5:** The ccdaview component uses the Concord teal palette (primary accent `#009aab`) rather than Bootstrap 4 defaults.  
**AC6:** When no raw XML is stored (e.g., seeded demo referrals), the right panel collapses gracefully with a muted "Original document not available" placeholder — the left panel fills full width.

### As a clinician, I want a consistent, professional UI across all pages so that the application feels polished and trustworthy.

**AC1:** All pages share the same Concord color palette: dark teal nav (`#0d2d3a`), teal accent (`#009aab`), light gray body (`#f5f7f9`), white cards, teal table row hover.  
**AC2:** The navigation bar correctly highlights the active page link in white.  
**AC3:** Stat card numbers on the dashboard and inbox pages use semantically appropriate teal/yellow/red accent colors.  
**AC4:** All tables across the app use consistent header styling (light gray `#f0f2f4`, uppercase small caps labels).

### As a developer, I want shared CSS tokens defined in one place so that future color changes require editing a single constant.

**AC1:** All color values in the 15 HTML templates reference `var(--color-*)` custom properties rather than hardcoded hex values for palette colors.  
**AC2:** The CSS token block is injected via the existing `injectNav()` function in `server.ts` — no new injection mechanism required.  
**AC3:** `npm run build` passes TypeScript strict-mode compilation with no new errors.

---

## Technical Specifications

### Dependencies

- `@kno2/ccdaview` (^2.0.2) — Riot.js-based C-CDA structured document viewer. Accepts raw CCDA XML via URL. Renders as `<sialia>` custom element.
- `bootstrap` (^4.x) — Peer dependency required by ccdaview. Served as static file from `node_modules/`.
- `jquery` (^3.x) — Peer dependency required by Bootstrap 4 and ccdaview. Served as static file.

### Engineering Constraints

- No build system changes — no webpack, no SCSS compilation. CSS customization for ccdaview is done via override stylesheets loaded after the ccdaview bundle.
- No new template engine — all 15 templates remain pure HTML with string replacement data injection (`window.__DATA__`).
- The `<style>` block in `NAV_HTML` is injected into `<body>` (not `<head>`) since the injection point `<!--__NAV__-->` is in the body of each template. This is browser-tolerated but non-conforming HTML.
- Static file serving must be added to `server.ts` for the ccdaview, Bootstrap, and jQuery dist bundles. These are large vendor bundles — ensure they are only loaded on pages that need them (ccdaview loaded only in `referralReview.html`).

### Data Models

New column on the `referrals` table:

```typescript
// src/db/schema.ts addition
rawCcdaXml: text('raw_ccda_xml'),  // nullable; stores the original inbound C-CDA XML string
```

Updated parser return type:

```typescript
// src/modules/prd01/cdaParser.ts
interface ParsedCda {
  patient: PatientData;
  referral: ReferralData;
  clinical: ClinicalData;
  rawXml: string;         // NEW: the original XML string passed to parseCda()
}
```

Page data flag injected in the referral review route — all existing fields remain unchanged:

```typescript
// src/server.ts — referral review route (additive change only)
const pageData = {
  // ... all existing fields unchanged ...
  hasCcda: !!referral.rawCcdaXml,  // NEW: boolean flag drives right-panel visibility
  // rawCcdaXml itself is NOT sent to the page — served separately via /referrals/:id/ccda.xml
};
```

### API Design

**Endpoint:** `GET /referrals/:id/ccda.xml`

Serves the raw C-CDA XML for consumption by the ccdaview library. Returns 404 if no XML is stored.

**Response (success):**
```
Content-Type: text/html; charset=utf-8
<ClinicalDocument xmlns="urn:hl7-org:v3" ...>
  ...
</ClinicalDocument>
```

**Response (not found):**
```
HTTP 404
No CCDA document available
```

> Note: `Content-Type: text/html; charset=utf-8` is required by the ccdaview library per its documentation, even though the body is XML.

**Static endpoints (new):**

| Path | Serves |
|------|--------|
| `/static/ccdaview/*` | `node_modules/@kno2/ccdaview/dist/` |
| `/static/bootstrap/*` | `node_modules/bootstrap/dist/` |
| `/static/jquery/*` | `node_modules/jquery/dist/` |

---

## Implementation Phases

### Phase 1 — Shared CSS Foundation (`server.ts`)
Extend `NAV_HTML` constant to prepend a `<style>` block with all CSS custom properties and shared component classes (`.card`, `.card-header`, `.data-table`, `.badge`, `.page-title`). Update nav background to `#0d2d3a`. Add active-link detection script.

### Phase 2 — Install & Serve ccdaview (`server.ts`)
`npm install @kno2/ccdaview bootstrap jquery`. Add three `express.static` routes for vendor bundles.

### Phase 3 — Store Raw CCDA XML
- `src/db/schema.ts`: add `rawCcdaXml` column
- `src/modules/prd01/cdaParser.ts`: return `rawXml` in parse result
- `src/modules/prd01/messageProcessor.ts`: persist `rawXml` to DB
- `src/server.ts`: add `GET /referrals/:id/ccda.xml` endpoint

### Phase 4 — Referral Review Page (`referralReview.html`)
- Load ccdaview, Bootstrap, jQuery in `<head>`
- Change top-level layout from single-column to a two-column CSS grid (e.g., `grid-template-columns: 1fr 420px` or similar)
- Left column: existing review content **unchanged** (timeline, demographics, referral details, clinical info with FHIR badges, AI assessment, disposition)
- Right column: new `<aside>` panel containing the `<sialia>` component in a fixed-height, `overflow-y: scroll` inset container (e.g., `height: calc(100vh - 80px); position: sticky; top: 72px`) so the document scrolls independently while the left panel and nav remain accessible
- Add a panel header ("Original CCDA Document") using Concord card-header styling, with a muted `[C-CDA only]` label to make clear FHIR data is not included
- When `hasCcda` is false: hide the right column entirely and restore the left column to full width
- Add Concord color override CSS after ccdaview stylesheet
- Update all card/field CSS on the left panel to use shared CSS tokens (no functional changes)

### Phase 5 — Dashboard & Inbox
Apply shared classes and token references to `dashboard.html` and `messageHistory.html`. Remove duplicated style declarations.

### Phase 6 — All Remaining Templates
Apply Concord token system to the remaining 12 templates: `claimsQueue.html`, `claimsRequestDetail.html`, `schedulerQueue.html`, `scheduleAppointment.html`, `encounterAction.html`, `consultNoteAction.html`, `rulesAdmin.html`, `ruleCreate.html`, `ruleEdit.html`, `ruleHistory.html`, `workflowOverview.html`, `demoLauncher.html`.

---

## Test Plan

**Unit Tests:**
- `cdaParser.ts`: verify `rawXml` is returned alongside parsed data
- `messageProcessor.ts`: verify `rawCcdaXml` is persisted to DB on referral create/update
- CCDA XML endpoint: verify 200 + correct content-type for stored XML; verify 404 for referral without XML

**Integration Tests:**
- Full demo flow: seed → launch demo → navigate to referral review → confirm ccdaview renders (or fallback renders if seeded referral has no raw XML)
- Static file serving: confirm `/static/ccdaview/ccdaview.js` returns 200

**Edge Cases:**
- Referral with `rawCcdaXml = null` (seeded demo data): right panel collapses, left panel expands to full width, no JS errors
- Existing referral review functionality (FHIR badges, disposition action, AI assessment) must be completely unaffected by the layout change
- CCDA XML from a sender with minimal narrative `<text>` sections: ccdaview should still render without crashing
- Very large C-CDA XML (e.g., 500KB+): right panel scrolls internally without affecting page scroll or disposition card visibility
- Browser with strict CSP: verify no inline script violations (the active-link nav script may need review)

**Visual Spot Checks (manual):**
- Dashboard: teal row hover, teal accent stat numbers, new nav color
- Referral review: ccdaview renders, teal section headers, Concord color overrides applied
- Inbox: teal link colors, filter select teal focus ring
- All pages: nav active link highlighted white

---

## Deliverables

- Modified `src/server.ts` (shared CSS injection, static serving, CCDA XML endpoint)
- Modified `src/db/schema.ts` (new `raw_ccda_xml` column)
- DB migration files (auto-generated via `npm run db:generate`)
- Modified `src/modules/prd01/cdaParser.ts` (return raw XML)
- Modified `src/modules/prd01/messageProcessor.ts` (persist raw XML)
- Modified `src/views/referralReview.html` (ccdaview integration + Concord theme)
- Modified `src/views/dashboard.html` (Concord theme)
- Modified `src/views/messageHistory.html` (Concord theme)
- Modified remaining 12 `src/views/*.html` templates (Concord theme)
- Unit test updates for `cdaParser.ts` and `messageProcessor.ts`

---

## Related Documents

- [[📋 PRD Index|PRD Index]]
- [[PRD-01 - Receive & Acknowledge|PRD-01: Receive and Acknowledge]] — cdaParser.ts is modified in Phase 3
- [[../Architecture/Technical Architecture|Technical Architecture]]

---

## History

**Created:** 2026-04-02  
**Last Updated:** 2026-04-02  
**Version:** 0.1 — Draft
