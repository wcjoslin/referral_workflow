/**
 * Parses HL7 V2 ACK messages.
 *
 * Extracts the acknowledged Message Control ID from the MSA segment
 * and the ACK code (AA = accepted, AE = error, AR = rejected).
 */

export interface AckData {
  ackCode: string;            // MSA-1: AA, AE, AR
  acknowledgedControlId: string; // MSA-2: the Message Control ID being acknowledged
  messageControlId: string;   // MSH-10: this ACK message's own control ID
}

/**
 * Parses an ACK message and returns the acknowledged control ID.
 * Throws if required segments (MSH, MSA) are missing.
 */
export function parseAck(raw: string): AckData {
  const lines = raw.split(/\r?\n/).filter(Boolean);

  let mshFields: string[] | undefined;
  let msaFields: string[] | undefined;

  for (const line of lines) {
    const fields = line.split('|');
    if (fields[0] === 'MSH') mshFields = fields;
    if (fields[0] === 'MSA') msaFields = fields;
  }

  if (!mshFields) throw new Error('ACK message missing MSH segment');
  if (!msaFields) throw new Error('ACK message missing MSA segment');

  // MSH-10 is field index 9 (MSH-1 is the separator)
  const messageControlId = mshFields[9] ?? '';

  // MSA-1 = ack code, MSA-2 = acknowledged message control ID
  const ackCode = msaFields[1] ?? '';
  const acknowledgedControlId = msaFields[2] ?? '';

  if (!acknowledgedControlId) {
    throw new Error('ACK message MSA segment missing acknowledged Message Control ID (MSA-2)');
  }

  return { ackCode, acknowledgedControlId, messageControlId };
}
