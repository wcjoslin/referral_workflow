/**
 * LOINC Code to C-CDA Document Type Mapper
 *
 * Maps LOINC codes (as requested in X12N 277 messages) to C-CDA document types
 * and the FHIR resources required to build each document.
 */

export interface DocumentTypeMapping {
  label: string;
  fhirResources: string[];
}

const LOINC_TO_DOCUMENT_TYPE: Record<string, DocumentTypeMapping> = {
  // History and Physical
  '34117-2': {
    label: 'History and Physical',
    fhirResources: ['Condition', 'Medication', 'AllergyIntolerance', 'Encounter'],
  },
  // Consultation Note
  '11488-4': {
    label: 'Consultation Note',
    fhirResources: ['Condition', 'Medication', 'Encounter', 'Observation'],
  },
  // Progress Note
  '11506-3': {
    label: 'Progress Note',
    fhirResources: ['Condition', 'Medication', 'Observation', 'Encounter'],
  },
  // Discharge Summary
  '18842-5': {
    label: 'Discharge Summary',
    fhirResources: ['Encounter', 'Condition', 'Medication', 'Procedure'],
  },
  // Outpatient Consult Note
  '34101-6': {
    label: 'Outpatient Consultation Note',
    fhirResources: ['Condition', 'Medication', 'Encounter'],
  },
};

/**
 * Get the document type mapping for a given LOINC code.
 * Returns null if the LOINC code is not recognized.
 */
export function getDocumentTypeForLoinc(loincCode: string): DocumentTypeMapping | null {
  return LOINC_TO_DOCUMENT_TYPE[loincCode] ?? null;
}

/**
 * Check if a LOINC code is recognized.
 */
export function isRecognizedLoinc(loincCode: string): boolean {
  return loincCode in LOINC_TO_DOCUMENT_TYPE;
}

/**
 * Get all recognized LOINC codes.
 */
export function getAllRecognizedLoincCodes(): string[] {
  return Object.keys(LOINC_TO_DOCUMENT_TYPE);
}
