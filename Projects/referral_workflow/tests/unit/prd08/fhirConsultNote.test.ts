/**
 * Unit tests for fhirConsultNote.ts
 */

import { formatConsultNoteFromFhir } from '../../../src/modules/prd08/fhirConsultNote';
import { FhirPatientSummary } from '../../../src/modules/prd08/fhirClient';

function makeSummary(overrides: Partial<FhirPatientSummary> = {}): FhirPatientSummary {
  return {
    patient: { id: '123836453', name: 'Michael Kihn', birthDate: '1974-06-25', gender: 'male' },
    conditions: [
      { code: '195967001', display: 'Asthma', onsetDate: '2010-03-15', clinicalStatus: 'active' },
      { code: '73211009', display: 'Diabetes mellitus', clinicalStatus: 'active' },
    ],
    allergies: [
      { substance: 'Ibuprofen', recordedDate: '2020-01-10', clinicalStatus: 'active' },
    ],
    medications: [
      { name: 'Salbutamol', dosage: '2 puffs PRN', status: 'active' },
      { name: 'Carvedilol', dosage: '25mg daily', status: 'active' },
    ],
    observations: [
      { code: '8480-6', display: 'Systolic BP', value: '120', unit: 'mmHg', effectiveDate: '2025-12-01', category: 'vital-signs' },
    ],
    encounters: [
      { type: 'Office Visit', period: { start: '2025-12-01', end: '2025-12-01' }, status: 'finished' },
    ],
    ...overrides,
  };
}

describe('fhirConsultNote', () => {
  it('includes chief complaint from reason for referral', () => {
    const note = formatConsultNoteFromFhir(makeSummary(), 'Cardiology evaluation for chest pain');
    expect(note).toContain('Chief Complaint: Cardiology evaluation for chest pain');
  });

  it('includes conditions with onset dates', () => {
    const note = formatConsultNoteFromFhir(makeSummary(), 'Evaluation');
    expect(note).toContain('Asthma');
    expect(note).toContain('onset 2010-03-15');
    expect(note).toContain('Diabetes mellitus');
  });

  it('includes medications with dosages', () => {
    const note = formatConsultNoteFromFhir(makeSummary(), 'Evaluation');
    expect(note).toContain('Salbutamol');
    expect(note).toContain('2 puffs PRN');
    expect(note).toContain('Carvedilol');
    expect(note).toContain('25mg daily');
  });

  it('includes allergies with recorded dates', () => {
    const note = formatConsultNoteFromFhir(makeSummary(), 'Evaluation');
    expect(note).toContain('Ibuprofen');
    expect(note).toContain('recorded 2020-01-10');
  });

  it('includes observations with values and dates', () => {
    const note = formatConsultNoteFromFhir(makeSummary(), 'Evaluation');
    expect(note).toContain('Systolic BP');
    expect(note).toContain('120 mmHg');
    expect(note).toContain('2025-12-01');
  });

  it('includes encounters with periods', () => {
    const note = formatConsultNoteFromFhir(makeSummary(), 'Evaluation');
    expect(note).toContain('Office Visit');
    expect(note).toContain('2025-12-01');
  });

  it('handles empty resource arrays gracefully', () => {
    const note = formatConsultNoteFromFhir(
      makeSummary({ conditions: [], allergies: [], medications: [], observations: [], encounters: [] }),
      'Evaluation',
    );
    expect(note).toContain('Chief Complaint');
    // Should not contain section headers for empty arrays
    expect(note).not.toContain('Active Conditions');
    expect(note).not.toContain('Current Medications');
    expect(note).not.toContain('Known Allergies');
  });

  it('uses default text when reason for referral is empty', () => {
    const note = formatConsultNoteFromFhir(makeSummary(), '');
    expect(note).toContain('Referral for specialist evaluation');
  });
});
