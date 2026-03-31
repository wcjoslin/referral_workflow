/**
 * Claims Response Service
 *
 * Orchestrates sending of X12N 275 response messages.
 * Builds 275 from signed documents and writes to outbound directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../../db';
import { attachmentRequests, attachmentResponses } from '../../../db/schema';
import { ClaimsAttachmentState, transition } from '../../../state/claimsStateMachine';
import { config } from '../../../config';
import { buildX12_275 } from './x12_275Builder';
import { eq } from 'drizzle-orm';

/**
 * Send a signed claims response.
 * Builds X12 275 message and writes to outbound directory.
 * Transitions request to Sent state.
 */
export async function sendResponse(requestId: number): Promise<string> {
  console.log(`[ResponseService] Sending response for request ${requestId}`);

  try {
    // Get request
    const [request] = await db.select().from(attachmentRequests).where(eq(attachmentRequests.id, requestId));

    if (!request) {
      throw new Error(`Request not found: ${requestId}`);
    }

    // Get signed responses
    const responses = await db
      .select()
      .from(attachmentResponses)
      .where(eq(attachmentResponses.requestId, requestId));

    if (responses.length === 0) {
      throw new Error(`No responses found for request ${requestId}`);
    }

    // Check that all are signed
    const unsigned = responses.filter((r) => !r.signedAt);
    if (unsigned.length > 0) {
      throw new Error(`Not all documents are signed (${unsigned.length} unsigned)`);
    }

    // Check that all have CCDA XML
    const missing = responses.filter((r) => !r.ccdaXml);
    if (missing.length > 0) {
      throw new Error(`Missing CCDA XML for ${missing.length} document(s)`);
    }

    // Build 275
    const documents = responses.map((r) => ({
      loincCode: r.loincCode,
      ccdaXml: r.ccdaXml!,
    }));

    const x12_275 = buildX12_275({
      controlNumber: request.controlNumber,
      senderCode: 'PROVIDER',
      receiverCode: 'PAYER',
      payerName: request.payerName,
      payerIdentifier: request.payerIdentifier,
      providerName: responses[0]?.signedByName || 'Provider',
      providerIdentifier: responses[0]?.signedByNpi || '0000000000',
      subscriberName: request.subscriberName,
      documents,
    });

    // Generate control number for this transmission
    const x12ControlNumber = Math.floor(Math.random() * 1000000000)
      .toString()
      .padStart(9, '0');

    // Ensure outbound directory exists
    const outboundDir = config.claims.outboundDir;
    if (!fs.existsSync(outboundDir)) {
      fs.mkdirSync(outboundDir, { recursive: true });
    }

    // Write to file
    const filename = `275_${x12ControlNumber}_${Date.now()}.edi`;
    const filePath = path.join(outboundDir, filename);
    fs.writeFileSync(filePath, x12_275, 'utf-8');

    console.log(`[ResponseService] Wrote 275 to ${filePath}`);

    // Update responses with control number and sent time
    const now = new Date();
    await Promise.all(
      responses.map((r) =>
        db
          .update(attachmentResponses)
          .set({ x12ControlNumber, sentAt: now })
          .where(eq(attachmentResponses.id, r.id)),
      ),
    );

    // Transition request to Sent
    const newState = transition(ClaimsAttachmentState.PENDING_SIGNATURE, ClaimsAttachmentState.SENT);
    await db
      .update(attachmentRequests)
      .set({ state: newState, updatedAt: now })
      .where(eq(attachmentRequests.id, requestId));

    console.log(`[ResponseService] Request ${requestId} transitioned to Sent`);

    return filePath;
  } catch (err) {
    console.error(`[ResponseService] Error sending response: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
