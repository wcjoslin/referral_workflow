---
title: PRD Index - All Product Requirements
tags: [prd, features, index]
up: "[[🎯 PROJECT OVERVIEW]]"
down: ["[[PRD-01 - Receive & Acknowledge]]", "[[PRD-02 - Process & Disposition]]", "[[PRD-03 - Schedule Patient]]", "[[PRD-04 - Generate Consult Note]]", "[[PRD-05 - Patient Encounter]]", "[[PRD-06 - Close Loop]]", "[[PRD-07 - Ack Tracking]]", "[[PRD-10 - UI Modernization & CCDA Viewer]]", "[[PRD-11 - No-Show & Consult States]]", "[[PRD-12 - Prior Authorization]]", "[[PRD-13 - Department Classification]]", "[[Feature - Human-Readable Email Summaries]]", "[[Feature - Human-Readable Message Type Labels]]", "[[Feature - No-Show & Consult Demo Scenarios]]"]
---

# 📋 PRD Index

Product Requirements Documents for the 360X Referral Workflow project. Each PRD maps to a phase of the closed-loop referral process.

---

## Development Roadmap

The logical order for PRD development:

### 1. **[[PRD-01 - Receive & Acknowledge|PRD-01: Receive and Acknowledge Referral]]** ✅
**Foundational step.** You must be able to receive and acknowledge a referral before any other processing can happen.

- Receive C-CDA via Direct Secure Messaging
- Parse and extract patient/referral data
- Send MDN acknowledgment
- **Database Prerequisite:** SQLite + Drizzle schema required before PRD-02

**Status:** ✅ Complete  
**Module:** `prd01/`

---

### 2. **[[PRD-02 - Process & Disposition|PRD-02: Process and Disposition Referral]]** ✅
**Core logic of the referral process.** Determines if a patient can even be seen.

- Validate C-CDA completeness using AI reasoning
- Present valid referrals to clinician for Accept/Decline decision (manual step)
- Auto-decline incomplete referrals
- Generate RRI^I12 accept/decline message
- **Prerequisite:** PRD-01 + database persistence

**Status:** ✅ Complete  
**Module:** `prd02/`

---

### 3. **[[PRD-03 - Schedule Patient|PRD-03: Schedule Patient and Notify Referrer]]** ✅
**Logical next step for accepted referrals.**

- Present patient to scheduling system
- Auto-assign appointment slots (mock scheduler)
- Generate SIU^S12 scheduling message
- **Prerequisite:** PRD-02 (accepted referral)

**Status:** ✅ Complete  
**Module:** `prd03/`

---

### 4. **[[PRD-04 - Generate Consult Note|PRD-04: Generate and Send Final Consult Note]]** ✅
**Primary goal of the workflow—sending the final report.**

- Detect clinician-signed final note
- Extract clinical summary using AI
- Generate valid Consult Note C-CDA
- Package and send via Direct
- **Prerequisite:** PRD-03 (scheduled appointment)

**Status:** ✅ Complete  
**Module:** `prd04/`

---

### 5. **[[PRD-05 - Patient Encounter|PRD-05: Patient Encounter and Interim Updates]]** ✅
**Fills the gap between scheduling and final note.**

- Detect appointment time trigger
- Send ADT^A04 encounter message
- Support optional interim update messages
- Update referral state to "Encounter"
- **Prerequisite:** PRD-03 (scheduled)

**Status:** ✅ Complete  
**Module:** `prd05/`

---

### 6. **[[PRD-06 - Close Loop|PRD-06: Acknowledge Final Report and Close Loop]]** ✅
**Implements the final handshake.**

- Detect inbound ACK for Consult Note
- Correlate ACK to sent message
- Update state to "Closed-Confirmed"
- Mark loop as complete
- **Prerequisite:** PRD-04 (consult note sent)

**Status:** ✅ Complete  
**Module:** `prd06/`

---

### 7. **[[PRD-07 - Ack Tracking|PRD-07: Referrer-Side Acknowledgment Tracking]]** ✅
**Enhances system robustness** (can be developed in parallel).

- Monitor outbound messages for acknowledgments
- Detect overdue/missing ACKs
- Provide dashboard visibility
- Implement retry logic

**Status:** ✅ Complete  
**Module:** `prd07/`

---

### 8. **[[PRD-11 - No-Show & Consult States|PRD-11: No-Show & Consult States]]** ✅
**Fills missing lifecycle gaps** for appointments and post-encounter consultation.

