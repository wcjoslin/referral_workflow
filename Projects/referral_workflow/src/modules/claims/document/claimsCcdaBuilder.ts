/**
 * Claims-specific C-CDA Document Builder
 *
 * Builds C-CDA documents for X12N 275 attachment responses.
 * Supports multiple document types identified by LOINC codes.
 * Uses xmlbuilder2 (same as prd04/ccdaBuilder.ts).
 */

import { create } from 'xmlbuilder2';
import {
  FhirCondition,
  FhirMedication,
  FhirAllergy,
  FhirObservation,
  FhirEncounter,
} from '../../prd08/fhirClient';

const CCDA_NS = 'urn:hl7-org:v3';

export interface ClaimsCcdaBuildOptions {
  patient: { id: string; firstName: string; lastName: string; dateOfBirth: string };
  loincCode: string;
  documentType: string;
  fhirData: {
    conditions?: FhirCondition[];
    medications?: FhirMedication[];
    allergies?: FhirAllergy[];
    observations?: FhirObservation[];
    encounters?: FhirEncounter[];
  };
  documentId: string;
  effectiveTime: Date;
  organizationName?: string;
  authorName?: string;
}

/**
 * Formats a Date as HL7 DTM (YYYYMMDDHHmmss).
 */
function hl7DateTime(date: Date): string {
  return date.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
}

/**
 * Formats a date string (YYYY-MM-DD) as HL7 date (YYYYMMDD).
 */
function hl7Date(isoDate: string): string {
  return isoDate.replace(/-/g, '');
}

/**
 * Build C-CDA XML for a claims attachment document.
 * Document type and sections vary based on LOINC code.
 */
export function buildClaimsCcda(opts: ClaimsCcdaBuildOptions): string {
  const { patient, loincCode, documentType, fhirData, documentId, effectiveTime, organizationName, authorName } =
    opts;

  const doc = create({ version: '1.0', encoding: 'UTF-8' })
    .ele(CCDA_NS, 'ClinicalDocument')
    .att('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance')
    .att('xsi:schemaLocation', 'urn:hl7-org:v3 CDA.xsd');

  // Template IDs — US Realm Header
  doc.ele(CCDA_NS, 'templateId').att('root', '2.16.840.1.113883.10.20.22.1.1').up(); // US Realm Header

  // Document ID
  doc.ele(CCDA_NS, 'id').att('root', documentId).up();

  // LOINC code for document type
  doc
    .ele(CCDA_NS, 'code')
    .att('code', loincCode)
    .att('codeSystem', '2.16.840.1.113883.6.1')
    .att('codeSystemName', 'LOINC')
    .att('displayName', documentType)
    .up();

  doc.ele(CCDA_NS, 'title').txt(documentType).up();
  doc.ele(CCDA_NS, 'effectiveTime').att('value', hl7DateTime(effectiveTime)).up();
  doc.ele(CCDA_NS, 'confidentialityCode').att('code', 'N').att('codeSystem', '2.16.840.1.113883.5.25').up();

  // author
  const author = doc.ele(CCDA_NS, 'author');
  author.ele(CCDA_NS, 'time').att('value', hl7DateTime(effectiveTime)).up();
  const assignedAuthor = author.ele(CCDA_NS, 'assignedAuthor');
  assignedAuthor.ele(CCDA_NS, 'id').att('root', '2.16.840.1.113883.19.5').att('extension', 'author-1').up();
  if (organizationName) {
    assignedAuthor.ele(CCDA_NS, 'representedOrganization').ele(CCDA_NS, 'name').txt(organizationName).up().up();
  }
  if (authorName) {
    const assignedPerson = assignedAuthor.ele(CCDA_NS, 'assignedPerson');
    const name = assignedPerson.ele(CCDA_NS, 'name');
    name.ele(CCDA_NS, 'given').txt(authorName.split(' ')[0] || '').up();
    name.ele(CCDA_NS, 'family').txt(authorName.split(' ').slice(1).join(' ') || '').up();
  }

  // Placeholder for legalAuthenticator (will be filled in at sign time)
  const legalAuth = doc.ele(CCDA_NS, 'legalAuthenticator');
  legalAuth.ele(CCDA_NS, 'time').att('value', hl7DateTime(effectiveTime)).up();
  legalAuth.ele(CCDA_NS, 'signatureCode').att('code', 'S').up();
  const assignedEntity = legalAuth.ele(CCDA_NS, 'assignedEntity');
  assignedEntity.ele(CCDA_NS, 'id').att('root', '2.16.840.1.113883.19.5').att('extension', 'signer-placeholder').up();

  // recordTarget — patient demographics
  const rt = doc.ele(CCDA_NS, 'recordTarget').ele(CCDA_NS, 'patientRole');
  rt.ele(CCDA_NS, 'id')
    .att('root', '2.16.840.1.113883.19.5')
    .att('extension', patient.id)
    .up();
  const pat = rt.ele(CCDA_NS, 'patient');
  const name = pat.ele(CCDA_NS, 'name');
  name.ele(CCDA_NS, 'given').txt(patient.firstName).up();
  name.ele(CCDA_NS, 'family').txt(patient.lastName).up();
  name.up();
  if (patient.dateOfBirth) {
    pat.ele(CCDA_NS, 'birthTime').att('value', hl7Date(patient.dateOfBirth)).up();
  }
  pat.up(); // patient
  rt.up(); // patientRole

  // structuredBody with sections based on LOINC type
  const component = doc.ele(CCDA_NS, 'component');
  const body = component.ele(CCDA_NS, 'structuredBody');

  // Add sections based on document type
  addDocumentSections(body, loincCode, fhirData);

  return doc.end({ prettyPrint: true });
}

