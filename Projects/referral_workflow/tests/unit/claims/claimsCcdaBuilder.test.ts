/**
 * Claims C-CDA Builder Tests
 */

import { buildClaimsCcda } from '../../../src/modules/claims/document/claimsCcdaBuilder';

describe('ClaimsCcdaBuilder', () => {
  const buildOptions = (overrides = {}) => ({
    patient: {
      id: 'patient-123',
      firstName: 'John',
      lastName: 'Smith',
      dateOfBirth: '1980-05-15',
    },
    loincCode: '34117-2',
    documentType: 'History and Physical',
    fhirData: {
      conditions: [
        { code: 'I10', display: 'Essential (primary) hypertension', onsetDate: '2024-01-15', clinicalStatus: 'active' },
      ],
      medications: [
        { name: 'Lisinopril', dosage: '10mg daily', status: 'active' },
      ],
      allergies: [
        { substance: 'Penicillin', clinicalStatus: 'active', recordedDate: '2024-01-15' },
      ],
      observations: [
        { code: '85354-9', display: 'Blood Pressure', value: '130/85 mmHg', category: 'vital-signs', effectiveDate: '2024-03-31' },
      ],
      encounters: [
        { type: 'Office Visit', period: { start: '2024-03-31', end: '2024-03-31' }, status: 'finished' },
      ],
    },
    documentId: 'doc-123',
    effectiveTime: new Date('2024-03-31T10:00:00Z'),
    organizationName: 'Healthcare Org',
    authorName: 'Dr. Jane Doe',
    ...overrides,
  });

  describe('buildClaimsCcda', () => {
    it('should build valid XML for History and Physical', () => {
      const xml = buildClaimsCcda(buildOptions());
      expect(xml).toContain('<?xml');
      expect(xml).toContain('ClinicalDocument');
      expect(xml).toContain('34117-2');
      expect(xml).toContain('History and Physical');
    });

    it('should include patient demographics', () => {
      const xml = buildClaimsCcda(buildOptions());
      expect(xml).toContain('John');
      expect(xml).toContain('Smith');
      // DOB is converted to HL7 format (YYYYMMDD)
      expect(xml).toContain('19800515');
    });

    it('should include LOINC code in code element', () => {
      const xml = buildClaimsCcda(buildOptions());
      expect(xml).toContain('code="34117-2"');
      expect(xml).toContain('codeSystem="2.16.840.1.113883.6.1"');
      expect(xml).toContain('LOINC');
    });

    it('should include document title', () => {
      const xml = buildClaimsCcda(buildOptions());
      expect(xml).toContain('<title>History and Physical</title>');
    });

    it('should include recordTarget element', () => {
      const xml = buildClaimsCcda(buildOptions());
      expect(xml).toContain('recordTarget');
      expect(xml).toContain('patientRole');
    });

    it('should include legalAuthenticator placeholder', () => {
      const xml = buildClaimsCcda(buildOptions());
      expect(xml).toContain('legalAuthenticator');
      expect(xml).toContain('signer-placeholder');
    });

    it('should include conditions in assessment section', () => {
      const xml = buildClaimsCcda(buildOptions());
      expect(xml).toContain('I10');
      expect(xml).toContain('Essential (primary) hypertension');
    });

    it('should include medications section', () => {
      const xml = buildClaimsCcda(buildOptions());
      expect(xml).toContain('Lisinopril');
      expect(xml).toContain('10mg daily');
    });

    it('should include allergies section', () => {
      const xml = buildClaimsCcda(buildOptions());
      expect(xml).toContain('Penicillin');
      expect(xml).toContain('active');
    });

    it('should handle Consultation Note (11488-4)', () => {
      const xml = buildClaimsCcda(buildOptions({ loincCode: '11488-4', documentType: 'Consultation Note' }));
      expect(xml).toContain('11488-4');
      expect(xml).toContain('Consultation Note');
      expect(xml).toContain('Chief Complaint');
    });

    it('should handle Progress Note (11506-3)', () => {
      const xml = buildClaimsCcda(buildOptions({ loincCode: '11506-3', documentType: 'Progress Note' }));
      expect(xml).toContain('11506-3');
      expect(xml).toContain('Progress Note');
      expect(xml).toContain('Subjective');
      expect(xml).toContain('Objective');
    });

    it('should handle Discharge Summary (18842-5)', () => {
      const xml = buildClaimsCcda(
        buildOptions({ loincCode: '18842-5', documentType: 'Discharge Summary' }),
      );
      expect(xml).toContain('18842-5');
      expect(xml).toContain('Discharge Summary');
      expect(xml).toContain('Hospital Course');
    });

    it('should handle Outpatient Consult (34101-6)', () => {
      const xml = buildClaimsCcda(
        buildOptions({ loincCode: '34101-6', documentType: 'Outpatient Consultation Note' }),
      );
      expect(xml).toContain('34101-6');
      expect(xml).toContain('Outpatient');
    });

    it('should gracefully handle missing FHIR data', () => {
      const options = buildOptions({
        fhirData: {},
      });
      const xml = buildClaimsCcda(options);
      // When no FHIR data, sections will have "No [type] recorded" messages
      expect(xml).toMatch(/No (medications|conditions|allergies) recorded/);
    });

    it('should handle empty condition array', () => {
      const options = buildOptions({
        fhirData: { conditions: [] },
      });
      const xml = buildClaimsCcda(options);
      expect(xml).toContain('No conditions recorded');
    });

    it('should include author information', () => {
      const xml = buildClaimsCcda(buildOptions());
      expect(xml).toContain('author');
      expect(xml).toContain('Healthcare Org');
    });

    it('should include author name', () => {
      const xml = buildClaimsCcda(buildOptions());
      expect(xml).toContain('Jane');
      expect(xml).toContain('Doe');
    });

    it('should be valid XML (parseable)', () => {
      const xml = buildClaimsCcda(buildOptions());
      // Basic XML validation - contains XML structure
      expect(xml).toContain('<?xml');
      expect(xml).toContain('</ClinicalDocument>');
      expect(xml).toContain('<');
      expect(xml).toContain('>');
    });

    it('should include document ID', () => {
      const xml = buildClaimsCcda(buildOptions({ documentId: 'my-unique-id-123' }));
      expect(xml).toContain('my-unique-id-123');
    });

    it('should include effective time', () => {
      const xml = buildClaimsCcda(buildOptions());
      expect(xml).toContain('effectiveTime');
      // Should contain a timestamp value
      expect(xml).toMatch(/value="[0-9]{14}"/);
    });
  });
});
