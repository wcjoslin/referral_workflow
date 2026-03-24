/**
 * Builds a Consult Note C-CDA document using xmlbuilder2.
 *
 * Generates a minimal but structurally valid ClinicalDocument with:
 *   - Chief Complaint (LOINC 10154-3)
 *   - History of Present Illness (LOINC 10164-2)
 *   - Assessment (LOINC 51848-0)
 *   - Plan of Treatment (LOINC 18776-5)
 *   - Physical Exam (LOINC 29545-1)
 */

import { create } from 'xmlbuilder2';
import { ConsultNoteSections } from './geminiConsultNote';

export interface CcdaBuildOptions {
  patient: { firstName: string; lastName: string; dateOfBirth: string };
  referral: { reasonForReferral: string; referrerAddress: string };
  sections: ConsultNoteSections;
  documentId: string;
  effectiveTime: Date;
}

const CCDA_NS = 'urn:hl7-org:v3';
const SECTION_DEFS = [
  { loinc: '10154-3', title: 'Chief Complaint', key: 'chiefComplaint' as const },
  { loinc: '10164-2', title: 'History of Present Illness', key: 'historyOfPresentIllness' as const },
  { loinc: '29545-1', title: 'Physical Examination', key: 'physicalExam' as const },
  { loinc: '51848-0', title: 'Assessment', key: 'assessment' as const },
  { loinc: '18776-5', title: 'Plan of Treatment', key: 'plan' as const },
];

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
 * Builds a Consult Note C-CDA XML document string.
 */
export function buildConsultNoteCcda(opts: CcdaBuildOptions): string {
  const { patient, sections, documentId, effectiveTime } = opts;

  const doc = create({ version: '1.0', encoding: 'UTF-8' })
    .ele(CCDA_NS, 'ClinicalDocument')
      .att('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance')
      .att('xsi:schemaLocation', 'urn:hl7-org:v3 CDA.xsd');

  // Template IDs — US Realm Header + Consultation Note
  doc.ele(CCDA_NS, 'templateId').att('root', '2.16.840.1.113883.10.20.22.1.1').up(); // US Realm Header
  doc.ele(CCDA_NS, 'templateId').att('root', '2.16.840.1.113883.10.20.22.1.4').up(); // Consultation Note

  // Document ID
  doc.ele(CCDA_NS, 'id').att('root', documentId).up();

  // LOINC code for Consultation Note
  doc.ele(CCDA_NS, 'code')
    .att('code', '11488-4')
    .att('codeSystem', '2.16.840.1.113883.6.1')
    .att('codeSystemName', 'LOINC')
    .att('displayName', 'Consultation Note')
    .up();

  doc.ele(CCDA_NS, 'title').txt('Consultation Note').up();
  doc.ele(CCDA_NS, 'effectiveTime').att('value', hl7DateTime(effectiveTime)).up();
  doc.ele(CCDA_NS, 'confidentialityCode').att('code', 'N').att('codeSystem', '2.16.840.1.113883.5.25').up();

  // recordTarget — patient demographics
  const rt = doc.ele(CCDA_NS, 'recordTarget').ele(CCDA_NS, 'patientRole');
  rt.ele(CCDA_NS, 'id').att('root', '2.16.840.1.113883.19.5').att('extension', 'patient-1').up();
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
  doc.up(); // recordTarget (implicit from .up chain)

  // structuredBody with sections
  const component = doc.ele(CCDA_NS, 'component');
  const body = component.ele(CCDA_NS, 'structuredBody');

  for (const def of SECTION_DEFS) {
    const content = sections[def.key] || '(No information available)';
    const sec = body.ele(CCDA_NS, 'component').ele(CCDA_NS, 'section');
    sec.ele(CCDA_NS, 'code')
      .att('code', def.loinc)
      .att('codeSystem', '2.16.840.1.113883.6.1')
      .att('codeSystemName', 'LOINC')
      .att('displayName', def.title)
      .up();
    sec.ele(CCDA_NS, 'title').txt(def.title).up();
    sec.ele(CCDA_NS, 'text').txt(content).up();
    sec.up(); // section
  }

  return doc.end({ prettyPrint: true });
}