/**
 * Add structured sections to the document body based on LOINC code.
 */
function addDocumentSections(
  bodyElement: any,
  loincCode: string,
  fhirData: ClaimsCcdaBuildOptions['fhirData'],
): void {
  switch (loincCode) {
    case '34117-2': // History and Physical
      addHistoryAndPhysicalSections(bodyElement, fhirData);
      break;
    case '11488-4': // Consultation Note
      addConsultationNoteSections(bodyElement, fhirData);
      break;
    case '11506-3': // Progress Note
      addProgressNoteSections(bodyElement, fhirData);
      break;
    case '18842-5': // Discharge Summary
      addDischargeSummarySections(bodyElement, fhirData);
      break;
    case '34101-6': // Outpatient Consult Note
      addOutpatientConsultSections(bodyElement, fhirData);
      break;
    default:
      // Generic sections
      addGenericSections(bodyElement, fhirData);
  }
}

function addHistoryAndPhysicalSections(bodyElement: any, fhirData: ClaimsCcdaBuildOptions['fhirData']): void {
  // History of Present Illness
  addSection(bodyElement, '10164-2', 'History of Present Illness', formatEncounters(fhirData.encounters));

  // Medications
  addSection(bodyElement, '10160-0', 'Medications', formatMedications(fhirData.medications));

  // Allergies
  addSection(bodyElement, '48765-2', 'Allergies', formatAllergies(fhirData.allergies));

  // Assessment/Diagnosis
  addSection(bodyElement, '51848-0', 'Assessment', formatConditions(fhirData.conditions));
}

function addConsultationNoteSections(bodyElement: any, fhirData: ClaimsCcdaBuildOptions['fhirData']): void {
  // Chief Complaint
  addSection(bodyElement, '10154-3', 'Chief Complaint', formatEncounters(fhirData.encounters));

  // History of Present Illness
  addSection(bodyElement, '10164-2', 'History of Present Illness', formatConditions(fhirData.conditions));

  // Assessment
  addSection(bodyElement, '51848-0', 'Assessment', formatObservations(fhirData.observations));

  // Plan
  addSection(bodyElement, '18776-5', 'Plan of Treatment', formatMedications(fhirData.medications));
}

