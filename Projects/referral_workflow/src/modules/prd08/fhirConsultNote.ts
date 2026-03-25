/**
 * PRD-08 FHIR consult note formatter.
 *
 * Takes a FhirPatientSummary and formats it into multi-paragraph clinical
 * note text suitable for Gemini structuring into C-CDA sections.
 * Replaces the hardcoded SAMPLE_CONSULT_NOTE in mockEhr.ts.
 */

import { FhirPatientSummary } from './fhirClient';

export function formatConsultNoteFromFhir(
  summary: FhirPatientSummary,
  reasonForReferral: string,
): string {
  const sections: string[] = [];

  // Chief Complaint
  sections.push(`Chief Complaint: ${reasonForReferral || 'Referral for specialist evaluation.'}`);

  // Active Conditions
  if (summary.conditions.length > 0) {
    const lines = summary.conditions.map((c) => {
      const onset = c.onsetDate ? ` (onset ${c.onsetDate})` : '';
      return `- ${c.display}${onset} [${c.clinicalStatus}]`;
    });
    sections.push(`Active Conditions:\n${lines.join('\n')}`);
  }

  // Current Medications
  if (summary.medications.length > 0) {
    const lines = summary.medications.map((m) => {
      const dosage = m.dosage ? ` — ${m.dosage}` : '';
      return `- ${m.name}${dosage}`;
    });
    sections.push(`Current Medications:\n${lines.join('\n')}`);
  }

  // Known Allergies
  if (summary.allergies.length > 0) {
    const lines = summary.allergies.map((a) => {
      const recorded = a.recordedDate ? ` (recorded ${a.recordedDate})` : '';
      return `- ${a.substance}${recorded}`;
    });
    sections.push(`Known Allergies:\n${lines.join('\n')}`);
  }

  // Recent Observations (vitals, labs)
  if (summary.observations.length > 0) {
    const lines = summary.observations.map((o) => {
      const val = o.value ? (o.unit ? `${o.value} ${o.unit}` : o.value) : 'recorded';
      const date = o.effectiveDate ? ` (${o.effectiveDate})` : '';
      return `- ${o.display}: ${val}${date}`;
    });
    sections.push(`Recent Observations:\n${lines.join('\n')}`);
  }

  // Recent Encounters
  if (summary.encounters.length > 0) {
    const lines = summary.encounters.map((e) => {
      const period = e.period
        ? e.period.end
          ? ` (${e.period.start} – ${e.period.end})`
          : ` (${e.period.start})`
        : '';
      return `- ${e.type}${period} [${e.status}]`;
    });
    sections.push(`Recent Encounters:\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}
