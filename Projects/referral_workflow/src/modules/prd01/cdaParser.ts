import BlueButton, {
  BBAllergyEntry,
  BBMedicationEntry,
  BBProblemEntry,
  BBResultEntry,
} from '@kno2/bluebutton';

export interface Patient {
  firstName: string;
  lastName: string;
  dateOfBirth: string; // ISO 8601: YYYY-MM-DD
}

export interface ReferralData {
  sourceMessageId: string;
  patient: Patient;
  reasonForReferral: string;
  isCdaValid: boolean;
  validationErrors: string[];
}

export interface ExtendedReferralData extends ReferralData {
  problems: string[];               // active problem names
  allergies: string[];              // allergen names
  medications: string[];            // medication names
  diagnosticResults: string[];      // result names
  missingOptionalSections: string[]; // optional sections that are empty
}

/**
 * Strips XML tags and normalizes whitespace from a BlueButton text field.
 * BlueButton 0.6.x wraps chief_complaint text in <text xmlns="...">...</text>.
 */
function stripXmlTags(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parses the DOB from BlueButton's ISO date string and formats as YYYY-MM-DD.
 * BlueButton returns dob as e.g. "1980-03-15T08:00:00.000Z".
 */
function formatDob(dob: string | null): string {
  if (!dob) return '';
  const date = new Date(dob);
  if (isNaN(date.getTime())) return '';
  return date.toISOString().split('T')[0];
}

/**
 * Parses a C-CDA XML string using @kno2/bluebutton and extracts the fields
 * required for PRD-01: patient name, DOB, and reason for referral.
 */
export function parseCda(cdaXml: string, sourceMessageId: string): ReferralData {
  const validationErrors: string[] = [];

  let doc;
  try {
    doc = BlueButton(cdaXml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      sourceMessageId,
      patient: { firstName: '', lastName: '', dateOfBirth: '' },
      reasonForReferral: '',
      isCdaValid: false,
      validationErrors: [`Failed to parse C-CDA document: ${message}`],
    };
  }

  // Demographics: flat object in BlueButton 0.6.x (not entries-based)
  const demo = doc.data.demographics;
  const firstName = demo?.name?.given?.[0] ?? '';
  const lastName = demo?.name?.family ?? '';
  const dateOfBirth = formatDob(demo?.dob ?? null);

  if (!firstName) validationErrors.push('Missing patient first name in demographics');
  if (!lastName) validationErrors.push('Missing patient last name in demographics');
  if (!dateOfBirth) validationErrors.push('Missing or invalid date of birth in demographics');

  // Reason for referral: try chief_complaint first, then chief_complaint_and_reason_for_visit
  const rawText =
    doc.data.chief_complaint?.text ??
    doc.data.chief_complaint_and_reason_for_visit?.text ??
    '';
  const reasonForReferral = stripXmlTags(rawText);
  if (!reasonForReferral) {
    validationErrors.push('Missing reason for referral (chief_complaint section is empty)');
  }

  return {
    sourceMessageId,
    patient: { firstName, lastName, dateOfBirth },
    reasonForReferral,
    isCdaValid: validationErrors.length === 0,
    validationErrors,
  };
}

/**
 * Parses a C-CDA XML string and extracts all sections needed for PRD-02 clinician review.
 * Builds on the base parseCda fields and adds problems, allergies, medications,
 * diagnostic results, and a list of missing optional sections.
 *
 * Required sections (absence triggers auto-decline):
 *   - Patient demographics (firstName, lastName, dateOfBirth)
 *   - Reason for referral (chief_complaint.text)
 *
 * Note: Payer information is not available in BlueButton 0.6.x and is not a gate.
 */
export function parseExtendedCda(cdaXml: string, sourceMessageId: string): ExtendedReferralData {
  const base = parseCda(cdaXml, sourceMessageId);

  // If base parse threw entirely, return minimal extended result
  if (!base.isCdaValid && base.patient.firstName === '' && base.validationErrors[0]?.startsWith('Failed to parse')) {
    return {
      ...base,
      problems: [],
      allergies: [],
      medications: [],
      diagnosticResults: [],
      missingOptionalSections: [],
    };
  }

  // Re-parse to extract extended sections
  const doc = BlueButton(cdaXml);
  const missingOptionalSections: string[] = [];

  const allergyEntries = (doc.data.allergies?.entries ?? []) as BBAllergyEntry[];
  const allergies = allergyEntries.map((e) => e.allergen?.name ?? '').filter(Boolean);
  if (allergyEntries.length === 0) missingOptionalSections.push('Allergies');

  const medEntries = (doc.data.medications?.entries ?? []) as BBMedicationEntry[];
  const medications = medEntries.map((e) => e.product?.name ?? '').filter(Boolean);
  if (medEntries.length === 0) missingOptionalSections.push('Medications');

  const problemEntries = (doc.data.problems?.entries ?? []) as BBProblemEntry[];
  const problems = problemEntries.map((e) => e.name ?? '').filter(Boolean);
  if (problemEntries.length === 0) missingOptionalSections.push('Problems');

  const resultEntries = (doc.data.results?.entries ?? []) as BBResultEntry[];
  const diagnosticResults = resultEntries.map((e) => e.name ?? '').filter(Boolean);
  if (resultEntries.length === 0) missingOptionalSections.push('Diagnostic Results');

  return {
    ...base,
    problems,
    allergies,
    medications,
    diagnosticResults,
    missingOptionalSections,
  };
}
