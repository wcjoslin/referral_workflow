/**
 * Builds an HL7 V2 RRI^I12 (Referral Result - Interactive) message.
 *
 * The message is constructed as a pipe-delimited string per the HL7 V2.5 spec.
 * No third-party HL7 library is used — the structure is deterministic enough
 * to build directly and avoids library compatibility issues in the PoC.
 *
 * Segments:
 *   MSH — message header
 *   MSA — message acknowledgment (AA = accept, AR = reject)
 *   RF1 — referral information (links back to source referral)
 *   PRD — provider detail (receiving facility)
 */

export interface RriOptions {
  messageControlId: string;  // MSH-10 — UUID, unique per message, used for ACK tracking
  sourceMessageId: string;   // original inbound Direct message Message-ID
  referrerAddress: string;   // Direct address of the referring provider
  sendingFacility: string;   // Direct address of the receiving/sending facility
  acceptCode: 'AA' | 'AR';  // AA = accepted, AR = rejected
  declineReason?: string;    // populated when acceptCode = 'AR'
}

/**
 * Formats a Date as HL7 DTM (YYYYMMDDHHmmss).
 */
function hl7DateTime(date: Date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-T:.Z]/g, '')
    .slice(0, 14);
}

/**
 * Escapes pipe characters in field values to prevent segment corruption.
 */
function esc(value: string): string {
  return value.replace(/\|/g, '\\F\\').replace(/\r/g, '').replace(/\n/g, '');
}

/**
 * Builds and returns an RRI^I12 HL7 V2 message string.
 * Segments are separated by CRLF as required by HL7 V2 MLLP framing.
 */
export function buildRri(opts: RriOptions): string {
  const { messageControlId, sourceMessageId, referrerAddress, sendingFacility, acceptCode, declineReason } = opts;

  const ts = hl7DateTime();

  // MSH — Message Header
  // MSH|^~\&|SendingApp|SendingFacility|ReceivingApp|ReceivingFacility|DateTime||MsgType|MsgControlId|ProcessingId|Version
  const msh = [
    'MSH',
    '^~\\&',                  // encoding characters
    'ReferralWorkflow',       // sending application
    esc(sendingFacility),     // sending facility (Direct address)
    'ReferralWorkflow',       // receiving application
    esc(referrerAddress),     // receiving facility (Direct address)
    ts,                       // date/time of message
    '',                       // security (unused)
    'RRI^I12^RRI_I12',        // message type
    esc(messageControlId),    // message control ID (MSH-10)
    'P',                      // processing ID: Production
    '2.5',                    // HL7 version
  ].join('|');

  // MSA — Message Acknowledgment
  // MSA|AckCode|MessageControlId|TextMessage
  const msaFields: string[] = ['MSA', acceptCode, esc(messageControlId)];
  if (acceptCode === 'AR' && declineReason) {
    msaFields.push(esc(declineReason));
  }
  const msa = msaFields.join('|');

  // RF1 — Referral Information
  // RF1|||||||OriginalReferralId
  // RF1-7 = Originating Referral Identifier — we use the source message ID
  const rf1 = ['RF1', '', '', '', '', '', '', esc(sourceMessageId)].join('|');

  // PRD — Provider Detail (responding provider / receiving facility)
  // PRD|RP|||||DirectAddress
  const prd = ['PRD', 'RP', '', '', '', '', esc(sendingFacility)].join('|');

  return [msh, msa, rf1, prd].join('\r\n');
}
