import nodemailer from 'nodemailer';
import { sendMdn } from '../../src/modules/prd01/mdnService';

// Mock nodemailer so no real SMTP connection is made in unit tests
jest.mock('nodemailer');

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'mock-sent-id' });
const mockCreateTransport = nodemailer.createTransport as jest.Mock;
mockCreateTransport.mockReturnValue({ sendMail: mockSendMail });

// Mock config to avoid requiring .env in tests
jest.mock('../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct' },
  },
}));

describe('sendMdn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls sendMail with the correct recipient', async () => {
    await sendMdn({
      toAddress: 'referrer@hospital.direct',
      originalMessageId: '<abc123@referral.direct>',
    });

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const callArgs = mockSendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.to).toBe('referrer@hospital.direct');
  });

  it('sets from address to the receiving Direct address', async () => {
    await sendMdn({
      toAddress: 'referrer@hospital.direct',
      originalMessageId: '<abc123@referral.direct>',
    });

    const callArgs = mockSendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.from).toBe('receiving@specialist.direct');
  });

  it('includes the Original-Message-ID in the disposition-notification attachment', async () => {
    const originalMessageId = '<abc123@referral.direct>';
    await sendMdn({ toAddress: 'referrer@hospital.direct', originalMessageId });

    const callArgs = mockSendMail.mock.calls[0][0] as {
      attachments: Array<{ contentType: string; content: string }>;
    };
    const dispositionPart = callArgs.attachments.find(
      (a) => a.contentType === 'message/disposition-notification',
    );

    expect(dispositionPart).toBeDefined();
    expect(dispositionPart?.content).toContain(`Original-Message-ID: ${originalMessageId}`);
  });

  it('sets Disposition to automatic-action/MDN-sent-automatically; processed', async () => {
    await sendMdn({
      toAddress: 'referrer@hospital.direct',
      originalMessageId: '<abc123@referral.direct>',
    });

    const callArgs = mockSendMail.mock.calls[0][0] as {
      attachments: Array<{ contentType: string; content: string }>;
    };
    const dispositionPart = callArgs.attachments.find(
      (a) => a.contentType === 'message/disposition-notification',
    );

    expect(dispositionPart?.content).toContain(
      'Disposition: automatic-action/MDN-sent-automatically; processed',
    );
  });

  it('includes the Final-Recipient as the receiving Direct address', async () => {
    await sendMdn({
      toAddress: 'referrer@hospital.direct',
      originalMessageId: '<abc123@referral.direct>',
    });

    const callArgs = mockSendMail.mock.calls[0][0] as {
      attachments: Array<{ contentType: string; content: string }>;
    };
    const dispositionPart = callArgs.attachments.find(
      (a) => a.contentType === 'message/disposition-notification',
    );

    expect(dispositionPart?.content).toContain(
      'Final-Recipient: rfc822; receiving@specialist.direct',
    );
  });
});
