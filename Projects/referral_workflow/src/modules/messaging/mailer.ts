/**
 * One place that builds an SMTP transport.
 *
 * Extracted for PRD-30, which would otherwise have been the FIFTH copy of the
 * same `nodemailer.createTransport({ host, port, auth })` block — the others
 * are in prd01/mdnService, prd03/schedulingService, prd04/consultNoteService
 * and prd05/encounterService. Those four are deliberately left alone: they work,
 * and rewriting four working senders to prove a point is not this PRD's job.
 * New senders use this.
 *
 * `sendMail` RESOLVES A BOOLEAN rather than throwing. That is the unusual part
 * and it is deliberate: an invitation whose email failed still needs to exist,
 * because losing the invitation record because the mail bounced is strictly
 * worse than showing it as undelivered with a resend button. Callers that want
 * an exception can check the boolean themselves.
 */

import nodemailer from 'nodemailer';
import { config } from '../../config';

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
}

export function buildTransport(): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    auth: { user: config.smtp.user, pass: config.smtp.password },
  });
}

/** True when SMTP accepted the message. Never throws. */
export async function sendMail(mail: OutboundMail): Promise<boolean> {
  try {
    await buildTransport().sendMail({
      from: mail.from ?? config.receiving.directAddress,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
    });
    return true;
  } catch (err) {
    // Logged with the recipient but never with the body: an invitation body
    // contains the raw token, and a log line is exactly where a token must not
    // end up.
    console.error(`[Mailer] delivery to ${mail.to} failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}
