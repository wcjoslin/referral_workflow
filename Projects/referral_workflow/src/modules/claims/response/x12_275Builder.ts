/**
 * X12N 275 (Patient Information) Response Message Builder
 *
 * Builds X12 EDI 275 messages with C-CDA attachments for claims responses.
 * Uses standard X12 segment formatting (pipe-delimited).
 */

export interface Build275Options {
  controlNumber: string; // ISA interchange control number for response
  senderCode: string; // Sending application code
  receiverCode: string; // Receiving application code
  payerName: string;
  payerIdentifier: string;
  providerName: string;
  providerIdentifier: string;
  subscriberName: string;
  documents: Array<{
    loincCode: string;
    ccdaXml: string; // Will be Base64 encoded
  }>;
}

/**
 * Build an X12 275 message as a string.
 * Returns the complete EDI message ready for transmission.
 */
export function buildX12_275(opts: Build275Options): string {
  const timestamp = getX12Timestamp();
  const segments: string[] = [];

  // ISA — Interchange Control Header
  segments.push(buildIsaSegment(opts.controlNumber, timestamp, opts.senderCode, opts.receiverCode));

  // GS — Functional Group Header
  const gsControlNumber = generateControlNumber();
  segments.push(buildGsSegment(gsControlNumber, timestamp, opts.senderCode, opts.receiverCode));

  // ST — Transaction Set Header
  const stControlNumber = generateControlNumber();
  segments.push(`ST~275~${stControlNumber}`);

  // BHT — Beginning of Hierarchical Transaction
  segments.push(`BHT~0019~00~${generateControlNumber()}~${timestamp.substring(0, 8)}~${timestamp.substring(8, 12)}~CH`);

  // NM1 — Information Receiver (Provider sending response)
  segments.push(`NM1~IL~1~${opts.providerName}~1~${opts.providerIdentifier}`);

  // NM1 — Payer (entity that requested the information)
  segments.push(`NM1~PR~2~${opts.payerName}~~~20~${opts.payerIdentifier}`);

  // For each document, add STC + BDS segments
  for (const doc of opts.documents) {
    // STC — Status, Type and Qualifier (with LOINC code)
    segments.push(`STC~T~~~~${doc.loincCode}`);

    // BDS — Binary Data Structure (Base64-encoded CCDA)
    const base64Data = Buffer.from(doc.ccdaXml, 'utf-8').toString('base64');
    segments.push(`BDS~B64~${base64Data.length}~${base64Data}`);
  }

  // SE — Transaction Set Trailer
  const seCount = segments.length + 1; // +1 for SE segment itself
  segments.push(`SE~${seCount}~${stControlNumber}`);

  // GE — Functional Group Trailer
  segments.push(`GE~1~${gsControlNumber}`);

  // IEA — Interchange Control Trailer
  segments.push(`IEA~1~${opts.controlNumber}`);

  // Join segments with segment terminator (~) and line breaks
  // X12 standard uses CR/LF as segment separator
  return segments.join('~\r\n') + '~\r\n';
}

/**
 * Build ISA segment (fixed-width format, then delimited fields).
 * ISA is special: first 16 chars are fixed-width, rest are delimited.
 */
function buildIsaSegment(
  controlNumber: string,
  timestamp: string,
  senderCode: string,
  receiverCode: string
): string {
  // ISA|qualifier|sender|receiver|etc~
  // ISA00 = Auth info qualifier (default 00)
  // ISA01 = Auth info (default spaces)
  // ISA02 = Security qualifier (default 01)
  // ISA03 = Security info (default spaces)
  // ISA04 = Interchange ID qualifier (default 01)
  // ISA05 = Interchange sender ID (15 chars, right-padded with spaces)
  // ISA06 = Interchange ID qualifier (default 01)
  // ISA07 = Interchange receiver ID (15 chars, right-padded with spaces)
  // ISA08 = Interchange date (YYMMDD)
  // ISA09 = Interchange time (HHMM)
  // ISA10 = Interchange control standards ID (default ^)
  // ISA11 = Interchange version ID (default 00401)
  // ISA12 = Interchange control number (9 digits, zero-padded)
  // ISA13 = Ack requested (default 0)
  // ISA14 = Usage indicator (default T)
  // ISA15 = Component separator (default :)

  const yy = timestamp.substring(0, 2);
  const mm = timestamp.substring(2, 4);
  const dd = timestamp.substring(4, 6);
  const hh = timestamp.substring(6, 8);
  const min = timestamp.substring(8, 10);
  const cn = controlNumber.padStart(9, '0');

  const senderPadded = senderCode.padEnd(15);
  const receiverPadded = receiverCode.padEnd(15);

  const isaPart1 = `ISA~00~          ~01~          ~01~${senderPadded}~01~${receiverPadded}~${yy}${mm}${dd}~${hh}${min}`;
  const isaPart2 = `^~00401~${cn}~0~T~:`;

  return isaPart1 + isaPart2;
}

/**
 * Build GS segment (Functional Group Header).
 */
function buildGsSegment(controlNumber: string, timestamp: string, senderCode: string, receiverCode: string): string {
  // GS ~ Code ~ Sender ~ Receiver ~ Date ~ Time ~ Control # ~ Responsible ~ Version
  const date = timestamp.substring(0, 8);
  const time = timestamp.substring(8, 12);
  return `GS~HB~${senderCode}~${receiverCode}~${date}~${time}~${controlNumber}~X~004010X098A1`;
}

/**
 * Get current timestamp in X12 format (YYYYMMDDHHmmss).
 */
function getX12Timestamp(): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString().slice(-2);
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  const dd = now.getDate().toString().padStart(2, '0');
  const hh = now.getHours().toString().padStart(2, '0');
  const min = now.getMinutes().toString().padStart(2, '0');
  const ss = now.getSeconds().toString().padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}${min}${ss}`;
}

/**
 * Generate a random 9-digit control number (zero-padded).
 */
function generateControlNumber(): string {
  return Math.floor(Math.random() * 1000000000).toString().padStart(9, '0');
}
