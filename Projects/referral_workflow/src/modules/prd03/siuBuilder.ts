/**
 * Builds an HL7 V2 SIU^S12 (Schedule Information Unsolicited — New Appointment) message.
 *
 * Same hand-built approach as rriBuilder.ts — no third-party HL7 library.
 *
 * Segments:
 *   MSH — message header
 *   SCH — schedule activity information
 *   PID — patient identification
 *   PRD — provider detail (referring provider, for reply correlation)
 */

export interface SiuOptions {
  messageControlId: string;   // MSH-10 — UUID
  appointmentId: string;      // SCH-1 — typically the referral ID
  startDatetime: string;      // HL7 DTM format: YYYYMMDDHHMMSS
  durationMinutes: number;    // e.g. 60
  appointmentType: string;    // e.g. "Cardiology Consult"
  locationName: string;
  scheduledProvider: string;
  patientId: string;          // internal patient ID
  patientFirstName: string;
  patientLastName: string;
  patientDob: string;         // YYYYMMDD
  referrerAddress: string;    // Direct address of the referring provider
  sendingFacility: string;    // Direct address of the sending facility
}

/** Formats a Date as HL7 DTM (YYYYMMDDHHmmss). */
function hl7DateTime(date: Date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-T:.Z]/g, '')
    .slice(0, 14);
}

/** Escapes pipe characters in field values. */
function esc(value: string): string {
  return value.replace(/\|/g, '\\F\\').replace(/\r/g, '').replace(/\n/g, '');
}

/**
 * Converts an ISO 8601 date string (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS) to HL7 DTM.
 */
export function isoToHl7(iso: string): string {
  return iso.replace(/[-T:.Z]/g, '').slice(0, 14).padEnd(14, '0');
}

/** Builds and returns an SIU^S12 HL7 V2 message string. */
export function buildSiu(opts: SiuOptions): string {
  const ts = hl7DateTime();

  // MSH — Message Header
  const msh = [
    'MSH',
    '^~\\&',
    'ReferralWorkflow',
    esc(opts.sendingFacility),
    'ReferralWorkflow',
    esc(opts.referrerAddress),
    ts,
    '',
    'SIU^S12^SIU_S12',
    esc(opts.messageControlId),
    'P',
    '2.5.1',
  ].join('|');

  // SCH — Schedule Activity Information
  // SCH-1: Placer Appointment ID
  // SCH-7: Appointment Reason (we use appointment type)
  // SCH-11: Appointment Duration + units
  // SCH-16: Filler Contact Person (scheduled provider)
  // SCH-25: Filler Status Code
  const sch = [
    'SCH',
    esc(opts.appointmentId),             // SCH-1  Placer Appointment ID
    '',                                   // SCH-2  Filler Appointment ID
    '',                                   // SCH-3  Occurrence Number
    '',                                   // SCH-4  Placer Group Number
    '',                                   // SCH-5  Schedule ID
    '',                                   // SCH-6  Event Reason
    esc(opts.appointmentType),            // SCH-7  Appointment Reason
    '',                                   // SCH-8  Appointment Type
    '',                                   // SCH-9  Appointment Duration
    '',                                   // SCH-10 Appointment Duration Units
    `${opts.durationMinutes}^min`,        // SCH-11 Appointment Timing Quantity
    '',                                   // SCH-12 Placer Contact Person
    '',                                   // SCH-13 Placer Contact Phone
    '',                                   // SCH-14 Placer Contact Address
    '',                                   // SCH-15 Placer Contact Location
    esc(opts.scheduledProvider),          // SCH-16 Filler Contact Person
    '',                                   // SCH-17 Filler Contact Phone
    '',                                   // SCH-18 Filler Contact Address
    '',                                   // SCH-19 Filler Contact Location
    '',                                   // SCH-20 Entered By Person
    '',                                   // SCH-21 Entered By Phone
    '',                                   // SCH-22 Entered By Location
    '',                                   // SCH-23 Parent Placer Appointment ID
    '',                                   // SCH-24 Parent Filler Appointment ID
    'Booked',                             // SCH-25 Filler Status Code
    esc(opts.startDatetime),              // SCH-26 Placer Order Number (start time)
    esc(opts.locationName),               // SCH-27 Filler Order Number (location)
  ].join('|');

  // PID — Patient Identification
  const pid = [
    'PID',
    '',                                           // PID-1  Set ID
    '',                                           // PID-2  Patient ID (external)
    esc(opts.patientId),                          // PID-3  Patient Identifier List
    '',                                           // PID-4  Alternate Patient ID
    `${esc(opts.patientLastName)}^${esc(opts.patientFirstName)}`, // PID-5  Patient Name
    '',                                           // PID-6  Mother's Maiden Name
    esc(opts.patientDob),                         // PID-7  Date/Time of Birth
  ].join('|');

  // PRD — Provider Detail (referring provider for reply correlation)
  const prd = [
    'PRD',
    'RP',
    '',
    '',
    '',
    '',
    esc(opts.referrerAddress),
  ].join('|');

  return [msh, sch, pid, prd].join('\r\n');
}
