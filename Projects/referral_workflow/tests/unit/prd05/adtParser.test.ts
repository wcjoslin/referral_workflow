import { parseAdt, AdtParseError } from '../../../src/modules/prd05/adtParser';

const VALID_ADT = [
  'MSH|^~\\&|EHR|HOSPITAL|ReferralWorkflow|SPECIALIST|20260407100000||ADT^A04|ctrl-001|P|2.5.1',
  'PID|||42||Doe^Jane||19800315|',
  'PV1||I|||||||||||||||||7',
].join('\r\n');

describe('parseAdt', () => {
  describe('valid ADT^A04', () => {
    it('extracts the message control ID from MSH-10', () => {
      const result = parseAdt(VALID_ADT);
      expect(result.messageControlId).toBe('ctrl-001');
    });

    it('extracts the patient ID from PID-3', () => {
      const result = parseAdt(VALID_ADT);
      expect(result.patientId).toBe('42');
    });

    it('extracts the appointment/referral ID from PV1-19', () => {
      const result = parseAdt(VALID_ADT);
      expect(result.appointmentId).toBe('7');
    });

    it('handles LF-separated segments', () => {
      const lf = VALID_ADT.replace(/\r\n/g, '\n');
      const result = parseAdt(lf);
      expect(result.appointmentId).toBe('7');
    });
  });

  describe('error cases', () => {
    it('throws on missing MSH segment', () => {
      expect(() => parseAdt('PID|||42')).toThrow(AdtParseError);
      expect(() => parseAdt('PID|||42')).toThrow('Missing MSH segment');
    });

    it('throws on wrong message type', () => {
      const wrong = VALID_ADT.replace('ADT^A04', 'ADT^A01');
      expect(() => parseAdt(wrong)).toThrow(AdtParseError);
      expect(() => parseAdt(wrong)).toThrow('Expected ADT^A04');
    });

    it('throws on missing MSH-10 (message control ID)', () => {
      const noCtrl = VALID_ADT.replace('ctrl-001', '');
      expect(() => parseAdt(noCtrl)).toThrow('Missing MSH-10');
    });

    it('throws on missing PID segment', () => {
      const noPid = VALID_ADT.split('\r\n').filter((s) => !s.startsWith('PID')).join('\r\n');
      expect(() => parseAdt(noPid)).toThrow('Missing PID segment');
    });

    it('throws on missing PID-3 (patient ID)', () => {
      const noPid3 = VALID_ADT.replace('PID|||42||', 'PID|||||');
      expect(() => parseAdt(noPid3)).toThrow('Missing PID-3');
    });

    it('throws on missing PV1 segment', () => {
      const noPv1 = VALID_ADT.split('\r\n').filter((s) => !s.startsWith('PV1')).join('\r\n');
      expect(() => parseAdt(noPv1)).toThrow('Missing PV1 segment');
    });

    it('throws on missing PV1-19 (visit number)', () => {
      // PV1 with fewer than 20 fields
      const shortPv1 = VALID_ADT.replace(
        'PV1||I|||||||||||||||||7',
        'PV1||I',
      );
      expect(() => parseAdt(shortPv1)).toThrow('Missing PV1-19');
    });
  });
});
