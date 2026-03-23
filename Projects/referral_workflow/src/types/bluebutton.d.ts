/**
 * Type declarations for @kno2/bluebutton 0.6.x
 * The library ships no TypeScript types — these are hand-authored from the actual runtime output.
 *
 * Note: demographics is a FLAT object (not entries-based).
 * Other sections (allergies, medications, problems, results) use entries arrays.
 * Payers section does not exist in 0.6.x.
 */

declare module '@kno2/bluebutton' {
  export interface BBName {
    given: string[];
    family: string | null;
    prefix?: string | null;
  }

  // Demographics is a flat object, not an entries array
  export interface BBDemographics {
    name: BBName;
    dob: string | null;   // ISO date string e.g. "1980-03-15T08:00:00.000Z"
    gender: string | null;
    marital_status: string | null;
    address: {
      street: string[];
      city: string | null;
      state: string | null;
      zip: string | null;
      country: string | null;
    };
    phone: { home: string | null; work: string | null; mobile: string | null };
    email: string | null;
    language: string | null;
    race: string | null;
    ethnicity: string | null;
    religion: string | null;
  }

  export interface BBAllergyEntry {
    allergen?: { name: string; code?: string };
    reaction?: Array<{ name: string }>;
    severity?: { name: string };
    status?: { name: string };
  }

  export interface BBMedicationEntry {
    product?: { name: string; code?: string };
    dose?: { value: number; unit: string };
    route?: { name: string };
    status?: string;
  }

  export interface BBProblemEntry {
    name?: string;
    code?: { code: string; system: string };
    status?: { name: string };
    onset?: { date: Date | null };
  }

  export interface BBResultEntry {
    name?: string;
    value?: number | string;
    unit?: string;
    date?: { date: Date | null };
  }

  export interface BBSection<T = unknown> {
    displayName?: string;
    templateId?: string | null;
    text?: string | null;
    entries: T[];
  }

  export interface BBData {
    demographics: BBDemographics;
    chief_complaint: { text: string | null };                 // text may be XML-wrapped
    chief_complaint_and_reason_for_visit?: { text: string | null };
    allergies?: BBSection<BBAllergyEntry>;
    medications?: BBSection<BBMedicationEntry>;
    problems?: BBSection<BBProblemEntry>;
    results?: BBSection<BBResultEntry>;
    [key: string]: unknown;
  }

  export interface BlueButtonDocument {
    type: string;
    data: BBData;
    source: unknown;
  }

  function BlueButton(xml: string): BlueButtonDocument;
  export = BlueButton;
}
