# ENGINEERING-PRD-08: FHIR Patient Lookup and Clinical Data Enrichment

## 1. Overview

PRD-08 adds a reusable FHIR R4 client that integrates at two points in the existing workflow:

1. **Intake enrichment (PRD-02):** After C-CDA parsing, before DB write — fills missing optional clinical sections with FHIR data.
2. **Consult note generation (PRD-04):** After encounter, before C-CDA build — replaces hardcoded mock text with live FHIR-sourced patient data.

All FHIR queries target the **HAPI FHIR R4 public sandbox** (`https://hapi.fhir.org/baseR4`), which requires no authentication.

---

## 2. Demo Patient

**Michael Kihn** — an existing patient on the HAPI sandbox with rich clinical data:

| Field | Value |
|---|---|
| FHIR Patient ID | `123836453` |
| Name | Michael Kihn |
| DOB | 1974-06-25 |
| Gender | Male |
| Conditions | 12 (asthma, diabetes, hypertension, depression, RA, GERD, angina, etc.) |
| Allergies | 2 (ibuprofen, eggs) |
| Medications | 19 MedicationStatements (salbutamol, carvedilol, chlortalidone, etc.) |
| Observations | 31 (vitals, labs) |
| Encounters | 10 |

The sample C-CDA fixture (`tests/fixtures/sample-referral.xml`) will be updated to use Michael Kihn's demographics so the FHIR patient match succeeds during demos.

---

## 3. Architecture

### 3.1 Intake Enrichment Flow

```
inboxMonitor → messageProcessor → processInboundMessage()
  → parseCda() → parseExtendedCda()
  → ingestReferral(processed)
    ├── Gate 1: base CDA invalid? → auto-decline (unchanged)
    ├── Gate 2: extended parse
    ├── fhirEnrich(extendedData)              ← NEW
    │     ├── fhirClient.searchPatient(name, dob)
    │     ├── fhirClient.getConditions(patientId)
    │     ├── fhirClient.getAllergyIntolerances(patientId)
    │     ├── fhirClient.getMedications(patientId)
    │     ├── fhirClient.getObservations(patientId)
    │     ├── fhirClient.getEncounters(patientId)
    │     └── merge into extendedData with source tags
    ├── write to DB (clinicalData includes both sources)
    └── fire Gemini assessment on enriched data
```

### 3.2 Consult Note Flow

```
encounterService.markEncounterComplete()
  → mockEhr.onEncounterComplete(referralId)     ← MODIFIED
    ├── load referral from DB (get patient name, DOB, fhirPatientId)
    ├── fhirClient.getPatientSummary(fhirPatientId)
    ├── fhirConsultNote.formatNoteText(fhirResources)
    └── consultNoteService.generateAndSend({ referralId, noteText })
```

---

## 4. New Files

```
src/modules/prd08/
  fhirClient.ts          — FHIR R4 REST client (patient search, resource queries)
  fhirEnrichment.ts      — Merge FHIR data into ExtendedReferralData with source tags
  fhirConsultNote.ts     — Format FHIR resources into clinical note text for PRD-04

tests/unit/prd08/
  fhirClient.test.ts
  fhirEnrichment.test.ts
  fhirConsultNote.test.ts
```

### Modified Files

```
src/modules/prd02/referralService.ts    — Call fhirEnrich() during ingestion
src/modules/prd04/mockEhr.ts            — Replace hardcoded text with FHIR lookup
src/views/referralReview.html           — Source badges (CCDA vs FHIR)
tests/fixtures/sample-referral.xml      — Update to Michael Kihn demographics
```

---

## 5. Config Changes

Add to `.env` / `config.ts`:

```
FHIR_BASE_URL=https://hapi.fhir.org/baseR4
```

New config section:

```typescript
fhir: {
  baseUrl: string;  // default: https://hapi.fhir.org/baseR4
}
```

---

## 6. Module Details

### 6.1 `fhirClient.ts`

Low-level FHIR R4 REST client using native `fetch`. All methods return typed interfaces.

