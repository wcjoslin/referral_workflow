/**
 * X12N 277 (Health Care Claim Request for Additional Information) Parser
 *
 * Parses X12 EDI 277 messages to extract payer request information.
 * Uses simple line-by-line parsing (no external library) for straightforward field extraction.
 */

export interface Parsed277Request {
  controlNumber: string; // ISA13 — interchange control number
  payerName: string; // From NM1 loop with qualifier 'PR' (payer)
  payerIdentifier: string; // Payer ID from NM1
  claimNumber?: string; // From CLM or REF segment
  subscriberName: string; // Patient name from NM1 subscriber level
  subscriberId?: string; // Member/subscriber ID
  subscriberDob?: string; // ISO 8601 format YYYY-MM-DD
  requestedLoincCodes: string[]; // LOINC codes from STC segments
  rawX12: string; // Original X12 content for audit trail
}

/**
 * Parse an X12 277 EDI message string.
 * Expects X12 with default delimiters: segment=\n, field=~, element=*
 * Throws ParseError if the message is malformed.
 */
export function parseX12_277(ediText: string): Parsed277Request {
  // X12 uses CR/LF as segment terminators; some systems use just LF
  const lines = ediText.split(/\r?\n/).filter((line) => line.trim());

  let controlNumber = '';
  let payerName = '';
  let payerIdentifier = '';
  let claimNumber = '';
  let subscriberName = '';
  let subscriberId = '';
  let subscriberDob = '';
  const requestedLoincCodes: Set<string> = new Set();

  for (const line of lines) {
    // Parse segment (field[0] is segment type, field[1]+ are elements)
    // ISA segment is special — contains ^ which we need to treat as part of a field value
    let fields: string[];
    if (line.startsWith('ISA')) {
      // For ISA, split more carefully to preserve the ^ in field values
      fields = line.split('~').map((f) => f.trim());
    } else {
      fields = line.split('~');
    }
    if (fields.length === 0) continue;

    const segmentType = fields[0];

    // ISA — Interchange Control Header
    if (segmentType === 'ISA') {
      // ISA13 is the interchange control number (13th element, index 12 in 0-indexed)
      // Format: ISA~field1~field2~...~field13~field14~field15~field16
      if (fields.length > 12) {
        controlNumber = fields[12];
      }
    }

    // NM1 — Entity Identification
    if (segmentType === 'NM1') {
      const entityQualifier = fields[1];
      // NM1~entityQual~lastName~firstName~etc
      const lastName = fields[3] || '';
      const firstName = fields[4] || '';

      // Payer (PR)
      if (entityQualifier === 'PR') {
        payerName = `${lastName} ${firstName}`.trim();
        payerIdentifier = lastName; // Use as ID
      }

      // Subscriber/Patient
      if (entityQualifier === 'IL' || entityQualifier === 'QC') {
        subscriberName = `${firstName} ${lastName}`.trim();
        subscriberId = fields[9] || '';
        subscriberDob = fields[8] ? formatDob(fields[8]) : '';
      }
    }

    // CLM — Claim Identification
    if (segmentType === 'CLM') {
      claimNumber = fields[1] || '';
    }

    // REF — Reference Identification
    if (segmentType === 'REF' && !claimNumber) {
      const refQualifier = fields[1];
      if (refQualifier === '0F' || refQualifier === 'D9') {
        claimNumber = fields[2] || '';
      }
    }

    // STC — Status, Type and Qualifier (contains LOINC codes)
    if (segmentType === 'STC') {
      // Check fields 2-6 for LOINC codes (LOINC can be at index 5 in STC~T~~~~34117-2)
      for (let i = 2; i <= 6 && i < fields.length; i++) {
        const code = fields[i];
        if (code && isValidLoinc(code)) {
          requestedLoincCodes.add(code);
        }
      }
    }
  }

  // Validate required fields
  if (!controlNumber) {
    throw new ParseError('Missing ISA13 (control number) in X12 277');
  }
  if (!payerName) {
    throw new ParseError('Missing payer name (NM1 PR) in X12 277');
  }
  if (!subscriberName) {
    throw new ParseError('Missing subscriber/patient name in X12 277');
  }
  if (requestedLoincCodes.size === 0) {
    throw new ParseError('No LOINC codes found in X12 277 STC segments');
  }

  return {
    controlNumber,
    payerName,
    payerIdentifier,
    claimNumber: claimNumber || undefined,
    subscriberName,
    subscriberId: subscriberId || undefined,
    subscriberDob: subscriberDob || undefined,
    requestedLoincCodes: Array.from(requestedLoincCodes),
    rawX12: ediText,
  };
}

/**
 * Check if a string looks like a LOINC code (XXXXX-X format).
 */
function isValidLoinc(code: string): boolean {
  // LOINC codes are typically 5-6 digits, hyphen, 1-2 digits
  // e.g., 34117-2, 11488-4
  return /^\d{4,5}-\d{1,2}$/.test(code);
}

/**
 * Convert YYYYMMDD to ISO 8601 YYYY-MM-DD format.
 */
function formatDob(dobYyyymmdd: string): string {
  if (dobYyyymmdd.length !== 8 || !/^\d{8}$/.test(dobYyyymmdd)) {
    return dobYyyymmdd; // Return as-is if not valid
  }
  const yyyy = dobYyyymmdd.substring(0, 4);
  const mm = dobYyyymmdd.substring(4, 6);
  const dd = dobYyyymmdd.substring(6, 8);
  return `${yyyy}-${mm}-${dd}`;
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X12ParseError';
  }
}
