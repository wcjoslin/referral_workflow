/**
 * Parses HL7 V2 ORU^R01 (Observation Result - Unsolicited) messages.
 *
 * Extracts the message control ID (MSH-10), patient ID (PID-3),
 * and clinical note text from OBX-5 observation value fields.
 */

export interface OruData {
  messageControlId: string; // MSH-10
  patientId: string;        // PID-3
  noteText: string;         // concatenated OBX-5 values
}

/**
 * Splits an HL7 V2 message into segments keyed by segment ID.
 */
function getSegments(raw: string): Map<string, string[][]> {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const map = new Map<string, string[][]>();
  for (const line of lines) {
    const fields = line.split('|');
    const segId = fields[0];
    if (!map.has(segId)) map.set(segId, []);
    map.get(segId)!.push(fields);
  }
  return map;
}

/**
 * Parses an ORU^R01 message string and returns structured data.
 * Throws if required segments (MSH, OBX) are missing.
 */
export function parseOru(raw: string): OruData {
  const segments = getSegments(raw);

  // MSH segment
  const mshRows = segments.get('MSH');
  if (!mshRows || mshRows.length === 0) {
    throw new Error('ORU message missing MSH segment');
  }
  const msh = mshRows[0];
  // MSH-10 is field index 9 (MSH-1 is the separator itself, so fields shift by 1)
  const messageControlId = msh[9] ?? '';

  // PID segment
  const pidRows = segments.get('PID');
  const pid = pidRows?.[0];
  // PID-3 is field index 3
  const patientId = pid?.[3]?.split('^')[0] ?? '';

  // OBX segments — concatenate OBX-5 (observation value, field index 5)
  const obxRows = segments.get('OBX') ?? [];
  if (obxRows.length === 0) {
    throw new Error('ORU message missing OBX segments');
  }
  const noteText = obxRows
    .map((row) => row[5] ?? '')
    .filter(Boolean)
    .join('\n');

  return { messageControlId, patientId, noteText };
}
