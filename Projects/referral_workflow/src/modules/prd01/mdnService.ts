import nodemailer from 'nodemailer';
import { config } from '../../config';

export interface MdnOptions {
  /** The Direct address of the original sender — MDN is delivered here */
  toAddress: string;
  /** The Message-ID header value from the inbound referral email */
  originalMessageId: string;
}

/**
 * Sends an RFC 3798-compliant Message Delivery Notification (MDN) to the
 * original sender of a referral message.
 *
 * The MDN is a multipart/report email with two parts:
 *   1. Human-readable plain text
 *   2. Machine-readable message/disposition-notification block
 *
 * This is an email-protocol acknowledgment — NOT an HL7 V2 message.
 */
export async function sendMdn(options: MdnOptions): Promise<void> {
  const { toAddress, originalMessageId } = options;

  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.password,
    },
  });

  // Part 2: machine-readable disposition-notification block (RFC 3798 §3.2)
  const dispositionNotification = [
    `Reporting-UA: referral-workflow-poc; Node.js`,
    `Original-Recipient: rfc822; ${config.receiving.directAddress}`,
    `Final-Recipient: rfc822; ${config.receiving.directAddress}`,
    `Original-Message-ID: ${originalMessageId}`,
    `Disposition: automatic-action/MDN-sent-automatically; processed`,
  ].join('\r\n');

  await transport.sendMail({
    from: config.receiving.directAddress,
    to: toAddress,
    subject: 'Message Delivery Notification',
    // multipart/report with report-type=disposition-notification
    attachments: [
      {
        contentType: 'message/disposition-notification',
        content: dispositionNotification,
      },
    ],
    text: `Your referral message (ID: ${originalMessageId}) was successfully received by ${config.receiving.directAddress} and is being processed.`,
  });
}
