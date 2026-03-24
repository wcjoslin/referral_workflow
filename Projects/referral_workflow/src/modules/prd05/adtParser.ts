/**
 * Parses an HL7 V2 ADT^A04 (Register a Patient / Patient Arrived) message.
 *
 * Extracts the message control ID, patient ID, and appointment/visit ID
 * (which maps to the referral ID in our system).
 *
 * Segments used:
 *   MSH — message header (control ID, message type validation)
 *   PID — patient identification
 *   PV1 — patient visit (visit number = referral ID)
 */

export interface AdtData {
  messageControlId: string;  // MSH-10
  patientId: string;         // PID-3
  appointmentId: string;     // PV1-19 (visit number → referral ID)
}

export class AdtParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdtParseError';
  }
}

/**
 * Parses a pipe-delimited ADT^A04 message string.
 * Segments may be separated by \r\n, \r, or \n.
 */
export function parseAdt(raw: string): AdtData {
  const segments = raw.split(/\r?\n|\r/).filter((s) => s.length > 0);

  // MSH segment
  const msh = segments.find((s) => s.startsWith('MSH'));
  if (!msh) throw new AdtParseError('Missing MSH segment');

  const mshFields = msh.split('|');

  // MSH-9: Message Type — must be ADT^A04
  const messageType = mshFields[8] ?? '';
  if (!messageType.startsWith('ADT^A04')) {
    throw new AdtParseError(`Expected ADT^A04, got ${messageType}`);
  }

  // MSH-10: Message Control ID
  const messageControlId = mshFields[9] ?? '';
  if (!messageControlId) throw new AdtParseError('Missing MSH-10 (Message Control ID)');

  // PID segment
  const pid = segments.find((s) => s.startsWith('PID'));
  if (!pid) throw new AdtParseError('Missing PID segment');

  const pidFields = pid.split('|');
  const patientId = pidFields[3] ?? '';
  if (!patientId) throw new AdtParseError('Missing PID-3 (Patient ID)');

  // PV1 segment
  const pv1 = segments.find((s) => s.startsWith('PV1'));
  if (!pv1) throw new AdtParseError('Missing PV1 segment');

  const pv1Fields = pv1.split('|');
  const appointmentId = pv1Fields[19] ?? '';
  if (!appointmentId) throw new AdtParseError('Missing PV1-19 (Visit Number / Referral ID)');

  return { messageControlId, patientId, appointmentId };
}
