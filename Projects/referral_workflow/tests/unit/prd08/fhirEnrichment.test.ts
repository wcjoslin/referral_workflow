/**
 * Unit tests for fhirEnrichment.ts
 *
 * Mocks fhirClient.getPatientSummary to control FHIR responses.
 */

jest.mock('../../../src/config', () => ({
  config: {
    fhir: { baseUrl: 'https://hapi.fhir.org/baseR4' },
  },
}));

jest.mock('../../../src/modules/prd08/fhirClient', () => ({
  getPatientSummary: jest.fn(),
}));

import { enrichWithFhir, EnrichedClinicalData } from '../../../src/modules/prd08/fhirEnrichment';
import { getPatientSummary } from '../../../src/modules/prd08/fhirClient';
import { ExtendedReferralData } from '../../../src/modules/prd01/cdaParser';

const mockGetPatientSummary = getPatientSummary as jest.MockedFunction<typeof getPatientSummary>;

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeExtended(overrides: Partial<ExtendedReferralData> = {}): ExtendedReferralData {
  return {
    sourceMessageId: '<test@hospital.direct>',
    patient: { firstName: 'Michael', lastName: 'Kihn', dateOfBirth: '1974-06-25' },
    reasonForReferral: 'Cardiology evaluation',
    isCdaValid: true,
    validationErrors: [],
    problems: ['Essential Hypertension'],
    allergies: [],
    medications: ['Lisinopril 20mg'],
    diagnosticResults: [],
    missingOptionalSections: ['Allergies', 'Diagnostic Results'],
    ...overrides,
  };
}

const FHIR_SUMMARY = {
  patient: { id: '123836453', name: 'Michael Kihn', birthDate: '1974-06-25', gender: 'male' },
  conditions: [
    { code: '38341003', display: 'Essential Hypertension', onsetDate: '2018-01-10', clinicalStatus: 'active' },
    { code: '35489007', display: 'Depression', onsetDate: '2019-06-15', clinicalStatus: 'active' },
  ],
  allergies: [
    { substance: 'Ibuprofen', recordedDate: '2020-01-10', clinicalStatus: 'active' },
  ],
  medications: [
    { name: 'Salbutamol', dosage: '2 puffs PRN', status: 'active' },
    { name: 'Lisinopril 20mg', dosage: '20mg daily', status: 'active' }, // duplicate of C-CDA
  ],
  observations: [
    { code: '8480-6', display: 'Systolic BP', value: '120', unit: 'mmHg', effectiveDate: '2025-12-01', category: 'vital-signs' },
  ],
  encounters: [
    { type: 'Office Visit', period: { start: '2025-12-01', end: '2025-12-01' }, status: 'finished' },
  ],
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('fhirEnrichment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves C-CDA data as primary source', async () => {
    mockGetPatientSummary.mockResolvedValue(FHIR_SUMMARY);
    const result = await enrichWithFhir(makeExtended());

    // C-CDA items have source: 'ccda'
    expect(result.problems[0]).toEqual({ name: 'Essential Hypertension', source: 'ccda' });
    expect(result.medications[0]).toEqual({ name: 'Lisinopril 20mg', source: 'ccda' });
  });

  it('adds FHIR data with correct source tags', async () => {
    mockGetPatientSummary.mockResolvedValue(FHIR_SUMMARY);
    const result = await enrichWithFhir(makeExtended());

    // Depression is FHIR-only
    const depression = result.problems.find(p => p.name === 'Depression');
    expect(depression).toBeDefined();
    expect(depression!.source).toBe('fhir');
    expect(depression!.detail).toBe('onset 2019-06-15');

    // Ibuprofen allergy from FHIR
    expect(result.allergies).toHaveLength(1);
    expect(result.allergies[0].source).toBe('fhir');
    expect(result.allergies[0].name).toBe('Ibuprofen');
  });

  it('deduplicates: matching names are not duplicated', async () => {
    mockGetPatientSummary.mockResolvedValue(FHIR_SUMMARY);
    const result = await enrichWithFhir(makeExtended());

    // Essential Hypertension exists in both C-CDA and FHIR — only C-CDA version kept
    const hypertensions = result.problems.filter(p => p.name.toLowerCase().includes('hypertension'));
    expect(hypertensions).toHaveLength(1);
    expect(hypertensions[0].source).toBe('ccda');

    // Lisinopril exists in both — only C-CDA version kept
    const lisinopril = result.medications.filter(m => m.name.toLowerCase().includes('lisinopril'));
    expect(lisinopril).toHaveLength(1);
    expect(lisinopril[0].source).toBe('ccda');
  });

  it('recalculates missingOptionalSections after enrichment', async () => {
    mockGetPatientSummary.mockResolvedValue(FHIR_SUMMARY);
    const result = await enrichWithFhir(makeExtended());

    // Allergies was missing in C-CDA but FHIR filled it
    expect(result.missingOptionalSections).not.toContain('Allergies');
    // Diagnostic Results was missing and FHIR provided observations
    expect(result.missingOptionalSections).not.toContain('Diagnostic Results');
  });

  it('returns C-CDA data unchanged when no FHIR match', async () => {
    mockGetPatientSummary.mockResolvedValue(null);
    const extended = makeExtended();
    const result = await enrichWithFhir(extended);

    expect(result.fhirPatientId).toBeNull();
    expect(result.fhirEnrichmentTimestamp).toBeNull();
    expect(result.fhirItemsAdded).toBe(0);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toEqual({ name: 'Essential Hypertension', source: 'ccda' });
    expect(result.missingOptionalSections).toEqual(['Allergies', 'Diagnostic Results']);
  });

  it('fhirItemsAdded count is accurate', async () => {
    mockGetPatientSummary.mockResolvedValue(FHIR_SUMMARY);
    const result = await enrichWithFhir(makeExtended());

    // Added: Depression (1 condition, Hypertension deduped), Ibuprofen (1 allergy),
    // Salbutamol (1 med, Lisinopril deduped), Systolic BP (1 obs), Office Visit (1 encounter)
    expect(result.fhirItemsAdded).toBe(5);
  });

  it('sets fhirPatientId and timestamp on match', async () => {
    mockGetPatientSummary.mockResolvedValue(FHIR_SUMMARY);
    const result = await enrichWithFhir(makeExtended());

    expect(result.fhirPatientId).toBe('123836453');
    expect(result.fhirEnrichmentTimestamp).not.toBeNull();
  });

  it('handles FHIR lookup error gracefully', async () => {
    mockGetPatientSummary.mockRejectedValue(new Error('Network timeout'));
    const result = await enrichWithFhir(makeExtended());

    expect(result.fhirPatientId).toBeNull();
    expect(result.fhirItemsAdded).toBe(0);
    expect(result.problems).toHaveLength(1); // C-CDA data preserved
  });

  it('includes encounters from FHIR', async () => {
    mockGetPatientSummary.mockResolvedValue(FHIR_SUMMARY);
    const result = await enrichWithFhir(makeExtended());

    expect(result.encounters).toHaveLength(1);
    expect(result.encounters[0].name).toBe('Office Visit');
    expect(result.encounters[0].source).toBe('fhir');
    expect(result.encounters[0].detail).toBe('2025-12-01 – 2025-12-01');
  });
});
