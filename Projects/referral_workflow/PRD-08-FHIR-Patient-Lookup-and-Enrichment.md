# PRD-08: FHIR Patient Lookup and Clinical Data Enrichment

**Status:** Draft

---

## 1. Overview

### 1.1. Context

Incoming referral documents frequently lack the full patient context a clinician needs to make an informed admission or disposition decision. A C-CDA may arrive with a valid chief complaint and demographics but be missing problem lists, medication history, allergy records, or recent diagnostic results. Today, this forces one of two costly outcomes: the clinician manually declines the referral and requests updated paperwork, or they accept with incomplete information and risk an inappropriate admission.

Similarly, after an encounter is complete and the specialist needs to send a Consult Note C-CDA back to the referring provider, they must manually re-enter clinical data that already exists in the EHR — vitals recorded during the visit, new diagnoses, medications prescribed, and procedures performed.

Both problems have the same root cause: the system cannot access structured patient data that already exists in the EHR. A FHIR R4 lookup against the facility's EHR solves this by programmatically retrieving the patient's medical record to fill documentation gaps at intake and auto-populate the consult note at discharge.

### 1.2. Goal

1. **Reduce manual referral rejections** by automatically enriching incomplete inbound C-CDAs with FHIR-sourced clinical data before the clinician reviews them.
2. **Reduce chart re-entry time** by auto-populating the outbound Consult Note C-CDA with structured FHIR data from the patient's record after the encounter.
3. **Provide full clinical context** so clinicians can make better-informed admission and disposition decisions.

### 1.3. Scope

- **In Scope:**
  - A reusable FHIR client module that queries a public FHIR R4 sandbox (HAPI FHIR public server) for patient data.
  - Patient matching by name + DOB (and MRN if present in the inbound C-CDA).
  - Automatic FHIR enrichment during referral ingestion (PRD-02 flow) — fills missing optional clinical sections before the clinician review page loads.
  - FHIR-sourced consult note generation during encounter close (PRD-04 flow) — replaces hardcoded mock EHR text with real structured data from the FHIR server.
  - Clear visual distinction in the review UI between data sourced from the inbound C-CDA vs. data retrieved via FHIR lookup.
  - Persisting enriched data alongside original C-CDA data for audit trail.
  - Transitioning the demo patient profile to match an existing patient in the FHIR sandbox.
- **Out of Scope:**
  - SMART on FHIR OAuth flows (the PoC uses an open sandbox — no auth required).
  - FHIR write-back (creating or updating resources on the server).
  - Real-time FHIR subscriptions or webhooks.
  - Changing the auto-decline logic for Gate 1 (missing demographics or reason for referral still triggers auto-decline — FHIR cannot help if the patient cannot be identified).
  - Production EHR integration (the FHIR client module is designed as a replaceable layer).

---

## 2. User Stories & Acceptance Criteria

### 2.1. As a Clinician, I want to see the full relevant patient history when assessing an incoming referral, so I know I am properly assessing the patient.

- **AC1:** When a referral is received and the inbound C-CDA is missing optional clinical sections (problems, allergies, medications, diagnostic results), the system shall automatically perform a FHIR lookup using the patient's name and DOB.
- **AC2:** FHIR-retrieved data shall be merged into the referral's clinical data and displayed on the Referral Review page alongside the original C-CDA data.
- **AC3:** The UI must visually distinguish between data from the original C-CDA (default styling) and data retrieved via FHIR (labeled badge or highlight indicating "FHIR" source).
- **AC4:** If the FHIR lookup returns no matching patient or no additional data, the system shall proceed normally with only the C-CDA data — no error, no block.

### 2.2. As a Clinician, I want up-to-date patient information when assessing an incoming referral, so I know what is clinically relevant.

- **AC1:** The FHIR lookup shall retrieve the most recent data available for the matched patient, including active conditions, current medications, known allergies, and recent observations/results.
- **AC2:** FHIR data shall include relevant dates (onset, recorded, effective) so the clinician can judge recency.

### 2.3. As a Health Center Scheduler, I don't want to waste time rejecting incomplete paperwork, so I can properly schedule patients I know I can help.

