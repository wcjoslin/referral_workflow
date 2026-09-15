/**
 * Builds HL7 V2 ACK messages — the inverse of `ackParser.ts`.
 *
 * WHY THIS EXISTS, AND WHY IT IS HERE RATHER THAN IN THE GATEWAY.
 *
 * PRD-29 forbids new message-building code in the protocol gateway: the
 * gateway's job is to choose a builder and route its output. But its
 * `acknowledge-outcome` assertion needs an ACK, and nothing in this codebase
 * built one — `ackParser.ts` only parses, and `mockReferrer.ts` fakes an ACK by
 * calling the ack service with a control id rather than producing a message.
 *
 * So the code goes in PRD-06's module, which owns ACKs, rather than in the
 * gateway. The justification is specific rather than a general licence to write
 * builders: an ACK is two segments, `parseAck()` already fixes exactly the field
 * positions this must produce, and the two are **round-trip tested against each
 * other** — `parseAck(buildAck(x))` returns `x`. That is a stronger correctness
 * argument than a builder validated only against a sample message.
 *
 * Arguably PRD-06 should have shipped this; it is recorded as a gap there.
 */

export interface AckOptions {
  /** This ACK's own control id (MSH-10). */
  messageControlId: string;
  /** The control id being acknowledged (MSA-2). */
  acknowledgedControlId: string;
  /** MSA-1. AA = accepted, AE = error, AR = rejected. */
  ackCode: 'AA' | 'AE' | 'AR';
  sendingFacility: string;
  receivingFacility: string;
  /** Optional MSA-3 text. Kept short: MSA-3 is a human note, not a payload. */
  textMessage?: string;
}

/** Formats a Date as HL7 DTM (YYYYMMDDHHmmss), matching the other builders. */
function hl7DateTime(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Escapes HL7 delimiters in a free-text field.
 *
 * Only MSA-3 carries free text here, but an unescaped `|` in it would shift
 * every following field — and `parseAck()` reads by position, so the round-trip
 * test would catch that as a mismatch rather than as a crash.
 */
function esc(value: string): string {
  return value
    .replace(/\\/g, '\\E\\')
    .replace(/\|/g, '\\F\\')
    .replace(/\^/g, '\\S\\')
    .replace(/&/g, '\\T\\')
    .replace(/~/g, '\\R\\')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * Builds an HL7 V2.5.1 ACK.
 *
 * Field positions are dictated by `parseAck()`: MSH-10 is index 9 counting the
 * segment name as 0, MSA-1 is index 1 and MSA-2 index 2. The `^~\&` encoding
 * characters occupy MSH-2, which is why MSH-3 starts at index 2.
 */
export function buildAck(opts: AckOptions): string {
  const ts = hl7DateTime();

  const msh = [
    'MSH',
    '^~\\&',
    'CONCORD', // MSH-3 sending application
    esc(opts.sendingFacility), // MSH-4
    'REFERRAL', // MSH-5 receiving application
    esc(opts.receivingFacility), // MSH-6
    ts, // MSH-7
    '', // MSH-8 security
    'ACK', // MSH-9 message type
    opts.messageControlId, // MSH-10 — read by parseAck
    'P', // MSH-11 processing id
    '2.5.1', // MSH-12 version
  ].join('|');

  const msa = [
    'MSA',
    opts.ackCode, // MSA-1 — read by parseAck
    opts.acknowledgedControlId, // MSA-2 — read by parseAck
    ...(opts.textMessage ? [esc(opts.textMessage)] : []),
  ].join('|');

  // `\r\n`, matching buildRri() and buildSiu(). The HL7 standard specifies a
  // bare `\r`, and the first version of this builder used one — the round-trip
  // test then failed, because parseAck() splits on /\r?\n/ and a lone `\r`
  // leaves it one undivided line with no MSA segment. Consistency with this
  // codebase's own builders and its own parser wins over standards purism: a
  // message nothing here can read is not more correct.
  return [msh, msa].join('\r\n');
}
