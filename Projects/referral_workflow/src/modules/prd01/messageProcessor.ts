import { simpleParser, ParsedMail, Attachment } from 'mailparser';
import { sendMdn } from './mdnService';
import { parseCda, ReferralData } from './cdaParser';

export interface ProcessedMessage {
  referralData: ReferralData;
  rawCdaXml: string | null;   // null if no C-CDA attachment was found
  referrerAddress: string;    // Direct address of the sender, for RRI reply routing
}

/**
 * Processes a single raw inbound email message.
 *
 * Steps:
 *   1. Parse raw email to extract sender address and Message-ID
 *   2. Immediately dispatch MDN to acknowledge receipt (RFC 3798)
 *   3. Find C-CDA attachment (.xml or .cda)
 *   4. Parse C-CDA and return structured ProcessedMessage
 */
export async function processInboundMessage(rawEmail: Buffer | string): Promise<ProcessedMessage> {
  const parsed: ParsedMail = await simpleParser(rawEmail);

  const fromAddress = parsed.from?.value?.[0]?.address ?? '';
  const messageId = parsed.messageId ?? `unknown-${Date.now()}`;

  console.log(`[MessageProcessor] Received message ${messageId} from ${fromAddress}`);

  // Step 1: Send MDN immediately — regardless of attachment presence
  if (fromAddress) {
    try {
      await sendMdn({ toAddress: fromAddress, originalMessageId: messageId });
      console.log(`[MessageProcessor] MDN sent to ${fromAddress} for message ${messageId}`);
    } catch (err) {
      // Log but do not throw — MDN failure should not block parsing
      console.error(`[MessageProcessor] Failed to send MDN for ${messageId}:`, err);
    }
  } else {
    console.warn(`[MessageProcessor] No sender address found for message ${messageId} — MDN not sent`);
  }

  // Step 2: Find C-CDA attachment
  const cdaAttachment = findCdaAttachment(parsed.attachments ?? []);

  if (!cdaAttachment) {
    console.error(`[MessageProcessor] No C-CDA attachment found in message ${messageId}`);
    return {
      referralData: {
        sourceMessageId: messageId,
        patient: { firstName: '', lastName: '', dateOfBirth: '' },
        reasonForReferral: '',
        isCdaValid: false,
        validationErrors: ['No C-CDA attachment (.xml or .cda) found in the inbound message'],
      },
      rawCdaXml: null,
      referrerAddress: fromAddress,
    };
  }

  // Step 3: Parse the C-CDA
  const cdaXml = cdaAttachment.content.toString('utf-8');
  const referralData = parseCda(cdaXml, messageId);

  if (referralData.isCdaValid) {
    console.log(
      `[MessageProcessor] Successfully parsed referral for ${referralData.patient.firstName} ${referralData.patient.lastName}`,
    );
  } else {
    console.warn(
      `[MessageProcessor] C-CDA parsed with errors for message ${messageId}:`,
      referralData.validationErrors,
    );
  }

  return { referralData, rawCdaXml: cdaXml, referrerAddress: fromAddress };
}

/**
 * Finds the first .xml or .cda attachment in an email's attachment list.
 */
function findCdaAttachment(attachments: Attachment[]): Attachment | undefined {
  return attachments.find((att) => {
    const filename = att.filename?.toLowerCase() ?? '';
    const contentType = att.contentType?.toLowerCase() ?? '';
    return (
      filename.endsWith('.xml') ||
      filename.endsWith('.cda') ||
      contentType.includes('xml') ||
      contentType.includes('cda')
    );
  });
}