- **AC1:** The Gemini sufficiency assessment (PRD-02) shall run against the combined C-CDA + FHIR data, not just the C-CDA alone.
- **AC2:** Missing optional sections that are filled by FHIR data shall no longer appear in the "missing sections" warning on the review page.
- **AC3:** The system shall log when FHIR enrichment filled a gap that would have otherwise been flagged as missing.

### 2.4. As a System, I want to auto-populate the outbound Consult Note with FHIR data, so clinicians don't have to re-enter information that's already in the chart.

- **AC1:** When generating the Consult Note C-CDA (PRD-04), the system shall perform a FHIR lookup to retrieve the patient's current clinical state — including any new conditions, medications, procedures, and observations recorded during the encounter.
- **AC2:** The FHIR-retrieved data shall replace the current hardcoded mock EHR note text as the primary source for the Consult Note content.
- **AC3:** The Gemini structuring step shall receive the FHIR-sourced clinical summary and organize it into the appropriate C-CDA sections (Chief Complaint, HPI, Assessment, Plan, Physical Exam).
- **AC4:** For repeated demos with the same patient, the system should cache/persist the FHIR data so the demo runs consistently without requiring live FHIR server availability.

---

## 3. Technical Implementation Details

### 3.1. FHIR Sandbox

The PoC will use the **HAPI FHIR R4 public sandbox** (`https://hapi.fhir.org/baseR4`), which:
- Requires no authentication (open access).
- Contains pre-existing synthetic patient records.
- Supports standard FHIR R4 search operations.

The demo patient profile (currently "Jane Doe") should be transitioned to match an existing patient in the HAPI sandbox. During engineering, a suitable patient with rich clinical data (conditions, medications, allergies, observations) will be identified and the sample C-CDA fixture updated accordingly.

### 3.2. FHIR Resources to Query

**For intake enrichment (PRD-02 flow):**

| FHIR Resource | Purpose | Maps to C-CDA Section |
|---|---|---|
| `Patient` | Demographics, identifiers, verify match | Patient Demographics |
| `Condition` | Active problem list | Problems |
| `AllergyIntolerance` | Known allergies | Allergies |
| `MedicationRequest` | Current medications | Medications |
| `Observation` | Lab results, vitals | Diagnostic Results |
| `DiagnosticReport` | Structured test results | Diagnostic Results |
| `Encounter` | Prior visit history | (context for clinician) |

**For consult note generation (PRD-04 flow):**

All of the above, plus:

| FHIR Resource | Purpose | Maps to C-CDA Section |
|---|---|---|
| `Procedure` | Procedures performed during encounter | Plan / Assessment |
| `CarePlan` | Treatment plans created | Plan of Treatment |

### 3.3. Patient Matching Strategy

1. **Primary match:** Search `Patient?given={firstName}&family={lastName}&birthdate={dob}` — exact match on name + DOB.
2. **MRN match (if available):** If the inbound C-CDA contains an MRN in the patient ID field, search `Patient?identifier={mrn}` for a more precise match.
3. **Disambiguation:** If multiple patients match, select the one with the most recent `meta.lastUpdated`. Log a warning if ambiguous.
4. **No match:** If no patient is found, skip FHIR enrichment silently and proceed with C-CDA data only.

### 3.4. Data Enrichment Logic (Intake)

The enrichment step runs after the C-CDA is parsed but before the referral is written to the database:

```
parseCda(xml) → parseExtendedCda(xml)
  → fhirEnrich(extendedData)          ← NEW
    → match patient on FHIR server
    → query Condition, AllergyIntolerance, MedicationRequest, Observation, etc.
    → merge FHIR data into extendedData (preserving source labels)
    → return enrichedData
  → write to DB (clinicalData now includes both sources)
  → fire Gemini assessment on enriched data
```

Merge rules:
- C-CDA data is **primary** — FHIR data supplements but does not overwrite.
- Each clinical item is tagged with its source: `"source": "ccda"` or `"source": "fhir"`.
- Deduplication: if a FHIR Condition has the same display name as a C-CDA problem, the C-CDA version is kept and the FHIR version is dropped.

### 3.5. Consult Note Generation (Discharge)

The FHIR lookup replaces `mockEhr.ts` hardcoded text:

```
encounterService.markEncounterComplete()
  → mockEhr.onEncounterComplete(referralId)  ← MODIFIED
    → fhirClient.getPatientSummary(patientId)
    → format FHIR resources into clinical note text
    → consultNoteService.generateAndSend({ referralId, noteText })
```

