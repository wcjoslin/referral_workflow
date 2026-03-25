/**
 * Unit tests for fhirClient.ts
 *
 * Mocks global.fetch to return FHIR-shaped JSON responses.
 */

jest.mock('../../../src/config', () => ({
  config: {
    fhir: { baseUrl: 'https://hapi.fhir.org/baseR4' },
  },
}));

import {
  searchPatient,
  searchPatientByMrn,
  getConditions,
  getAllergyIntolerances,
  getMedications,
  getObservations,
  getEncounters,
  getPatientSummary,
  getPatientSummaryById,
} from '../../../src/modules/prd08/fhirClient';

// ── Mock fetch ─────────────────────────────────────────────────────────────

const originalFetch = global.fetch;

function mockFetchJson(body: unknown, status = 200) {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function mockFetchError(message: string) {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockRejectedValue(new Error(message));
}

afterEach(() => {
  global.fetch = originalFetch;
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const PATIENT_BUNDLE = {
  resourceType: 'Bundle',
  entry: [
    {
      resource: {
        resourceType: 'Patient',
        id: '123836453',
        meta: { lastUpdated: '2025-01-01T00:00:00Z' },
        name: [{ given: ['Michael'], family: 'Kihn' }],
        birthDate: '1974-06-25',
        gender: 'male',
      },
    },
  ],
};

const CONDITION_BUNDLE = {
  resourceType: 'Bundle',
  entry: [
    {
      resource: {
        resourceType: 'Condition',
        code: { coding: [{ code: '195967001', display: 'Asthma' }] },
        clinicalStatus: { coding: [{ code: 'active' }] },
        onsetDateTime: '2010-03-15',
      },
    },
    {
      resource: {
        resourceType: 'Condition',
        code: { coding: [{ code: '73211009', display: 'Diabetes mellitus' }] },
        clinicalStatus: { coding: [{ code: 'active' }] },
      },
    },
  ],
};

const ALLERGY_BUNDLE = {
  resourceType: 'Bundle',
  entry: [
    {
      resource: {
        resourceType: 'AllergyIntolerance',
        code: { coding: [{ display: 'Ibuprofen' }] },
        clinicalStatus: { coding: [{ code: 'active' }] },
        recordedDate: '2020-01-10',
      },
    },
  ],
};

const MED_STATEMENT_BUNDLE = {
  resourceType: 'Bundle',
  entry: [
    {
      resource: {
        resourceType: 'MedicationStatement',
        medicationCodeableConcept: { coding: [{ display: 'Salbutamol' }] },
        status: 'active',
        dosage: [{ text: '2 puffs PRN' }],
      },
    },
  ],
};

const MED_REQUEST_BUNDLE = {
  resourceType: 'Bundle',
  entry: [
    {
      resource: {
        resourceType: 'MedicationRequest',
        medicationCodeableConcept: { coding: [{ display: 'Carvedilol' }] },
        status: 'active',
        dosageInstruction: [{ text: '25mg daily' }],
      },
    },
    {
      // Duplicate of MedicationStatement entry — should be skipped
      resource: {
        resourceType: 'MedicationRequest',
        medicationCodeableConcept: { coding: [{ display: 'Salbutamol' }] },
        status: 'active',
      },
    },
  ],
};

const OBSERVATION_BUNDLE = {
  resourceType: 'Bundle',
  entry: [
    {
      resource: {
        resourceType: 'Observation',
        code: { coding: [{ code: '8480-6', display: 'Systolic blood pressure' }] },
        valueQuantity: { value: 120, unit: 'mmHg' },
        effectiveDateTime: '2025-12-01',
        category: [{ coding: [{ code: 'vital-signs' }] }],
      },
    },
  ],
};

const ENCOUNTER_BUNDLE = {
  resourceType: 'Bundle',
  entry: [
    {
      resource: {
        resourceType: 'Encounter',
        type: [{ coding: [{ display: 'Office Visit' }] }],
        period: { start: '2025-12-01T10:00:00Z', end: '2025-12-01T11:00:00Z' },
        status: 'finished',
      },
    },
  ],
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('fhirClient', () => {
  describe('searchPatient()', () => {
    it('returns patient match from bundle', async () => {
      mockFetchJson(PATIENT_BUNDLE);
      const result = await searchPatient('Michael', 'Kihn', '1974-06-25');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('123836453');
      expect(result!.name).toBe('Michael Kihn');
      expect(result!.birthDate).toBe('1974-06-25');
      expect(result!.gender).toBe('male');
    });

    it('returns null when no patients match', async () => {
      mockFetchJson({ resourceType: 'Bundle', entry: [] });
      const result = await searchPatient('Nobody', 'Exists', '2000-01-01');
      expect(result).toBeNull();
    });

    it('returns null on empty bundle (no entry field)', async () => {
      mockFetchJson({ resourceType: 'Bundle' });
      const result = await searchPatient('Nobody', 'Exists', '2000-01-01');
      expect(result).toBeNull();
    });

    it('disambiguates multiple matches by lastUpdated', async () => {
      const multiBundle = {
        resourceType: 'Bundle',
        entry: [
          {
            resource: {
              resourceType: 'Patient', id: 'old-one',
              meta: { lastUpdated: '2020-01-01T00:00:00Z' },
              name: [{ given: ['Michael'], family: 'Kihn' }],
              birthDate: '1974-06-25', gender: 'male',
            },
          },
          {
            resource: {
              resourceType: 'Patient', id: 'new-one',
              meta: { lastUpdated: '2025-06-01T00:00:00Z' },
              name: [{ given: ['Michael'], family: 'Kihn' }],
              birthDate: '1974-06-25', gender: 'male',
            },
          },
        ],
      };
      mockFetchJson(multiBundle);
      const result = await searchPatient('Michael', 'Kihn', '1974-06-25');
      expect(result!.id).toBe('new-one');
    });
  });

  describe('searchPatientByMrn()', () => {
    it('returns patient by MRN', async () => {
      mockFetchJson(PATIENT_BUNDLE);
      const result = await searchPatientByMrn('MRN-12345');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('123836453');
    });
  });

  describe('getConditions()', () => {
    it('parses condition bundle', async () => {
      mockFetchJson(CONDITION_BUNDLE);
      const conditions = await getConditions('123836453');
      expect(conditions).toHaveLength(2);
      expect(conditions[0].display).toBe('Asthma');
      expect(conditions[0].onsetDate).toBe('2010-03-15');
      expect(conditions[0].clinicalStatus).toBe('active');
      expect(conditions[1].display).toBe('Diabetes mellitus');
      expect(conditions[1].onsetDate).toBeUndefined();
    });

    it('returns empty array on fetch error', async () => {
      mockFetchError('Network error');
      const conditions = await getConditions('123836453');
      expect(conditions).toEqual([]);
    });
  });

  describe('getAllergyIntolerances()', () => {
    it('parses allergy bundle', async () => {
      mockFetchJson(ALLERGY_BUNDLE);
      const allergies = await getAllergyIntolerances('123836453');
      expect(allergies).toHaveLength(1);
      expect(allergies[0].substance).toBe('Ibuprofen');
      expect(allergies[0].recordedDate).toBe('2020-01-10');
    });
  });

  describe('getMedications()', () => {
    it('merges MedicationStatement and MedicationRequest, deduplicating', async () => {
      // getMedications makes two parallel fetch calls
      let callCount = 0;
      (global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockImplementation(() => {
        callCount++;
        const body = callCount === 1 ? MED_STATEMENT_BUNDLE : MED_REQUEST_BUNDLE;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      });

      const meds = await getMedications('123836453');
      // Salbutamol from Statement + Carvedilol from Request (duplicate Salbutamol skipped)
      expect(meds).toHaveLength(2);
      expect(meds[0].name).toBe('Salbutamol');
      expect(meds[0].dosage).toBe('2 puffs PRN');
      expect(meds[1].name).toBe('Carvedilol');
      expect(meds[1].dosage).toBe('25mg daily');
    });
  });

  describe('getObservations()', () => {
    it('parses observation bundle with value and unit', async () => {
      mockFetchJson(OBSERVATION_BUNDLE);
      const obs = await getObservations('123836453');
      expect(obs).toHaveLength(1);
      expect(obs[0].display).toBe('Systolic blood pressure');
      expect(obs[0].value).toBe('120');
      expect(obs[0].unit).toBe('mmHg');
      expect(obs[0].category).toBe('vital-signs');
    });
  });

  describe('getEncounters()', () => {
    it('parses encounter bundle with period', async () => {
      mockFetchJson(ENCOUNTER_BUNDLE);
      const enc = await getEncounters('123836453');
      expect(enc).toHaveLength(1);
      expect(enc[0].type).toBe('Office Visit');
      expect(enc[0].status).toBe('finished');
      expect(enc[0].period?.start).toBe('2025-12-01');
    });
  });

  describe('getPatientSummary()', () => {
    it('returns null when patient not found', async () => {
      mockFetchJson({ resourceType: 'Bundle' }); // empty
      const summary = await getPatientSummary('Nobody', 'Exists', '2000-01-01');
      expect(summary).toBeNull();
    });
  });

  describe('getPatientSummaryById()', () => {
    it('returns null when patient resource not found', async () => {
      mockFetchJson(null, 404);
      const summary = await getPatientSummaryById('nonexistent');
      expect(summary).toBeNull();
    });
  });

  describe('error handling', () => {
    it('returns empty array when server returns 500', async () => {
      mockFetchJson({ error: 'internal' }, 500);
      const conditions = await getConditions('123836453');
      expect(conditions).toEqual([]);
    });
  });
});
