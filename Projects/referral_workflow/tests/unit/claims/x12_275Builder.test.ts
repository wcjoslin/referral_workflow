/**
 * X12 275 Builder Tests
 */

import { buildX12_275 } from '../../../src/modules/claims/response/x12_275Builder';

describe('X12_275Builder', () => {
  const buildOptions = (overrides = {}) => ({
    controlNumber: '000000001',
    senderCode: 'PROVIDER',
    receiverCode: 'PAYER',
    payerName: 'ACME Insurance',
    payerIdentifier: 'ACME123',
    providerName: 'Dr. Jane Doe',
    providerIdentifier: '1234567890',
    subscriberName: 'John Smith',
    documents: [
      {
        loincCode: '34117-2',
        ccdaXml: '<?xml version="1.0"?><ClinicalDocument>Test</ClinicalDocument>',
      },
    ],
    ...overrides,
  });

  describe('buildX12_275', () => {
    it('should build valid X12 275 message', () => {
      const message = buildX12_275(buildOptions());
      expect(message).toContain('ISA');
      expect(message).toContain('ST~275');
      expect(message).toContain('GS');
      expect(message).toContain('SE');
      expect(message).toContain('GE');
      expect(message).toContain('IEA');
    });

    it('should include ISA segment with control number', () => {
      const message = buildX12_275(buildOptions());
      expect(message).toContain('ISA');
      expect(message).toContain('000000001');
    });

    it('should include ST segment with 275 type', () => {
      const message = buildX12_275(buildOptions());
      expect(message).toContain('ST~275');
    });

    it('should include BHT segment', () => {
      const message = buildX12_275(buildOptions());
      expect(message).toContain('BHT');
      expect(message).toContain('0019');
    });

    it('should include NM1 segment for provider', () => {
      const message = buildX12_275(buildOptions());
      expect(message).toContain('NM1~IL');
      expect(message).toContain('Dr. Jane Doe');
    });

    it('should include STC segment with LOINC code', () => {
      const message = buildX12_275(buildOptions());
      expect(message).toContain('STC');
      expect(message).toContain('34117-2');
    });

    it('should include BDS segment with Base64 data', () => {
      const message = buildX12_275(buildOptions());
      expect(message).toContain('BDS');
      expect(message).toContain('B64');
      // Base64 encoded version of the CCDA
      expect(message).toMatch(/BDS~B64~\d+~/);
    });

    it('should Base64 encode CCDA properly', () => {
      const ccda = '<?xml version="1.0"?><ClinicalDocument>Test</ClinicalDocument>';
      const expectedBase64 = Buffer.from(ccda, 'utf-8').toString('base64');
      const message = buildX12_275(buildOptions({ documents: [{ loincCode: '34117-2', ccdaXml: ccda }] }));
      expect(message).toContain(expectedBase64);
    });

    it('should handle multiple documents', () => {
      const message = buildX12_275(
        buildOptions({
          documents: [
            { loincCode: '34117-2', ccdaXml: '<doc1/>' },
            { loincCode: '11488-4', ccdaXml: '<doc2/>' },
            { loincCode: '11506-3', ccdaXml: '<doc3/>' },
          ],
        }),
      );

      // Should have 3 STC segments
      const stcCount = (message.match(/^STC/gm) || []).length;
      expect(stcCount).toBe(3);

      // Should have 3 BDS segments
      const bdsCount = (message.match(/^BDS/gm) || []).length;
      expect(bdsCount).toBe(3);

      // All LOINC codes present
      expect(message).toContain('34117-2');
      expect(message).toContain('11488-4');
      expect(message).toContain('11506-3');
    });

    it('should end with CRLF', () => {
      const message = buildX12_275(buildOptions());
      expect(message).toMatch(/~\r\n$/);
    });

    it('should use CRLF as segment separator', () => {
      const message = buildX12_275(buildOptions());
      expect(message).toContain('~\r\n');
    });

    it('should include GE segment with functional group count', () => {
      const message = buildX12_275(buildOptions());
      expect(message).toContain('GE~1~');
    });

    it('should include IEA segment with interchange count', () => {
      const message = buildX12_275(buildOptions());
      expect(message).toContain('IEA~1~');
    });

    it('should generate unique control numbers', () => {
      const msg1 = buildX12_275(buildOptions());
      const msg2 = buildX12_275(buildOptions());

      // Extract ST control numbers - they should be different
      const cn1 = msg1.match(/ST~275~(\d+)/)?.[1];
      const cn2 = msg2.match(/ST~275~(\d+)/)?.[1];

      expect(cn1).toBeDefined();
      expect(cn2).toBeDefined();
      expect(cn1).not.toBe(cn2);
    });

    it('should include payer and provider information', () => {
      const message = buildX12_275(buildOptions());
      // Payer name and ID in NM1 segment, provider name and ID in NM1 segment
      expect(message).toContain('ACME Insurance');
      expect(message).toContain('ACME123');
      expect(message).toContain('Dr. Jane Doe');
    });

    it('should handle special characters in XML', () => {
      const ccdaWithSpecialChars = '<?xml version="1.0"?><root attr="value&amp;test">Content</root>';
      const message = buildX12_275(
        buildOptions({
          documents: [{ loincCode: '34117-2', ccdaXml: ccdaWithSpecialChars }],
        }),
      );
      const expectedBase64 = Buffer.from(ccdaWithSpecialChars, 'utf-8').toString('base64');
      expect(message).toContain(expectedBase64);
    });

    it('should be parseable back to segments', () => {
      const message = buildX12_275(buildOptions());
      // Remove trailing CRLF and split by segment separator
      const segments = message.trim().split('~\r\n');
      expect(segments.length).toBeGreaterThan(0);
      expect(segments[0]).toContain('ISA');
    });
  });
});
