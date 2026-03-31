/**
 * Claims Signature Service
 *
 * Handles provider click-to-sign for attachment responses.
 * Embeds signer information into C-CDA legalAuthenticator elements.
 */

import { db } from '../../../db';
import { attachmentRequests, attachmentResponses } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

/**
 * Sign all documents in an attachment request.
 * Embeds provider name and NPI into legalAuthenticator elements.
 */
export async function signRequest(requestId: number, providerName: string, providerNpi: string): Promise<void> {
  console.log(`[SignatureService] Signing request ${requestId} by ${providerName}`);

  // Get all responses for this request
  const responses = await db.select().from(attachmentResponses).where(eq(attachmentResponses.requestId, requestId));

  if (responses.length === 0) {
    throw new SignatureError(`No responses found for request ${requestId}`);
  }

  // Sign each response
  const now = new Date();
  const signTimestamp = now.toISOString().replace(/[-T:.Z]/g, '').slice(0, 14); // HL7 DTM format

  for (const response of responses) {
    if (!response.ccdaXml) {
      console.warn(`[SignatureService] No CCDA XML for response ${response.id}, skipping`);
      continue;
    }

    // Embed signer information into legalAuthenticator
    const signedXml = embedSignatureInCcda(response.ccdaXml, providerName, providerNpi, signTimestamp);

    // Update response with signed XML and signature metadata
    await db
      .update(attachmentResponses)
      .set({
        ccdaXml: signedXml,
        signedByName: providerName,
        signedByNpi: providerNpi,
        signedAt: now,
      })
      .where(eq(attachmentResponses.id, response.id));

    console.log(`[SignatureService] Signed response ${response.id}`);
  }
}

/**
 * Embed provider signature into a C-CDA legalAuthenticator element.
 * Replaces placeholder signer info with actual provider details.
 */
function embedSignatureInCcda(ccdaXml: string, providerName: string, providerNpi: string, timestamp: string): string {
  // Find and replace the legalAuthenticator section
  // Pattern: <legalAuthenticator>...<assignedEntity><id root="2.16.840.1.113883.19.5" extension="signer-placeholder"/></assignedEntity>...</legalAuthenticator>

  // Simple regex replacement — replaces the placeholder extension with actual NPI
  let signedXml = ccdaXml.replace(
    /(<assignedEntity>[\s\S]*?<id root="2\.16\.840\.1\.113883\.19\.5" extension=)"signer-placeholder"/,
    `$1"${providerNpi}"`,
  );

  // Add assignedPerson with provider name if not present
  if (!signedXml.includes('<assignedPerson>')) {
    const nameParts = providerName.split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const personXml = `
    <assignedPerson>
      <name>
        <given>${firstName}</given>
        <family>${lastName}</family>
      </name>
    </assignedPerson>`;

    // Insert before closing assignedEntity tag
    signedXml = signedXml.replace(
      /(<assignedEntity[^>]*>[\s\S]*?)(<\/assignedEntity>)/,
      `$1${personXml}$2`,
    );
  }

  // Update legalAuthenticator time to signature time
  signedXml = signedXml.replace(
    /(<legalAuthenticator[\s\S]*?<time value=)"[^"]*"/,
    `$1"${timestamp}"`,
  );

  return signedXml;
}
