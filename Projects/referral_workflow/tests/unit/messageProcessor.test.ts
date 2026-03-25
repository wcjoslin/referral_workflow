// Prevent @kno2/bluebutton (a browser-built bundle) from loading in Node environment.
// cdaParser is fully mocked below so BlueButton is never actually called.
jest.mock('@kno2/bluebutton');

import * as fs from 'fs';
import * as path from 'path';
import { processInboundMessage } from '../../src/modules/prd01/messageProcessor';
import * as mdnService from '../../src/modules/prd01/mdnService';
import * as cdaParser from '../../src/modules/prd01/cdaParser';

// Mock both dependencies — messageProcessor tests cover orchestration logic only,
// not the internals of MDN sending or C-CDA parsing (those have their own tests).
jest.mock('../../src/modules/prd01/mdnService');
jest.mock('../../src/modules/prd01/cdaParser');
jest.mock('../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct' },
  },
}));

const mockSendMdn = mdnService.sendMdn as jest.Mock;
const mockParseCda = cdaParser.parseCda as jest.Mock;

const FIXTURES = path.resolve(__dirname, '../fixtures');
const sampleCdaXml = fs.readFileSync(path.join(FIXTURES, 'sample-referral.xml'), 'utf-8');

const VALID_REFERRAL_DATA: cdaParser.ReferralData = {
  sourceMessageId: '<test-message-build-001@hospital.direct>',
  patient: { firstName: 'Michael', lastName: 'Kihn', dateOfBirth: '1974-06-25' },
  reasonForReferral: 'Cardiology evaluation',
  isCdaValid: true,
  validationErrors: [],
};

/**
 * Builds a minimal raw email (RFC 2822) with an optional C-CDA attachment.
 * Empty strings are preserved — MIME requires blank lines between headers and body.
 */
function buildRawEmail(opts: { includeCda?: boolean } = {}): string {
  const { includeCda = true } = opts;
  const boundary = 'TEST_BOUNDARY_001';
  const CRLF = '\r\n';

  const textPart = [
    `--${boundary}`,
    'Content-Type: text/plain',
    '',
    'Please find the referral attached.',
  ].join(CRLF);

  const cdaPart = includeCda
    ? [
        `--${boundary}`,
        'Content-Type: application/xml',
        'Content-Disposition: attachment; filename="referral.xml"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(sampleCdaXml).toString('base64'),
      ].join(CRLF)
    : null;

  const parts = [textPart, cdaPart, `--${boundary}--`]
    .filter((p): p is string => p !== null)
    .join(CRLF);

  const headers = [
    'From: referrer@hospital.direct',
    'To: receiving@specialist.direct',
    'Subject: Referral for Michael Kihn',
    'Message-ID: <test-message-build-001@hospital.direct>',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',  // blank line separating headers from body (required by RFC 2822)
  ].join(CRLF);

  return headers + parts;
}

describe('processInboundMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMdn.mockResolvedValue(undefined);
    mockParseCda.mockReturnValue(VALID_REFERRAL_DATA);
  });

  describe('happy path', () => {
    it('sends an MDN to the original sender', async () => {
      await processInboundMessage(buildRawEmail());
      expect(mockSendMdn).toHaveBeenCalledTimes(1);
      expect(mockSendMdn).toHaveBeenCalledWith(
        expect.objectContaining({ toAddress: 'referrer@hospital.direct' }),
      );
    });

    it('includes the original Message-ID in the MDN', async () => {
      await processInboundMessage(buildRawEmail());
      expect(mockSendMdn).toHaveBeenCalledWith(
        expect.objectContaining({
          originalMessageId: '<test-message-build-001@hospital.direct>',
        }),
      );
    });

    it('calls parseCda with the attachment content and message ID', async () => {
      await processInboundMessage(buildRawEmail());
      expect(mockParseCda).toHaveBeenCalledTimes(1);
      expect(mockParseCda).toHaveBeenCalledWith(
        expect.stringContaining('ClinicalDocument'),
        '<test-message-build-001@hospital.direct>',
      );
    });

    it('returns the ReferralData from parseCda', async () => {
      const { referralData } = await processInboundMessage(buildRawEmail());
      expect(referralData).toEqual(VALID_REFERRAL_DATA);
    });

    it('returns the raw C-CDA XML', async () => {
      const { rawCdaXml } = await processInboundMessage(buildRawEmail());
      expect(rawCdaXml).toContain('ClinicalDocument');
    });

    it('returns the referrer address from the From header', async () => {
      const { referrerAddress } = await processInboundMessage(buildRawEmail());
      expect(referrerAddress).toBe('referrer@hospital.direct');
    });
  });

  describe('missing C-CDA attachment', () => {
    it('still sends the MDN even when no C-CDA is attached', async () => {
      await processInboundMessage(buildRawEmail({ includeCda: false }));
      expect(mockSendMdn).toHaveBeenCalledTimes(1);
    });

    it('does not call parseCda when no attachment is present', async () => {
      await processInboundMessage(buildRawEmail({ includeCda: false }));
      expect(mockParseCda).not.toHaveBeenCalled();
    });

    it('returns isCdaValid false when no attachment is present', async () => {
      const { referralData } = await processInboundMessage(buildRawEmail({ includeCda: false }));
      expect(referralData.isCdaValid).toBe(false);
    });

    it('returns a validation error describing the missing attachment', async () => {
      const { referralData } = await processInboundMessage(buildRawEmail({ includeCda: false }));
      expect(referralData.validationErrors.some((e) => /attachment/i.test(e))).toBe(true);
    });

    it('returns rawCdaXml null when no attachment is present', async () => {
      const { rawCdaXml } = await processInboundMessage(buildRawEmail({ includeCda: false }));
      expect(rawCdaXml).toBeNull();
    });
  });

  describe('MDN send failure', () => {
    it('still returns ReferralData even if MDN send throws', async () => {
      mockSendMdn.mockRejectedValueOnce(new Error('SMTP connection refused'));
      const { referralData } = await processInboundMessage(buildRawEmail());
      // MDN failure is non-fatal — parsing should still complete
      expect(referralData.patient.firstName).toBe('Michael');
    });
  });
});