function addProgressNoteSections(bodyElement: any, fhirData: ClaimsCcdaBuildOptions['fhirData']): void {
  // Subjective (History)
  addSection(bodyElement, '10164-2', 'Subjective', formatEncounters(fhirData.encounters));

  // Assessment
  addSection(bodyElement, '51848-0', 'Assessment', formatConditions(fhirData.conditions));

  // Objective (Observations)
  addSection(bodyElement, '29545-1', 'Objective', formatObservations(fhirData.observations));

  // Plan
  addSection(bodyElement, '18776-5', 'Plan', formatMedications(fhirData.medications));
}

function addDischargeSummarySections(bodyElement: any, fhirData: ClaimsCcdaBuildOptions['fhirData']): void {
  // Hospital Course
  addSection(bodyElement, '8648-8', 'Hospital Course', formatEncounters(fhirData.encounters));

  // Discharge Diagnosis
  addSection(bodyElement, '11850-4', 'Discharge Diagnosis', formatConditions(fhirData.conditions));

  // Medications on Discharge
  addSection(bodyElement, '10160-0', 'Medications on Discharge', formatMedications(fhirData.medications));

  // Allergies
  addSection(bodyElement, '48765-2', 'Allergies', formatAllergies(fhirData.allergies));
}

function addOutpatientConsultSections(bodyElement: any, fhirData: ClaimsCcdaBuildOptions['fhirData']): void {
  // History of Present Illness
  addSection(bodyElement, '10164-2', 'History of Present Illness', formatConditions(fhirData.conditions));

  // Assessment
  addSection(bodyElement, '51848-0', 'Assessment', formatObservations(fhirData.observations));

  // Plan
  addSection(bodyElement, '18776-5', 'Plan', formatMedications(fhirData.medications));
}

function addGenericSections(bodyElement: any, fhirData: ClaimsCcdaBuildOptions['fhirData']): void {
  if (fhirData.conditions && fhirData.conditions.length > 0) {
    addSection(bodyElement, '11450-4', 'Problems', formatConditions(fhirData.conditions));
  }
  if (fhirData.medications && fhirData.medications.length > 0) {
    addSection(bodyElement, '10160-0', 'Medications', formatMedications(fhirData.medications));
  }
  if (fhirData.allergies && fhirData.allergies.length > 0) {
    addSection(bodyElement, '48765-2', 'Allergies', formatAllergies(fhirData.allergies));
  }
}

function addSection(bodyElement: any, loincCode: string, title: string, content: string): void {
  const sec = bodyElement.ele(CCDA_NS, 'component').ele(CCDA_NS, 'section');
  sec
    .ele(CCDA_NS, 'code')
    .att('code', loincCode)
    .att('codeSystem', '2.16.840.1.113883.6.1')
    .att('codeSystemName', 'LOINC')
    .att('displayName', title)
    .up();
  sec.ele(CCDA_NS, 'title').txt(title).up();
  sec.ele(CCDA_NS, 'text').txt(content || '(No information available)').up();
}

function formatConditions(conditions?: FhirCondition[]): string {
  if (!conditions || conditions.length === 0) return '(No conditions recorded)';
  return conditions.map((c) => `- ${c.code}: ${c.display}`).join('\n');
}

function formatMedications(medications?: FhirMedication[]): string {
  if (!medications || medications.length === 0) return '(No medications recorded)';
  return medications.map((m) => `- ${m.name} ${m.dosage ? `(${m.dosage})` : ''}`).join('\n');
}

function formatAllergies(allergies?: FhirAllergy[]): string {
  if (!allergies || allergies.length === 0) return '(No allergies recorded)';
  return allergies.map((a) => `- ${a.substance} (${a.clinicalStatus})`).join('\n');
}

function formatObservations(observations?: FhirObservation[]): string {
  if (!observations || observations.length === 0) return '(No observations recorded)';
  return observations.map((o) => `- ${o.display}: ${o.value}`).join('\n');
}

function formatEncounters(encounters?: FhirEncounter[]): string {
  if (!encounters || encounters.length === 0) return '(No encounters recorded)';
  return encounters
    .map((e) => {
      const date = e.period?.start || 'Unknown date';
      return `- ${e.type} on ${date}`;
    })
    .join('\n');
}