The formatted note text includes:
- Chief Complaint (from referral reason + most recent Condition)
- Active Conditions with onset dates
- Current Medications with dosages
- Recent Observations with values and dates
- Procedures performed (if any)
- Assessment and plan derived from CarePlan resources (if any)

### 3.6. Clinical Data Storage

The `clinicalData` JSON column in the `referrals` table will be extended:

```json
{
  "problems": [
    { "name": "Essential Hypertension", "source": "ccda" },
    { "name": "Type 2 Diabetes Mellitus", "source": "fhir", "onsetDate": "2019-06-15" }
  ],
  "allergies": [
    { "name": "Penicillin", "source": "ccda" },
    { "name": "Sulfa Drugs", "source": "fhir", "recordedDate": "2020-01-10" }
  ],
  "medications": [...],
  "diagnosticResults": [...],
  "encounters": [...],
  "missingOptionalSections": [],
  "fhirPatientId": "Patient/12345",
  "fhirEnrichmentTimestamp": "2026-03-24T20:00:00Z"
}
```

This is a backward-compatible extension — existing items that are plain strings will continue to work; items with the `source` property enable the UI to distinguish origins.

### 3.7. Review UI Changes

The Referral Review page (`referralReview.html`) will be updated:

- Each clinical item rendered in the Problems, Allergies, Medications, and Diagnostic Results sections will show a small source badge:
  - **C-CDA** — default (no badge or subtle gray badge)
  - **FHIR** — blue badge indicating the data was retrieved from the EHR
- A summary line at the top of the Clinical Information card: *"Enriched with X items from FHIR lookup"* (or *"No additional data found via FHIR"*).
- The "missing optional sections" warning will only show sections that are still missing after FHIR enrichment.

### 3.8. Auto-Decline Behavior

**No changes to Gate 1.** The following still trigger auto-decline before any FHIR lookup:
- No C-CDA attachment
- Malformed/unparseable C-CDA
- Missing patient first name, last name, or DOB
- Missing reason for referral

**Gate 2 (optional sections)** is not currently an auto-decline trigger, and remains unchanged. FHIR enrichment fills gaps in optional sections for the clinician's benefit and for the Gemini assessment, but does not alter the auto-decline decision boundary.

---

## 4. Dependencies

| Package | Purpose | Status |
|---|---|---|
| Native `fetch` | FHIR R4 REST API calls (Node 18+ built-in) | Available |
| HAPI FHIR R4 sandbox | Public test server | External service |

No new npm packages required — FHIR R4 is a REST/JSON API and can be called with native `fetch`.

---

## 5. Test Plan

### Unit Tests
- **FHIR client:** Mock HTTP responses for Patient search, Condition, AllergyIntolerance, MedicationRequest, Observation queries.
- **Patient matching:** Verify match by name+DOB, match by MRN, no-match fallback, multiple-match disambiguation.
- **Enrichment merge:** C-CDA data preserved as primary; FHIR data supplements with correct source tags; deduplication works.
- **Consult note formatting:** FHIR resources correctly formatted into clinical note text.

### Integration Tests
- Full intake flow: inbound C-CDA with missing allergies → FHIR lookup fills allergies → review page shows both sources → Gemini assessment runs on enriched data.
- Full discharge flow: encounter complete → FHIR lookup retrieves patient data → consult note generated with FHIR-sourced content → C-CDA sent.

---

## 6. Deliverables

1. **`fhirClient.ts`** — Reusable FHIR R4 client module (patient search, resource queries, response parsing).
2. **`fhirEnrichment.ts`** — Enrichment logic: merges FHIR data into parsed C-CDA data with source tagging.
3. **`fhirConsultNote.ts`** — Formats FHIR resources into clinical note text for consult note generation.
4. **Updated `referralService.ts`** — Calls FHIR enrichment during ingestion.
5. **Updated `mockEhr.ts`** — Replaces hardcoded note text with FHIR-sourced data.
6. **Updated `referralReview.html`** — Source badges distinguishing C-CDA vs. FHIR data.
7. **Updated `sample-referral.xml`** — Demo patient aligned with HAPI FHIR sandbox patient.
8. **Updated `clinicalData` schema** — Extended to include source tags and FHIR metadata.
