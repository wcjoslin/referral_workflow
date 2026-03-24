import { parseOru } from '../../../src/modules/prd04/oruParser';

const SAMPLE_ORU = [
  'MSH|^~\\&|EHR|Hospital|ReferralWorkflow|Specialist|20260324100000||ORU^R01^ORU_R01|ctrl-123|P|2.5',
  'PID|||12345^^^MRN||Doe^Jane||19800315|F',
  'OBR|1||12345|consult-note|||20260324100000',
  'OBX|1|TX|11488-4^Consultation Note^LOINC||Patient presents with exertional chest pain.||||||F',
  'OBX|2|TX|11488-4^Consultation Note^LOINC||Assessment: Likely stable angina. Plan: Cardiac catheterization.||||||F',
].join('\r\n');

describe('oruParser', () => {
  it('extracts messageControlId from MSH-10', () => {
    const result = parseOru(SAMPLE_ORU);
    expect(result.messageControlId).toBe('ctrl-123');
  });

  it('extracts patientId from PID-3', () => {
    const result = parseOru(SAMPLE_ORU);
    expect(result.patientId).toBe('12345');
  });

  it('concatenates OBX-5 fields into noteText', () => {
    const result = parseOru(SAMPLE_ORU);
    expect(result.noteText).toContain('Patient presents with exertional chest pain.');
    expect(result.noteText).toContain('Assessment: Likely stable angina.');
  });

  it('throws when MSH segment is missing', () => {
    const noMsh = 'OBX|1|TX|11488-4||Some text||||||F';
    expect(() => parseOru(noMsh)).toThrow('missing MSH segment');
  });

  it('throws when OBX segments are missing', () => {
    const noObx = 'MSH|^~\\&|EHR|Hospital|App|Facility|20260324||ORU^R01|ctrl-1|P|2.5\r\nPID|||12345';
    expect(() => parseOru(noObx)).toThrow('missing OBX segments');
  });

  it('handles LF line endings', () => {
    const lfMessage = SAMPLE_ORU.replace(/\r\n/g, '\n');
    const result = parseOru(lfMessage);
    expect(result.messageControlId).toBe('ctrl-123');
    expect(result.noteText).toContain('chest pain');
  });
});
