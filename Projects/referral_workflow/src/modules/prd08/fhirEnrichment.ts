/**
 * PRD-08 FHIR enrichment logic.
 *
 * Merges FHIR-sourced clinical data into the parsed C-CDA data, tagging each
 * item with its source ('ccda' or 'fhir'). Deduplicates by comparing
 * name.toLowerCase(). Recalculates missingOptionalSections after enrichment.
 */

import { ExtendedReferralData } from '../prd01/cdaParser';
import {
  getPatientSummary,
  FhirPatientSummary,
  FhirCondition,
  FhirAllergy,
  FhirMedication,
  FhirObservation,
  FhirEncounter,
} from './fhirClient';

// ── Interfaces ─────────────────────────────────────────────────────────────

export interface EnrichedClinicalItem {
  name: string;
  source: 'ccda' | 'fhir';
  detail?: string;
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

// ── Helpers ────────────────────────────────────────────────────────────────

function toCcdaItems(items: string[]): EnrichedClinicalItem[] {
  return items.map((name) => ({ name, source: 'ccda' as const }));
}

function isDuplicate(existing: EnrichedClinicalItem[], name: string): boolean {
  const lower = name.toLowerCase();
  return existing.some((item) => item.name.toLowerCase() === lower);
}

function mapConditions(conditions: FhirCondition[]): EnrichedClinicalItem[] {
  return conditions.map((c) => ({
    name: c.display,
    source: 'fhir' as const,
    detail: c.onsetDate ? `onset ${c.onsetDate}` : undefined,
  }));
}

function mapAllergies(allergies: FhirAllergy[]): EnrichedClinicalItem[] {
  return allergies.map((a) => ({
    name: a.substance,
    source: 'fhir' as const,
    detail: a.recordedDate ? `recorded ${a.recordedDate}` : undefined,
  }));
}

function mapMedications(medications: FhirMedication[]): EnrichedClinicalItem[] {
  return medications.map((m) => ({
    name: m.name,
    source: 'fhir' as const,
    detail: m.dosage ?? undefined,
  }));
}

function mapObservations(observations: FhirObservation[]): EnrichedClinicalItem[] {
  return observations.map((o) => {
    const parts: string[] = [];
    if (o.value) parts.push(o.unit ? `${o.value} ${o.unit}` : o.value);
    if (o.effectiveDate) parts.push(o.effectiveDate);
    return {
      name: o.display,
      source: 'fhir' as const,
      detail: parts.length > 0 ? parts.join(' — ') : undefined,
    };
  });
}

function mapEncounters(encounters: FhirEncounter[]): EnrichedClinicalItem[] {
  return encounters.map((e) => {
    let detail: string | undefined;
    if (e.period) {
      detail = e.period.end ? `${e.period.start} – ${e.period.end}` : e.period.start;
    }
    return { name: e.type, source: 'fhir' as const, detail };
  });
}

function mergeItems(
  ccdaItems: EnrichedClinicalItem[],
  fhirItems: EnrichedClinicalItem[],
): { merged: EnrichedClinicalItem[]; added: number } {
  let added = 0;
  const merged = [...ccdaItems];
  for (const item of fhirItems) {
    if (!isDuplicate(merged, item.name)) {
      merged.push(item);
      added++;
    }
  }
  return { merged, added };
}

// ── Main Enrichment Function ───────────────────────────────────────────────

export async function enrichWithFhir(
  extendedData: ExtendedReferralData,
): Promise<EnrichedClinicalData> {
  const ccdaProblems = toCcdaItems(extendedData.problems);
  const ccdaAllergies = toCcdaItems(extendedData.allergies);
  const ccdaMedications = toCcdaItems(extendedData.medications);
  const ccdaDiagnosticResults = toCcdaItems(extendedData.diagnosticResults);

  // Attempt FHIR patient lookup
  let summary: FhirPatientSummary | null = null;
  try {
    summary = await getPatientSummary(
      extendedData.patient.firstName,
      extendedData.patient.lastName,
      extendedData.patient.dateOfBirth,
    );
  } catch (err) {
    console.warn('[FhirEnrichment] FHIR lookup failed:', err instanceof Error ? err.message : err);
  }

  // No match — return C-CDA data only
  if (!summary) {
    return {
      problems: ccdaProblems,
      allergies: ccdaAllergies,
      medications: ccdaMedications,
      diagnosticResults: ccdaDiagnosticResults,
      encounters: [],
      missingOptionalSections: [...extendedData.missingOptionalSections],
      fhirPatientId: null,
      fhirEnrichmentTimestamp: null,
      fhirItemsAdded: 0,
    };
  }

  // Merge each section
  const problems = mergeItems(ccdaProblems, mapConditions(summary.conditions));
  const allergies = mergeItems(ccdaAllergies, mapAllergies(summary.allergies));
  const medications = mergeItems(ccdaMedications, mapMedications(summary.medications));
  const diagnosticResults = mergeItems(ccdaDiagnosticResults, mapObservations(summary.observations));
  const encounters = mapEncounters(summary.encounters);

  const totalAdded =
    problems.added + allergies.added + medications.added + diagnosticResults.added + encounters.length;

  // Recalculate missing sections — a section is no longer missing if FHIR filled it
  const missingOptionalSections = extendedData.missingOptionalSections.filter((section) => {
    if (section === 'Problems' && problems.merged.length > 0) return false;
    if (section === 'Allergies' && allergies.merged.length > 0) return false;
    if (section === 'Medications' && medications.merged.length > 0) return false;
    if (section === 'Diagnostic Results' && diagnosticResults.merged.length > 0) return false;
    return true;
  });

  if (totalAdded > 0) {
    console.log(`[FhirEnrichment] Added ${totalAdded} items from FHIR Patient/${summary.patient.id}`);
  }

  return {
    problems: problems.merged,
    allergies: allergies.merged,
    medications: medications.merged,
    diagnosticResults: diagnosticResults.merged,
    encounters,
    missingOptionalSections,
    fhirPatientId: summary.patient.id,
    fhirEnrichmentTimestamp: new Date().toISOString(),
    fhirItemsAdded: totalAdded,
  };
}
