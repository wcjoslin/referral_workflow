/**
 * Mock referrer that auto-ACKs all outbound messages.
 *
 * Fires non-blocking after each outbound message is sent (RRI, SIU,
 * InterimUpdate, ConsultNote). Simulates the referring provider's
 * system sending back an HL7 ACK.
 *
 * In production this would be replaced by parsing inbound ACK emails
 * from the Direct inbox.
 */

import { randomUUID } from 'crypto';
import { processAck } from './ackService';

/**
 * Called (non-blocking) after an outbound message is sent.
 * Generates an ACK and processes it through the ack service.
 */
export async function autoAck(messageControlId: string): Promise<void> {
  const ackControlId = randomUUID();

  await processAck({
    ackCode: 'AA',
    acknowledgedControlId: messageControlId,
    messageControlId: ackControlId,
  });

  console.log(
    `[MockReferrer] Auto-ACK sent for message ${messageControlId.slice(0, 8)}...`,
  );
}
