/**
 * PRD-08 FHIR R4 REST client.
 *
 * Queries the configured FHIR server (default: HAPI FHIR public sandbox) for
 * patient demographics and clinical resources. All methods return typed
 * interfaces; on timeout or error they return empty results and log a warning.
 */

import { config } from '../../config';

const TIMEOUT_MS = 10_000;

// ── Interfaces ─────────────────────────────────────────────────────────────

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
  category: string;
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

// ── Helpers ────────────────────────────────────────────────────────────────

function baseUrl(): string {
  return config.fhir.baseUrl;
}

async function fhirFetch(path: string): Promise<Record<string, unknown> | null> {
  const url = `${baseUrl()}/${path}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { Accept: 'application/fhir+json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[FhirClient] ${res.status} from ${url}`);
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.warn(`[FhirClient] Fetch failed for ${url}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function bundleEntries(bundle: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!bundle || !Array.isArray(bundle.entry)) return [];
  return (bundle.entry as Array<{ resource?: Record<string, unknown> }>)
    .map((e) => e.resource)
    .filter((r): r is Record<string, unknown> => r != null);
}

// ── Patient Search ─────────────────────────────────────────────────────────

export async function searchPatient(
  given: string,
  family: string,
  birthDate: string,
): Promise<FhirPatientMatch | null> {
  const bundle = await fhirFetch(
    `Patient?given=${encodeURIComponent(given)}&family=${encodeURIComponent(family)}&birthdate=${encodeURIComponent(birthDate)}`,
  );
  const entries = bundleEntries(bundle);
  if (entries.length === 0) return null;

  // Disambiguate: pick the one with the most recent lastUpdated
  const sorted = entries.sort((a, b) => {
    const aDate = (a.meta as Record<string, unknown>)?.lastUpdated as string ?? '';
    const bDate = (b.meta as Record<string, unknown>)?.lastUpdated as string ?? '';
    return bDate.localeCompare(aDate);
  });

  if (entries.length > 1) {
    console.warn(`[FhirClient] Multiple patient matches (${entries.length}) for ${given} ${family} ${birthDate} — using most recent`);
  }

  return parsePatientResource(sorted[0]);
}

export async function searchPatientByMrn(mrn: string): Promise<FhirPatientMatch | null> {
  const bundle = await fhirFetch(`Patient?identifier=${encodeURIComponent(mrn)}`);
  const entries = bundleEntries(bundle);
  if (entries.length === 0) return null;
  return parsePatientResource(entries[0]);
}

function parsePatientResource(resource: Record<string, unknown>): FhirPatientMatch {
  const id = String(resource.id ?? '');
  const nameArr = resource.name as Array<Record<string, unknown>> | undefined;
  const nameObj = nameArr?.[0];
  const given = (nameObj?.given as string[] | undefined)?.[0] ?? '';
  const family = (nameObj?.family as string) ?? '';
  const name = `${given} ${family}`.trim();
  const birthDate = String(resource.birthDate ?? '');
  const gender = String(resource.gender ?? '');
  return { id, name, birthDate, gender };
}

// ── Resource Queries ───────────────────────────────────────────────────────

export async function getConditions(patientId: string): Promise<FhirCondition[]> {
  const bundle = await fhirFetch(`Condition?patient=${patientId}&_count=50`);
  return bundleEntries(bundle).map((r) => {
    const code = r.code as Record<string, unknown> | undefined;
    const coding = (code?.coding as Array<Record<string, unknown>> | undefined)?.[0];
    const clinicalStatus = ((r.clinicalStatus as Record<string, unknown>)?.coding as Array<Record<string, unknown>> | undefined)?.[0]?.code as string ?? 'unknown';
    const onsetStr = (r.onsetDateTime as string) ?? (r.onsetPeriod as Record<string, unknown>)?.start as string | undefined;
    return {
      code: String(coding?.code ?? ''),
      display: String(coding?.display ?? code?.text ?? ''),
      onsetDate: onsetStr ? onsetStr.substring(0, 10) : undefined,
      clinicalStatus,
    };
  }).filter((c) => c.display !== '');
}

export async function getAllergyIntolerances(patientId: string): Promise<FhirAllergy[]> {
  const bundle = await fhirFetch(`AllergyIntolerance?patient=${patientId}&_count=50`);
  return bundleEntries(bundle).map((r) => {
    const code = r.code as Record<string, unknown> | undefined;
    const coding = (code?.coding as Array<Record<string, unknown>> | undefined)?.[0];
    const clinicalStatus = ((r.clinicalStatus as Record<string, unknown>)?.coding as Array<Record<string, unknown>> | undefined)?.[0]?.code as string ?? 'unknown';
    return {
      substance: String(coding?.display ?? code?.text ?? ''),
      recordedDate: (r.recordedDate as string)?.substring(0, 10),
      clinicalStatus,
    };
  }).filter((a) => a.substance !== '');
}

export async function getMedications(patientId: string): Promise<FhirMedication[]> {
  // Query both MedicationStatement and MedicationRequest, merge results
  const [stmtBundle, reqBundle] = await Promise.all([
    fhirFetch(`MedicationStatement?patient=${patientId}&_count=50`),
    fhirFetch(`MedicationRequest?patient=${patientId}&_count=50`),
  ]);

  const meds: FhirMedication[] = [];

  for (const r of bundleEntries(stmtBundle)) {
    const med = r.medicationCodeableConcept as Record<string, unknown> | undefined;
    const coding = (med?.coding as Array<Record<string, unknown>> | undefined)?.[0];
    const name = String(coding?.display ?? med?.text ?? '');
    const dosage = parseDosage(r.dosage);
    const status = String(r.status ?? 'unknown');
    if (name) meds.push({ name, dosage, status });
  }

  for (const r of bundleEntries(reqBundle)) {
    const med = r.medicationCodeableConcept as Record<string, unknown> | undefined;
    const coding = (med?.coding as Array<Record<string, unknown>> | undefined)?.[0];
    const name = String(coding?.display ?? med?.text ?? '');
    // Skip duplicates from MedicationStatement
    if (!name || meds.some((m) => m.name.toLowerCase() === name.toLowerCase())) continue;
    const dosage = parseDosage(r.dosageInstruction);
    const status = String(r.status ?? 'unknown');
    meds.push({ name, dosage, status });
  }

  return meds;
}

function parseDosage(dosageArr: unknown): string | undefined {
  if (!Array.isArray(dosageArr) || dosageArr.length === 0) return undefined;
  const d = dosageArr[0] as Record<string, unknown>;
  const text = d.text as string | undefined;
  if (text) return text;
  const doseQty = (d.doseAndRate as Array<Record<string, unknown>> | undefined)?.[0]?.doseQuantity as Record<string, unknown> | undefined;
  if (doseQty) return `${doseQty.value} ${doseQty.unit ?? ''}`.trim();
  return undefined;
}

export async function getObservations(patientId: string): Promise<FhirObservation[]> {
  const bundle = await fhirFetch(`Observation?patient=${patientId}&_sort=-date&_count=50`);
  return bundleEntries(bundle).map((r) => {
    const code = r.code as Record<string, unknown> | undefined;
    const coding = (code?.coding as Array<Record<string, unknown>> | undefined)?.[0];
    const valueQty = r.valueQuantity as Record<string, unknown> | undefined;
    const valueCc = r.valueCodeableConcept as Record<string, unknown> | undefined;
    const value = valueQty
      ? String(valueQty.value ?? '')
      : valueCc
        ? String((valueCc.coding as Array<Record<string, unknown>> | undefined)?.[0]?.display ?? valueCc.text ?? '')
        : (r.valueString as string) ?? undefined;
    const unit = valueQty ? String(valueQty.unit ?? '') : undefined;
    const catArr = r.category as Array<Record<string, unknown>> | undefined;
    const category = ((catArr?.[0]?.coding as Array<Record<string, unknown>> | undefined)?.[0]?.code as string) ?? 'unknown';
    const effectiveDate = ((r.effectiveDateTime as string) ?? (r.effectivePeriod as Record<string, unknown>)?.start as string | undefined)?.substring(0, 10);
    return {
      code: String(coding?.code ?? ''),
      display: String(coding?.display ?? code?.text ?? ''),
      value,
      unit,
      effectiveDate,
      category,
    };
  }).filter((o) => o.display !== '');
}

export async function getEncounters(patientId: string): Promise<FhirEncounter[]> {
  const bundle = await fhirFetch(`Encounter?patient=${patientId}&_sort=-date&_count=20`);
  return bundleEntries(bundle).map((r) => {
    const typeArr = r.type as Array<Record<string, unknown>> | undefined;
    const coding = (typeArr?.[0]?.coding as Array<Record<string, unknown>> | undefined)?.[0];
    const typeName = String(coding?.display ?? typeArr?.[0]?.text ?? 'Encounter');
    const period = r.period as Record<string, string> | undefined;
    return {
      type: typeName,
      period: period ? { start: period.start?.substring(0, 10), end: period.end?.substring(0, 10) } : undefined,
      status: String(r.status ?? 'unknown'),
    };
  });
}

// ── Composite Queries ──────────────────────────────────────────────────────

export async function getPatientSummary(
  given: string,
  family: string,
  birthDate: string,
): Promise<FhirPatientSummary | null> {
  const patient = await searchPatient(given, family, birthDate);
  if (!patient) return null;
  return fetchSummaryForPatient(patient);
}

export async function getPatientSummaryById(
  patientId: string,
): Promise<FhirPatientSummary | null> {
  const resource = await fhirFetch(`Patient/${patientId}`);
  if (!resource) return null;
  const patient = parsePatientResource(resource);
  return fetchSummaryForPatient(patient);
}

async function fetchSummaryForPatient(patient: FhirPatientMatch): Promise<FhirPatientSummary> {
  const [conditions, allergies, medications, observations, encounters] = await Promise.all([
    getConditions(patient.id),
    getAllergyIntolerances(patient.id),
    getMedications(patient.id),
    getObservations(patient.id),
    getEncounters(patient.id),
  ]);
  return { patient, conditions, allergies, medications, observations, encounters };
}
