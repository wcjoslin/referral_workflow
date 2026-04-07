/**
 * Unit tests for pasBundleBuilder.ts
 */

import { buildPasBundle, extractClaim, PriorAuthFormData } from '../../../src/modules/prd12/pasBundleBuilder';

const SAMPLE_FORM: PriorAuthFormData = {
  patientFirstName: 'John',
  patientLastName: 'Doe',
  patientDob: '1985-03-15',
  patientGender: 'male',
  insurerName: 'Aetna',
  insurerId: '60054',
  subscriberId: 'MEM123456',
  serviceCode: '99213',
  serviceDisplay: 'Office visit, established patient',
  providerNpi: '1234567890',
  providerName: 'Dr. Smith',
  diagnoses: [
    { code: 'M54.5', display: 'Low back pain' },
    { code: 'G43.909', display: 'Migraine, unspecified' },
  ],
};

describe('pasBundleBuilder', () => {
  describe('buildPasBundle()', () => {
    it('returns a Bundle with correct resourceType and type', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      expect(bundle.resourceType).toBe('Bundle');
      expect(bundle.type).toBe('collection');
      expect(bundle.id).toBeTruthy();
      expect(bundle.timestamp).toBeTruthy();
    });

    it('first entry is a Claim with use=preauthorization', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      const firstEntry = bundle.entry[0];
      expect(firstEntry.resource.resourceType).toBe('Claim');
      expect(firstEntry.resource.use).toBe('preauthorization');
      expect(firstEntry.resource.status).toBe('active');
    });

    it('includes Patient, Coverage, Practitioner, Organization resources', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      const types = bundle.entry.map((e) => e.resource.resourceType);
      expect(types).toContain('Claim');
      expect(types).toContain('Patient');
      expect(types).toContain('Coverage');
      expect(types).toContain('Practitioner');
      expect(types).toContain('Organization');
    });

    it('includes Condition resources for each diagnosis', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      const conditions = bundle.entry.filter((e) => e.resource.resourceType === 'Condition');
      expect(conditions).toHaveLength(2);
    });

    it('all fullUrls use urn:uuid format', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      for (const entry of bundle.entry) {
        expect(entry.fullUrl).toMatch(/^urn:uuid:[0-9a-f-]+$/);
      }
    });

    it('no duplicate resources (unique fullUrls)', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      const urls = bundle.entry.map((e) => e.fullUrl);
      expect(new Set(urls).size).toBe(urls.length);
    });

    it('Claim references Patient via urn:uuid', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      const claim = bundle.entry[0].resource;
      const patientEntry = bundle.entry.find((e) => e.resource.resourceType === 'Patient');
      const patientRef = (claim.patient as Record<string, unknown>).reference;
      expect(patientRef).toBe(patientEntry!.fullUrl);
    });

    it('Claim references Practitioner and Organization', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      const claim = bundle.entry[0].resource;
      const practEntry = bundle.entry.find((e) => e.resource.resourceType === 'Practitioner');
      const orgEntry = bundle.entry.find((e) => e.resource.resourceType === 'Organization');

      expect((claim.provider as Record<string, unknown>).reference).toBe(practEntry!.fullUrl);
      expect((claim.insurer as Record<string, unknown>).reference).toBe(orgEntry!.fullUrl);
    });

    it('Claim item uses CPT coding system', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      const claim = bundle.entry[0].resource;
      const items = claim.item as Array<Record<string, unknown>>;
      const productOrService = items[0].productOrService as Record<string, unknown>;
      const codings = (productOrService.coding as Array<Record<string, unknown>>);
      expect(codings[0].system).toBe('http://www.ama-assn.org/go/cpt');
      expect(codings[0].code).toBe('99213');
    });

    it('Claim type is professional', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      const claim = bundle.entry[0].resource;
      const type = claim.type as Record<string, unknown>;
      const codings = type.coding as Array<Record<string, unknown>>;
      expect(codings[0].code).toBe('professional');
    });

    it('Patient has correct demographics', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      const patient = bundle.entry.find((e) => e.resource.resourceType === 'Patient')!.resource;
      const name = (patient.name as Array<Record<string, unknown>>)[0];
      expect(name.family).toBe('Doe');
      expect((name.given as string[])[0]).toBe('John');
      expect(patient.birthDate).toBe('1985-03-15');
      expect(patient.gender).toBe('male');
    });

    it('Practitioner has NPI identifier', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      const pract = bundle.entry.find((e) => e.resource.resourceType === 'Practitioner')!.resource;
      const identifiers = pract.identifier as Array<Record<string, unknown>>;
      expect(identifiers[0].system).toBe('http://hl7.org/fhir/sid/us-npi');
      expect(identifiers[0].value).toBe('1234567890');
    });

    it('handles missing diagnoses gracefully', () => {
      const formWithoutDx: PriorAuthFormData = { ...SAMPLE_FORM, diagnoses: undefined };
      const bundle = buildPasBundle(formWithoutDx);
      const conditions = bundle.entry.filter((e) => e.resource.resourceType === 'Condition');
      expect(conditions).toHaveLength(0);
      // Should have 5 entries: Claim, Patient, Coverage, Practitioner, Organization
      expect(bundle.entry).toHaveLength(5);
    });

    it('handles empty diagnoses array', () => {
      const formEmptyDx: PriorAuthFormData = { ...SAMPLE_FORM, diagnoses: [] };
      const bundle = buildPasBundle(formEmptyDx);
      const conditions = bundle.entry.filter((e) => e.resource.resourceType === 'Condition');
      expect(conditions).toHaveLength(0);
    });
  });

  describe('extractClaim()', () => {
    it('returns the Claim resource from a bundle', () => {
      const bundle = buildPasBundle(SAMPLE_FORM);
      const claim = extractClaim(bundle);
      expect(claim).not.toBeNull();
      expect(claim!.resourceType).toBe('Claim');
    });
  });
});