- Mark a scheduled appointment as no-show; notify referring physician
- Allow rescheduling from No-Show state using existing referral document
- Allow specialist to flag post-encounter consultation need
- Reintroduce clinician confirmation step before loop closure
- **Prerequisite:** PRD-03 (Scheduled), PRD-05 (Encounter)

**Status:** ✅ Complete  
**Module:** `prd11/`

---

### 9. **[[PRD-12 - Prior Authorization|PRD-12: Prior Authorization (Da Vinci PAS)]]** ✅
**FHIR-based prior authorization gate** before referral submission per CMS-0057-F.

- Submit prior authorization requests via Da Vinci PAS `$submit` operation
- Handle approved, denied, and pended outcomes with subscription + polling
- Auto-populate PA form from referral clinical data with clinician edit
- Mock payer with deterministic decision logic for demo scenarios
- Pended requests auto-expire to Expired state after configurable timeout
- **Prerequisite:** PRD-08 (FHIR client), PRD-02 (referral with clinical data)

**Status:** ✅ Complete  
**Module:** `prd12/`

---

### 10. **[[PRD-13 - Department Classification|PRD-13: Department Classification & Administrative Routing]]** 🔧
**Repurposes AI assessment for administrative triage** — department routing, equipment identification, and care-request summarization.

- Classify referrals into departments from the facility catalogue
- Surface required equipment and diagnostic resources
- Editable routing controls for coordinator overrides
- Department badge + filter on inbox dashboard
- **Prerequisite:** PRD-02 (disposition flow), PRD-03 (resource catalogue)

**Status:** 🔧 In Progress  
**Module:** `prd02/`

---

## Quick Reference

| PRD | Name | Status | Key Action | Module |
|-----|------|--------|-----------|--------|
| [[PRD-01 - Receive & Acknowledge|01]] | Receive & Acknowledge | ✅ | Parse C-CDA, send MDN | `prd01/` |
| [[PRD-02 - Process & Disposition|02]] | Process & Disposition | ✅ | Validate, clinician decides | `prd02/` |
| [[PRD-03 - Schedule Patient|03]] | Schedule Patient | ✅ | Assign appointment, send SIU | `prd03/` |
| [[PRD-04 - Generate Consult Note|04]] | Generate Consult Note | ✅ | Extract notes, send C-CDA | `prd04/` |
| [[PRD-05 - Patient Encounter|05]] | Patient Encounter | ✅ | Send ADT, update state | `prd05/` |
| [[PRD-06 - Close Loop|06]] | Close Loop | ✅ | Acknowledge final report | `prd06/` |
| [[PRD-07 - Ack Tracking|07]] | Ack Tracking | ✅ | Monitor & retry messages | `prd07/` |
| [[PRD-11 - No-Show & Consult States|11]] | No-Show & Consult States | ✅ | No-show notify + consult confirmation | `prd11/` |
| [[PRD-12 - Prior Authorization|12]] | Prior Authorization (PAS) | ✅ | FHIR PA submit, payer decisions | `prd12/` |
| [[PRD-13 - Department Classification|13]] | Department Classification | 🔧 | Route to dept, surface equipment | `prd02/` |

---

## Feature Dependencies

```mermaid
PRD-01 (Receive)
    ↓
PRD-02 (Disposition)
    ↓
PRD-03 (Schedule)
    ├── → PRD-05 (Encounter)
    └── → PRD-04 (Consult Note)
            ↓
        PRD-06 (Close Loop)

PRD-07 (Ack Tracking) ← Horizontal feature, monitors all outbound messages
```

---

## Features

| Feature | Description | Status |
|---------|-------------|--------|
| [[Feature - Human-Readable Email Summaries]] | Plain-text summaries in outbound emails | ✅ Complete |
| [[Feature - Human-Readable Message Type Labels]] | Friendly labels for message types in UI | ✅ Complete |
| [[Feature - Demo Launcher Message Preview]] | C-CDA viewer + envelope preview on demo launcher | ✅ Complete |
| [[Feature - No-Show & Consult Demo Scenarios]] | Demo scenarios for No-Show and Consult state paths | 🔧 Ready for Dev |

---

## See Also

- [[🎯 PROJECT OVERVIEW|Project Overview]]
- [[../Architecture/360X Workflow Overview|Workflow Overview]]
- [[../Architecture/Technical Architecture|Technical Architecture]]
- [[../Backlog & Ideas/Ideas|Ideas & Future Features]]
