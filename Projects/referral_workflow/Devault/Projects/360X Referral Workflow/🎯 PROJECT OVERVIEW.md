---
title: 360X Referral Workflow - Project Overview
project: 360X Referral
tags: [project, overview, referral-workflow]
up: "[[_INDEX]]"
down: ["[[360X Workflow Overview]]", "[[Technical Architecture]]", "[[ENGINEERING-PRD-01]]", "[[Gemini Architecture Instructions]]", "[[Gemini PRD Writing Instructions]]", "[[📋 PRD Index]]"]
---

# 🎯 360X Referral Workflow - Project Overview

A **proof of concept for the 360X Closed-Loop Referral process**, bridging traditional healthcare interoperability standards with modern agentic AI.

## 📋 Project Summary

The 360X protocol is a **state machine** where two organizations exchange status updates until a referral is "closed" by a final clinical report. This PoC implements:

- **Direct Secure Messaging** as transport
- **HL7 V2 messages** (REF, RRI, SIU, ACK) for status updates
- **C-CDA documents** for clinical content
- **Claude AI** for clinical reasoning and validation
- **Custom TypeScript state machine** for deterministic workflow management

## 🎯 Core Objectives

1. ✅ Receive and acknowledge referrals via Direct Secure Messaging
2. ✅ Validate referral completeness using AI reasoning
3. ✅ Process clinician accept/decline decisions
4. ✅ Schedule appointments and notify referring provider
5. ✅ Generate final consult notes with clinical AI
6. ✅ Close the loop with final acknowledgment
7. ✅ Track and monitor acknowledgment status
8. ✅ Support FHIR data enrichment
9. ✅ Implement agent-based skills engine

## 🏗️ Architecture

- **No LangGraph** — Custom TypeScript state machine + direct Anthropic SDK
- **MDN** — RFC 3798 (email format), not HL7 V2
- **Database** — SQLite + Drizzle ORM for persistence
- **State Machine** — 9-state workflow (Received → Acknowledged → Accepted/Declined → Scheduled → Encounter → Closed → Closed-Confirmed)
- **Demo Automation** — 4 mock scripts simulate external systems

## 📚 Documentation

### Workflow & Design
- [[Projects/360X Referral Workflow/Architecture/360X Workflow Overview|360X Workflow Overview]]
- [[Projects/360X Referral Workflow/Architecture/Technical Architecture|Technical Architecture]]

### Features (PRDs)
- [[Projects/360X Referral Workflow/Features/📋 PRD Index|All PRDs (PRD-01 through PRD-07)]]

### Engineering
- [[Projects/360X Referral Workflow/Engineering/ENGINEERING-PRD-01|Engineering PRD-01]]
- [[Projects/360X Referral Workflow/Engineering/Gemini Architecture Instructions|Gemini Architecture Instructions]]
- [[Projects/360X Referral Workflow/Engineering/Gemini PRD Writing Instructions|PRD Writing Guidelines]]

### Backlog
- [[Projects/360X Referral Workflow/Backlog & Ideas/Ideas|Ideas & Future Features]]
- [[Projects/360X Referral Workflow/Backlog & Ideas/In Progress|In Progress Work]]

## 🔄 Workflow Phases

| Phase | Status | PRDs |
|-------|--------|------|
| **Intake** | ✅ | [[Projects/360X Referral Workflow/Features/PRD-01 - Receive & Acknowledge|PRD-01]] |
| **Disposition** | ✅ | [[Projects/360X Referral Workflow/Features/PRD-02 - Process & Disposition|PRD-02]] |
| **Scheduling** | ✅ | [[Projects/360X Referral Workflow/Features/PRD-03 - Schedule Patient|PRD-03]] |
| **Final Report** | ✅ | [[Projects/360X Referral Workflow/Features/PRD-04 - Generate Consult Note|PRD-04]] |
| **Encounter** | ✅ | [[Projects/360X Referral Workflow/Features/PRD-05 - Patient Encounter|PRD-05]] |
| **Closure** | ✅ | [[Projects/360X Referral Workflow/Features/PRD-06 - Close Loop|PRD-06]] |
| **Monitoring** | ✅ | [[Projects/360X Referral Workflow/Features/PRD-07 - Ack Tracking|PRD-07]] |

## 🛠️ Tech Stack

- **Language:** TypeScript
- **State Machine:** Custom (no external library)
- **Database:** SQLite + Drizzle ORM
- **API:** Claude (Anthropic SDK), Gemini 2.5-Flash
- **Email:** Nodemailer (SMTP) + Imapflow (IMAP)
- **Messaging:** HL7 V2 (`hl7` npm), C-CDA (`@kno2/bluebutton`)
- **UI:** Express.js + HTML
- **Testing:** Jest with 80% coverage requirement

## 🎬 Demo Flow

All four mock scripts work together to demonstrate the full happy path:

1. **mockReferrer.ts** — Sends initial referral, auto-ACKs all replies
2. **mockScheduler.ts** — Auto-assigns appointment when referral accepted
3. **mockEncounter.ts** — Sends encounter trigger after appointment time
4. **mockEhr.ts** — Sends clinical data to trigger consult note generation

The **only manual step** is the clinician's Accept/Decline decision in PRD-02.

## 🔗 Quick Links

- **Repository:** `/referral_workflow`
- **Main Entry:** [CLAUDE.md](../../CLAUDE.md)
- **State Machine:** [referralStateMachine.ts](../../src/state/referralStateMachine.ts)
- **Database Schema:** [schema.ts](../../src/db/schema.ts)

---

**Last Updated:** 2026-04-02  
**Status:** Active Development
