import { buildConsultNoteCcda } from '../../../src/modules/prd04/ccdaBuilder';

const OPTS = {
  patient: { firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1980-03-15' },
  referral: { reasonForReferral: 'Cardiology evaluation', referrerAddress: 'referrer@hospital.direct' },
  sections: {
    chiefComplaint: 'Exertional chest pain',
    historyOfPresentIllness: 'Progressive chest tightness over 3 months',
    assessment: 'Likely stable angina',
    plan: 'Refer for cardiac catheterization',
    physicalExam: 'Regular rate and rhythm, no murmurs',
  },
  documentId: 'test-doc-id-123',
  effectiveTime: new Date('2026-03-24T12:00:00Z'),
};

describe('ccdaBuilder', () => {
  let xml: string;

  beforeAll(() => {
    xml = buildConsultNoteCcda(OPTS);
  });

  it('produces valid XML with ClinicalDocument root', () => {
    expect(xml).toContain('<?xml');
    expect(xml).toContain('ClinicalDocument');
  });

  it('includes US Realm Header template ID', () => {
    expect(xml).toContain('2.16.840.1.113883.10.20.22.1.1');
  });

  it('includes Consultation Note template ID', () => {
    expect(xml).toContain('2.16.840.1.113883.10.20.22.1.4');
  });

  it('includes LOINC code for Consultation Note (11488-4)', () => {
    expect(xml).toContain('11488-4');
  });

  it('includes patient name', () => {
    expect(xml).toContain('Jane');
    expect(xml).toContain('Doe');
  });

  it('includes patient birth time', () => {
    expect(xml).toContain('19800315');
  });

  it('includes Chief Complaint section with LOINC 10154-3', () => {
    expect(xml).toContain('10154-3');
    expect(xml).toContain('Exertional chest pain');
  });

  it('includes History of Present Illness section with LOINC 10164-2', () => {
    expect(xml).toContain('10164-2');
    expect(xml).toContain('Progressive chest tightness');
  });

  it('includes Assessment section with LOINC 51848-0', () => {
    expect(xml).toContain('51848-0');
    expect(xml).toContain('Likely stable angina');
  });

  it('includes Plan section with LOINC 18776-5', () => {
    expect(xml).toContain('18776-5');
    expect(xml).toContain('cardiac catheterization');
  });

  it('includes Physical Exam section with LOINC 29545-1', () => {
    expect(xml).toContain('29545-1');
    expect(xml).toContain('Regular rate and rhythm');
  });

  it('uses fallback text for empty sections', () => {
    const sparseXml = buildConsultNoteCcda({
      ...OPTS,
      sections: {
        chiefComplaint: 'Chest pain',
        historyOfPresentIllness: '',
        assessment: 'Stable angina',
        plan: '',
        physicalExam: '',
      },
    });
    expect(sparseXml).toContain('No information available');
  });
});
