---
title: In Progress Work
tags: [status, active, tracking]
up: "[[_INDEX]]"
same: "[[Ideas]]"
---

# 🔄 In Progress Work

Real-time tracking of current development and feature work.

## Current Status

**Phase:** Collaboration Workspace epic — specification

The closed-loop protocol core (PRD-01 … PRD-15) is implemented. Current work is the
[[../Features/PRD-16 - 360X Referral Collaboration Workspace|Collaboration Workspace epic]]: turning
each recognized 360X referral into a persistent, accountable workspace, and making the workspace
itself the 360X enablement layer so neither party needs its own protocol implementation.

All fourteen child PRDs (PRD-17 … PRD-30) are written and awaiting refinement. Each is independently
refinable and independently implementable; none has been started in code.

Last Updated: 2026-09-14

---

## Active Work Items

### 1. Collaboration Workspace Epic — PRD Specification (IN PROGRESS 🔧)
- **Owner:** Will Joslin
- **Status:** Drafting — specs written, refinement pending
- **Epic:** [[../Features/PRD-16 - 360X Referral Collaboration Workspace|PRD-16]]
- **Description:** Specification of the referral collaboration workspace derived from the 360X
  software collaboration review. Fourteen child PRDs covering identity, the workspace entity and
  dual status model, the workspace page, queues, ownership, conversation, documents, parties and
  participants, guest participation, the 360X protocol gateway, activity and audit, due dates,
  notifications, and reconciliation.
- **Deliverables:**
  - ✅ Epic: [[../Features/PRD-16 - 360X Referral Collaboration Workspace|PRD-16]]
  - ✅ Phase 1: [[../Features/PRD-17 - Identity & Acting User|PRD-17]], [[../Features/PRD-18 - Workspace Entity & Dual Status|PRD-18]]
  - ✅ Phase 2: [[../Features/PRD-19 - Workspace Shell|PRD-19]], [[../Features/PRD-21 - Ownership & Assignment|PRD-21]], [[../Features/PRD-24 - Parties & Participants|PRD-24]], [[../Features/PRD-30 - Guest Participation|PRD-30]], [[../Features/PRD-29 - 360X Protocol Gateway|PRD-29]]
  - ✅ Phase 3: [[../Features/PRD-22 - Referral Conversation|PRD-22]], [[../Features/PRD-23 - Document Collection|PRD-23]], [[../Features/PRD-25 - Activity History & Audit|PRD-25]]
  - ✅ Phase 4: [[../Features/PRD-20 - Shared Queues & Queue View|PRD-20]], [[../Features/PRD-26 - Next Action & Due Dates|PRD-26]], [[../Features/PRD-27 - Notifications|PRD-27]], [[../Features/PRD-28 - Correlation & Exception Queue|PRD-28]]
  - [ ] Refine each PRD individually
  - [ ] Implement PRD-17 and PRD-18 (the only hard prerequisites)
- **Next:** Refine the Phase 1 PRDs, then implement PRD-17 on `prd-17-identity-acting-user`

---

### 2. Vault Organization (COMPLETE ✅)
- **Owner:** Will Joslin
- **Status:** Completed
- **Description:** Reorganized all markdown files into Obsidian vault structure
- **Deliverables:**
  - ✅ Main index page (`_INDEX.md`)
  - ✅ Project overview page
  - ✅ Architecture documentation (2 pages)
  - ✅ All PRDs organized in Features folder (PRD-01 through PRD-07)
  - ✅ Engineering specs and guidelines
  - ✅ Templates for future features
  - ✅ Ideas & backlog tracking
- **Next:** Use this vault for ongoing feature documentation and planning

---

## Upcoming Work Items

### 3. Workspace Foundation — PRD-17 & PRD-18 (Next)
- **Epic:** [[../Features/PRD-16 - 360X Referral Collaboration Workspace|PRD-16]]
- **Estimated Start:** After Phase 1 refinement
- **Key Tasks:**
  - [ ] `users` table + acting-user picker, `user:<id>` audit actors (PRD-17)
  - [ ] `referral_workspaces` table + `workStatusMachine.ts` (PRD-18)
  - [ ] Workspace creation wired into `ingestReferral()` + backfill script
  - [ ] Confirm analytics actor parsing is unaffected
- **Related:** [[../Features/PRD-17 - Identity & Acting User|PRD-17]], [[../Features/PRD-18 - Workspace Entity & Dual Status|PRD-18]]

### 4. Workspace Surface & Cross-Party Enablement (Then)
- **Epic:** [[../Features/PRD-16 - 360X Referral Collaboration Workspace|PRD-16]]
- **Estimated Start:** After the foundation ships
- **Key Tasks:**
  - [ ] `/workspaces/:id` shell with dual status badges and panel slots (PRD-19)
  - [ ] Ownership and assignment (PRD-21)
  - [ ] Parties & participants, including protocol mode (PRD-24)
  - [ ] Guest invitations scoped to one workspace (PRD-30)
  - [ ] 360X context authoring and artifact rendering (PRD-29)
- **Related:** [[../Features/PRD-29 - 360X Protocol Gateway|PRD-29]], [[../Features/PRD-30 - Guest Participation|PRD-30]]

---

## Blocked Items

None currently.

---

## Completed PRDs

The closed-loop protocol core is implemented (PRD-08 through PRD-15 are recorded in
[[../Features/📋 PRD Index|the PRD Index]]):

| PRD | Name | Status | Completed |
|-----|------|--------|-----------|
| [[../Features/PRD-01 - Receive & Acknowledge\|01]] | Receive & Acknowledge | ✅ Complete | ✓ |
| [[../Features/PRD-02 - Process & Disposition\|02]] | Process & Disposition | ✅ Complete | ✓ |
| [[../Features/PRD-03 - Schedule Patient\|03]] | Schedule Patient | ✅ Complete | ✓ |
| [[../Features/PRD-04 - Generate Consult Note\|04]] | Generate Consult Note | ✅ Complete | ✓ |
| [[../Features/PRD-05 - Patient Encounter\|05]] | Patient Encounter | ✅ Complete | ✓ |
| [[../Features/PRD-06 - Close Loop\|06]] | Close Loop | ✅ Complete | ✓ |
| [[../Features/PRD-07 - Ack Tracking\|07]] | Ack Tracking | ✅ Complete | ✓ |

---

## Notes

- All testing and linting checks passing
- Happy path demo fully functional with mock scripts
- Current focus: refining the Collaboration Workspace epic before any of it is built
- Known gaps the epic addresses deliberately: no identity layer, one status dimension only, no
  per-referral read of the `workflow_events` log, unmatched ACKs discarded, `prd07/overdueChecker.ts`
  never wired into `src/index.ts`

---

## How to Update This Page

- **Starting new work:** Add a numbered section with Status, Owner, and Key Tasks
- **Completing work:** Move to "Completed PRDs" or mark with ✅
- **Blocking issues:** Add to "Blocked Items" with context and next steps
- **Quick status updates:** Use check marks (`[ ]` pending, `[x]` complete)

---

## Related Documents

- [[Ideas|Ideas & Future Features]]
- [[../Features/📋 PRD Index|Current PRDs]]
- [[../Features/PRD-16 - 360X Referral Collaboration Workspace|Collaboration Workspace Epic]]
- [[../🎯 PROJECT OVERVIEW|Project Overview]]
