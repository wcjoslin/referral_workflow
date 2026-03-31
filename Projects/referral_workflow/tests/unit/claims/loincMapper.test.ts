/**
 * LOINC Mapper Tests
 */

import {
  getDocumentTypeForLoinc,
  isRecognizedLoinc,
  getAllRecognizedLoincCodes,
} from '../../../src/modules/claims/intake/loincMapper';

describe('LoincMapper', () => {
  describe('getDocumentTypeForLoinc', () => {
    it('should map 34117-2 to History and Physical', () => {
      const result = getDocumentTypeForLoinc('34117-2');
      expect(result).not.toBeNull();
      expect(result?.label).toBe('History and Physical');
      expect(result?.fhirResources).toContain('Condition');
      expect(result?.fhirResources).toContain('Medication');
      expect(result?.fhirResources).toContain('AllergyIntolerance');
      expect(result?.fhirResources).toContain('Encounter');
    });

    it('should map 11488-4 to Consultation Note', () => {
      const result = getDocumentTypeForLoinc('11488-4');
      expect(result).not.toBeNull();
      expect(result?.label).toBe('Consultation Note');
      expect(result?.fhirResources).toContain('Condition');
      expect(result?.fhirResources).toContain('Medication');
      expect(result?.fhirResources).toContain('Encounter');
      expect(result?.fhirResources).toContain('Observation');
    });

    it('should map 11506-3 to Progress Note', () => {
      const result = getDocumentTypeForLoinc('11506-3');
      expect(result).not.toBeNull();
      expect(result?.label).toBe('Progress Note');
    });

    it('should map 18842-5 to Discharge Summary', () => {
      const result = getDocumentTypeForLoinc('18842-5');
      expect(result).not.toBeNull();
      expect(result?.label).toBe('Discharge Summary');
      expect(result?.fhirResources).toContain('Procedure');
    });

    it('should map 34101-6 to Outpatient Consultation Note', () => {
      const result = getDocumentTypeForLoinc('34101-6');
      expect(result).not.toBeNull();
      expect(result?.label).toBe('Outpatient Consultation Note');
    });

    it('should return null for unknown LOINC code', () => {
      const result = getDocumentTypeForLoinc('00000-0');
      expect(result).toBeNull();
    });

    it('should return null for empty string', () => {
      const result = getDocumentTypeForLoinc('');
      expect(result).toBeNull();
    });
  });

  describe('isRecognizedLoinc', () => {
    it('should recognize 34117-2', () => {
      expect(isRecognizedLoinc('34117-2')).toBe(true);
    });

    it('should recognize 11488-4', () => {
      expect(isRecognizedLoinc('11488-4')).toBe(true);
    });

    it('should not recognize unknown code', () => {
      expect(isRecognizedLoinc('00000-0')).toBe(false);
    });

    it('should not recognize invalid format', () => {
      expect(isRecognizedLoinc('INVALID')).toBe(false);
    });
  });

  describe('getAllRecognizedLoincCodes', () => {
    it('should return array of LOINC codes', () => {
      const codes = getAllRecognizedLoincCodes();
      expect(Array.isArray(codes)).toBe(true);
      expect(codes.length).toBeGreaterThan(0);
    });

    it('should include 34117-2', () => {
      const codes = getAllRecognizedLoincCodes();
      expect(codes).toContain('34117-2');
    });

    it('should include 11488-4', () => {
      const codes = getAllRecognizedLoincCodes();
      expect(codes).toContain('11488-4');
    });

    it('should include all 5 document types', () => {
      const codes = getAllRecognizedLoincCodes();
      expect(codes).toContain('34117-2');
      expect(codes).toContain('11488-4');
      expect(codes).toContain('11506-3');
      expect(codes).toContain('18842-5');
      expect(codes).toContain('34101-6');
    });
  });
});