```typescript
export interface FhirClientConfig {
  baseUrl: string;
}

export interface FhirPatientMatch {
  id: string;
  name: string;
  birthDate: string;
  gender: string;
}

export interface FhirCondition {
  code: string;
  display: string;
  onsetDate?: string;
  clinicalStatus: string;
}

export interface FhirAllergy {
  substance: string;
  recordedDate?: string;
  clinicalStatus: string;
}

export interface FhirMedication {
  name: string;
  dosage?: string;
  status: string;
}

export interface FhirObservation {
  code: string;
  display: string;
  value?: string;
  unit?: string;
  effectiveDate?: string;
  category: string;  // vital-signs, laboratory, etc.
}

export interface FhirEncounter {
  type: string;
  period?: { start: string; end?: string };
  status: string;
}

export interface FhirPatientSummary {
  patient: FhirPatientMatch;
  conditions: FhirCondition[];
  allergies: FhirAllergy[];
  medications: FhirMedication[];
  observations: FhirObservation[];
  encounters: FhirEncounter[];
}

// Patient search
export async function searchPatient(
  given: string, family: string, birthDate: string
): Promise<FhirPatientMatch | null>;

// Also support MRN search
export async function searchPatientByMrn(
  mrn: string
): Promise<FhirPatientMatch | null>;

// Resource queries (all take FHIR Patient ID)
export async function getConditions(patientId: string): Promise<FhirCondition[]>;
export async function getAllergyIntolerances(patientId: string): Promise<FhirAllergy[]>;
export async function getMedications(patientId: string): Promise<FhirMedication[]>;
export async function getObservations(patientId: string): Promise<FhirObservation[]>;
export async function getEncounters(patientId: string): Promise<FhirEncounter[]>;

// Composite: search patient + fetch all resources
export async function getPatientSummary(
  given: string, family: string, birthDate: string
): Promise<FhirPatientSummary | null>;

// By known FHIR ID (for consult note flow where we already have the ID)
export async function getPatientSummaryById(
  patientId: string
): Promise<FhirPatientSummary | null>;
```

Implementation notes:
- Each query uses `fetch()` with `Accept: application/fhir+json`
- Search results are Bundles — iterate `entry[].resource`
- Patient search: `GET /Patient?given={name}&family={name}&birthdate={dob}`
- Condition: `GET /Condition?patient={id}&clinical-status=active&_count=50`
- AllergyIntolerance: `GET /AllergyIntolerance?patient={id}&_count=50`
- MedicationStatement: `GET /MedicationStatement?patient={id}&_count=50` (HAPI sandbox uses MedicationStatement, not MedicationRequest — query both, merge results)
- MedicationRequest: `GET /MedicationRequest?patient={id}&_count=50`
- Observation: `GET /Observation?patient={id}&_sort=-date&_count=50`
- Encounter: `GET /Encounter?patient={id}&_sort=-date&_count=20`
- All queries include `_count` to limit results
- Timeout: 10 seconds per request; on failure, log warning and return empty array (never block the workflow)

### 6.2 `fhirEnrichment.ts`

Merges FHIR data into the parsed C-CDA data with source tagging.

```typescript
export interface EnrichedClinicalItem {
  name: string;
  source: 'ccda' | 'fhir';
  detail?: string;       // e.g., onset date, dosage, value+unit
}

export interface EnrichedClinicalData {
  problems: EnrichedClinicalItem[];
  allergies: EnrichedClinicalItem[];
  medications: EnrichedClinicalItem[];
  diagnosticResults: EnrichedClinicalItem[];
  encounters: EnrichedClinicalItem[];
  missingOptionalSections: string[];
  fhirPatientId: string | null;
  fhirEnrichmentTimestamp: string | null;
  fhirItemsAdded: number;
}

export async function enrichWithFhir(
  extendedData: ExtendedReferralData,
): Promise<EnrichedClinicalData>;
```

Merge rules:
1. Convert existing C-CDA string arrays to `EnrichedClinicalItem[]` with `source: 'ccda'`.
2. Search for patient on FHIR. If no match, return C-CDA data only with `fhirPatientId: null`.
3. For each FHIR resource type, map to `EnrichedClinicalItem` with `source: 'fhir'`.
4. Deduplicate: compare `name.toLowerCase()` — if a FHIR item matches a C-CDA item, skip the FHIR item.
5. Append non-duplicate FHIR items after C-CDA items.
6. Recalculate `missingOptionalSections` — a section is no longer "missing" if FHIR filled it.
7. Set `fhirItemsAdded` to the count of FHIR items that were actually added (after dedup).

### 6.3 `fhirConsultNote.ts`

Formats a `FhirPatientSummary` into clinical note text suitable for Gemini structuring.

```typescript
export function formatConsultNoteFromFhir(
  summary: FhirPatientSummary,
  reasonForReferral: string,
): string;
```

Output is a multi-paragraph clinical note with sections:
- Chief Complaint (from reason for referral)
- Active Conditions with onset dates
- Current Medications with dosages
- Known Allergies
- Recent Observations (vitals, labs) with values and dates
- Recent Encounters summary

This replaces the hardcoded `SAMPLE_CONSULT_NOTE` in `mockEhr.ts`.

