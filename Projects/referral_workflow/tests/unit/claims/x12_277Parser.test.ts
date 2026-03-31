/**
 * X12 277 Parser Tests
 */

import { parseX12_277, ParseError } from '../../../src/modules/claims/intake/x12_277Parser';

describe('X12_277Parser', () => {
  const validX12_277 = `ISA~00~          ~01~          ~01~PROVIDER     ~01~PAYER         ~260101~0000~00401~000000001~0~T~:
ST~275~1
NM1~PR~2~ACME Insurance~~~20~ACME123
NM1~IL~1~Smith~John~M~~~MR~12345678
CLM~CLM123456
STC~T~~~~34117-2
STC~T~~~~11488-4
SE~6~1
GE~1~1
IEA~1~000000001`;

  describe('parseX12_277', () => {
    it('should parse valid 277 message', () => {
      const result = parseX12_277(validX12_277);
      expect(result.controlNumber).toBe('000000001');
      expect(result.payerName).toContain('ACME Insurance');
      expect(result.subscriberName).toContain('Smith');
      expect(result.claimNumber).toBe('CLM123456');
      expect(result.requestedLoincCodes).toContain('34117-2');
      expect(result.requestedLoincCodes).toContain('11488-4');
    });

    it('should extract payer identifier', () => {
      const result = parseX12_277(validX12_277);
      expect(result.payerIdentifier).toBeTruthy();
    });

    it('should extract subscriber information', () => {
      const result = parseX12_277(validX12_277);
      expect(result.subscriberName).toBeTruthy();
      expect(result.subscriberId).toBe('12345678');
    });

    it('should extract LOINC codes from STC segments', () => {
      const result = parseX12_277(validX12_277);
      expect(result.requestedLoincCodes.length).toBe(2);
      expect(result.requestedLoincCodes).toEqual(expect.arrayContaining(['34117-2', '11488-4']));
    });

    it('should throw error for missing control number', () => {
      const invalid = `ST~275~1
NM1~PR~2~ACME Insurance~~~20~ACME123
NM1~IL~1~Smith~John~M~~~MR~12345678`;

      expect(() => parseX12_277(invalid)).toThrow(ParseError);
      expect(() => parseX12_277(invalid)).toThrow('Missing ISA13');
    });

    it('should throw error for missing payer name', () => {
      const invalid = `ISA~00~          ~01~          ~01~PROVIDER     ~01~PAYER         ~260101~0000~00401~000000001~0~T~:
NM1~IL~1~Smith~John~M~~~MR~12345678
STC~T~~~~34117-2`;

      expect(() => parseX12_277(invalid)).toThrow(ParseError);
      expect(() => parseX12_277(invalid)).toThrow('Missing payer name');
    });

    it('should throw error for missing subscriber name', () => {
      const invalid = `ISA~00~          ~01~          ~01~PROVIDER     ~01~PAYER         ~260101~0000~00401~000000001~0~T~:
NM1~PR~2~ACME Insurance~~~20~ACME123
STC~T~~~~34117-2`;

      expect(() => parseX12_277(invalid)).toThrow(ParseError);
      expect(() => parseX12_277(invalid)).toThrow('Missing subscriber/patient name');
    });

    it('should throw error for missing LOINC codes', () => {
      const invalid = `ISA~00~          ~01~          ~01~PROVIDER     ~01~PAYER         ~260101~0000~00401~000000001~0~T~:
ST~275~1
NM1~PR~2~ACME Insurance~~~20~ACME123
NM1~IL~1~Smith~John~M~~~MR~12345678
CLM~CLM123456`;

      expect(() => parseX12_277(invalid)).toThrow(ParseError);
      expect(() => parseX12_277(invalid)).toThrow('No LOINC codes found');
    });

    it('should handle CRLF line endings', () => {
      const crlf = validX12_277.replace(/\n/g, '\r\n');
      const result = parseX12_277(crlf);
      expect(result.controlNumber).toBe('000000001');
    });

    it('should ignore invalid LOINC codes in STC', () => {
      const withInvalidLoinc = `ISA~00~          ~01~          ~01~PROVIDER     ~01~PAYER         ~260101~0000^~00401~000000001~0~T~:
ST~275~1
NM1~PR~2~ACME Insurance~~~20~ACME123
NM1~IL~1~Smith~John~M~~~MR~12345678
CLM~CLM123456
STC~T~~~~34117-2
STC~T~~~~INVALID
SE~6~1
GE~1~1
IEA~1~000000001`;

      const result = parseX12_277(withInvalidLoinc);
      expect(result.requestedLoincCodes).toEqual(['34117-2']);
      expect(result.requestedLoincCodes).not.toContain('INVALID');
    });

    it('should preserve raw X12 in output', () => {
      const result = parseX12_277(validX12_277);
      expect(result.rawX12).toBe(validX12_277);
    });
  });

  describe('LOINC validation', () => {
    it('should accept 5-digit-hyphen-1digit format', () => {
      const test277 = `ISA~00~          ~01~          ~01~PROVIDER     ~01~PAYER         ~260101~0000^~00401~000000001~0~T~:
ST~275~1
NM1~PR~2~ACME Insurance~~~20~ACME123
NM1~IL~1~Smith~John~M~~~MR~12345678
CLM~CLM123456
STC~T~~~~12345-6
SE~6~1
GE~1~1
IEA~1~000000001`;
      const result = parseX12_277(test277);
      expect(result.requestedLoincCodes).toContain('12345-6');
    });

    it('should accept 4-digit-hyphen-2digit format', () => {
      const test277 = `ISA~00~          ~01~          ~01~PROVIDER     ~01~PAYER         ~260101~0000^~00401~000000001~0~T~:
ST~275~1
NM1~PR~2~ACME Insurance~~~20~ACME123
NM1~IL~1~Smith~John~M~~~MR~12345678
CLM~CLM123456
STC~T~~~~1234-56
SE~6~1
GE~1~1
IEA~1~000000001`;
      const result = parseX12_277(test277);
      expect(result.requestedLoincCodes).toContain('1234-56');
    });

    it('should reject codes without hyphen', () => {
      const test277 = `ISA~00~          ~01~          ~01~PROVIDER     ~01~PAYER         ~260101~0000^~00401~000000001~0~T~:
ST~275~1
NM1~PR~2~ACME Insurance~~~20~ACME123
NM1~IL~1~Smith~John~M~~~MR~12345678
CLM~CLM123456
STC~T~~~~341172
SE~6~1
GE~1~1
IEA~1~000000001`;
      expect(() => parseX12_277(test277)).toThrow('No LOINC codes found');
    });
  });
});
