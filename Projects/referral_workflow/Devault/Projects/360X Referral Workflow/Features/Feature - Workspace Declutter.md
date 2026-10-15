---
title: Feature - Workspace Declutter
tags: [feature, workspace, ux]
aliases: [Workspace Declutter, At-a-glance Banner]
up: "[[📋 PRD Index]]"
same: "[[PRD-19 - Workspace Shell]]"
---

## Workspace Declutter

**Status:** In Progress
**Team:** Engineering
**Epic:** [[PRD-16 - 360X Referral Collaboration Workspace]]
**Priority:** Medium

### Context

The workspace page (`/workspaces/:id`) shows every section fully expanded. Two of them, Exchanged
Messages and Activity History, are audit material that can run to dozens of entries, and they push
the working sections down. The protocol journey, routing and clinical data each sit in their own card
even though they are the facts a person wants on arrival. The embedded C-CDA viewer duplicates the
clinical disposition screen the workspace already links to.

---

### Goal

- The top banner answers "where is this referral, where is it going, and what is wrong with the
  patient" without scrolling.
- Audit sections stay one click away instead of always expanded.

---

### User Stories

- As a coordinator, I want the protocol status, routing and a clinical summary in the banner so that
  I can orient myself on a referral at a glance.
- As a coordinator, I want message and activity history collapsed by default so that the sections I
  act in are not buried.

---

### Acceptance Criteria

- **AC1:** The banner shows the 360X status with a compact protocol journey, a Routing summary
  (department, equipment, appointment when scheduled, AI suggestion) and a Clinical summary
  (problems, medications, allergies, and results when present).
- **AC2:** The separate Protocol Journey, Routing and Clinical Data cards are gone, and the banner's
  details grid no longer repeats the receiving department.
- **AC3:** Exchanged Messages and Activity History render collapsed, with their count visible in the
  collapsed header. Either opens on click, and opens on load when the URL fragment targets it
  (`#wsActivity`, `#wsThread`).
- **AC4:** Activity History stays open across its filter tabs and reloads once a person opens it.
- **AC5:** The Referral Document (C-CDA) panel is removed. Documents and Prior Authorization sit in a
  right-hand column on wide screens and stack below on narrow ones.
- **AC6:** The explanations under 360X Status, Work Status and Next action are ⓘ tips beside their
  labels, shown on hover, tap or keyboard focus, and never wider than the window.
- **AC7:** The work-status picker and the next-action and due-date overrides are hidden behind
  "Change" and "Edit". "Follow protocol again" and "Reset to rule" stay visible whenever there is a
  manual hold or an override to undo.

---

## Technical Specifications

### Engineering Constraints

- View-only change in `src/views/workspaceDetail.html`. No API or payload change; `hasCcda` stays
  in the payload for the documents and review surfaces.
- The C-CDA frame routes stay; the review page and the documents panel still use them.

### Test Plan

- Page check: `/workspaces/1` renders with no console errors and no empty cards.
- Smoke check: the detail page still wires a viewer to a `/ccda-frame` route (the documents panel)
  and still hand-rolls none.
- Manual: banner at desktop and phone width; collapsed sections open by click and by fragment.

---

## Related Documents

- [[PRD-19 - Workspace Shell]]
- [[PRD-25 - Activity History & Audit]]
- [[Feature - Implicit 360X in the Workspace]]