---

## 7. Clinical Data Storage

The `clinicalData` JSON column extends from string arrays to typed objects:

**Before (current):**
```json
{
  "problems": ["Essential Hypertension", "Type 2 Diabetes"],
  "allergies": ["Penicillin"],
  "medications": ["Lisinopril 20mg"],
  "diagnosticResults": ["BNP 450 pg/mL"],
  "missingOptionalSections": ["Allergies"]
}
```

**After (PRD-08):**
```json
{
  "problems": [
    { "name": "Essential Hypertension", "source": "ccda" },
    { "name": "Depression", "source": "fhir", "detail": "onset 2019-06-15" }
  ],
  "allergies": [
    { "name": "Penicillin", "source": "ccda" },
    { "name": "Ibuprofen", "source": "fhir", "detail": "recorded 2020-01-10" }
  ],
  "medications": [...],
  "diagnosticResults": [...],
  "encounters": [
    { "name": "Office Visit", "source": "fhir", "detail": "2025-12-01 – 2025-12-01" }
  ],
  "missingOptionalSections": [],
  "fhirPatientId": "123836453",
  "fhirEnrichmentTimestamp": "2026-03-24T20:00:00Z",
  "fhirItemsAdded": 8
}
```

**Backward compatibility:** The review page JS will handle both formats — if an item is a string, treat it as `{ name: item, source: 'ccda' }`.

---

## 8. UI Changes

### Review Page (`referralReview.html`)

Each list item in Problems, Allergies, Medications, Diagnostic Results gains a source badge:

```html
<li>Essential Hypertension</li>                              <!-- C-CDA item, no badge -->
<li>Depression <span class="badge badge-fhir">FHIR</span> <span class="fhir-detail">onset 2019-06-15</span></li>
```

CSS additions:
```css
.badge-fhir { background: #cfe2ff; color: #084298; }
.fhir-detail { font-size: 0.8rem; color: #888; }
.fhir-summary { font-size: 0.82rem; color: #0d6efd; margin-bottom: 8px; }
```

A summary line at the top of the Clinical Information card:
- *"Enriched with 8 items from FHIR lookup (Patient/123836453)"*
- Or *"FHIR lookup: no matching patient found"*
- Or *"FHIR lookup: no additional data found"*

---

## 9. Server Routes

No new routes required. The enrichment happens server-side during ingestion and consult note generation — the review page already renders whatever is in `clinicalData`.

---

## 10. Test Plan

### Unit Tests

**`fhirClient.test.ts`:**
- Mock `fetch` responses for Patient search (match, no match, multiple matches)
- Mock Condition Bundle → parsed FhirCondition array
- Mock AllergyIntolerance Bundle → parsed FhirAllergy array
- Mock MedicationStatement Bundle → parsed FhirMedication array
- Mock Observation Bundle → parsed FhirObservation array
- Timeout/error handling → returns empty array, logs warning

**`fhirEnrichment.test.ts`:**
- C-CDA data preserved as primary source
- FHIR data added with correct source tags
- Deduplication: matching names are not duplicated
- Missing sections recalculated after enrichment
- No-match patient → returns C-CDA data unchanged
- fhirItemsAdded count is accurate

**`fhirConsultNote.test.ts`:**
- Formats conditions, medications, allergies, observations into readable text
- Includes onset dates and dosage details
- Handles empty resource arrays gracefully

### Mock Strategy
- `global.fetch` mocked in all tests (no live FHIR calls)
- Tests use fixture JSON matching real HAPI FHIR response format

---

## 11. Demo Flow

1. **Start server** (`npm run dev`) — inbox monitor connects to Gmail
2. **Referral arrives** — C-CDA for Michael Kihn (matching HAPI sandbox patient)
3. **PRD-01:** C-CDA parsed, MDN sent
4. **PRD-02 + PRD-08:** Extended parse → FHIR enrichment fills gaps → enriched data written to DB → Gemini assessment runs on full data
5. **Review page** (`/referrals/1/review`) shows:
   - C-CDA items (no badge)
   - FHIR items (blue "FHIR" badge with detail dates)
   - Summary: "Enriched with N items from FHIR lookup"
   - AI assessment now reflects the fuller picture
6. **Accept** → cascade fires: Schedule → Encounter → Consult Note
7. **PRD-04 + PRD-08:** mockEhr pulls FHIR data → formats into clinical note → Gemini structures → C-CDA built and sent
8. **PRD-06:** ACKs received → **Closed-Confirmed**
9. **Message History** (`/messages`) shows all messages acknowledged
