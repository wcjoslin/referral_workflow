/**
 * Distinct patient identities for the full-demo seed.
 *
 * WHY THIS EXISTS. `seed-full-demo.ts` builds all 100 referrals from five
 * C-CDA fixtures, and each fixture carries one hard-coded patient. So the
 * seeded database held 100 patients drawn from FIVE distinct
 * (surname, date-of-birth) pairs -- 78 of them "Chen / 1974-06-25".
 *
 * `findPotentialDuplicatePatients()` matches on surname and date of birth, so
 * it fired correctly on 95 of the 100 referrals. The detector was right; the
 * seed data was degenerate. The consequences all looked like product bugs:
 *
 *   - 95 of 100 workspaces sat in `Exception`, so the queue view's work-status
 *     tabs had nothing in In-Progress, Waiting-* or Resolved
 *   - `NEXT_ACTION_BY_WORK_STATUS.Exception` overrides the protocol state, so
 *     95 of 100 next actions read "Review and resolve the exception" and
 *     PRD-26's rule table never rendered
 *   - `awaited_by` was `us` 95 times and NEVER `party`, so PRD-26's
 *     ours-vs-theirs indicator had no contrast at all
 *   - the exception queue was 95 identical rows, which is noise, not a signal
 *   - every patient list read "Sarah Chen"
 *
 * THE FIXTURES ARE NOT EDITED. They are referenced by name in
 * `messageProcessor.test.ts`, the PRD-08 FHIR tests, `demoScenarios.ts` and
 * `demoLauncher.html`, where the fixed patient IS the point. This module
 * rewrites the C-CDA in memory on the way into the seed instead.
 */

/** One seeded patient. `dateOfBirth` is ISO; the C-CDA wants YYYYMMDD. */
export interface DemoPatientIdentity {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  mrn: string;
}

const FIRST_NAMES = [
  'Amara',
  'Benjamin',
  'Camila',
  'Darnell',
  'Elena',
  'Farid',
  'Grace',
  'Hassan',
  'Imani',
  'Jonas',
  'Kiara',
  'Lucas',
  'Maya',
  'Nikhil',
  'Olivia',
  'Pedro',
  'Quinn',
  'Rosa',
  'Samuel',
  'Tavia',
  'Umar',
  'Valeria',
  'Wesley',
  'Yara',
  'Zachary',
];

const LAST_NAMES = [
  'Abbott',
  'Bianchi',
  'Castellanos',
  'Delacroix',
  'Eriksen',
  'Fontaine',
  'Gallagher',
  'Haverford',
  'Ibarra',
  'Jankowski',
  'Kowalczyk',
  'Lindqvist',
  'Mwangi',
  'Nakamura',
  'Oyelaran',
  'Petrov',
  'Quintero',
  'Rasmussen',
  'Sandoval',
  'Thibodeaux',
  'Ueda',
  'Vasquez',
  'Whitlock',
  'Xiong',
  'Yamashita',
  'Zielinski',
];

/**
 * THE TWO POOL SIZES MUST STAY COPRIME -- 25 given names and 26 surnames.
 *
 * Both were 25 in the first version, so `index % 25` and `index * 9 % 25` had
 * the same period and the (given, surname) PAIR repeated every 25 indices:
 * 100 referrals rendered 28 distinct names, four "Amara Ibarra"s among them.
 * The surname/date-of-birth pairs were all distinct, so the duplicate detector
 * stayed quiet and nothing failed -- it just read as obviously fake data.
 *
 * With 25 and 26 the pair's period is lcm(25, 26) = 650, comfortably past the
 * 100 the seed uses. Changing either pool to share a factor with the other
 * silently reintroduces repeats; `demoPatients.test.ts` asserts 100 distinct
 * rendered names and fails if it happens.
 */

/**
 * A deliberate, SMALL set of genuine possible-duplicates, so the
 * duplicate-patient exception stays demonstrable now that the accidental 95
 * are gone. Maps a scenario index to the earlier index whose surname and date
 * of birth it reuses.
 *
 * Each pair shares a surname and a date of birth but carries a different given
 * name -- a nickname or a sibling, which is the genuinely ambiguous case that
 * warrants a human decision. That is the case PRD-28 is built around: flag it,
 * never merge it.
 */
const DELIBERATE_DUPLICATES: Record<number, number> = {
  17: 3,
  54: 22,
  88: 41,
};

/** Given names for the duplicate half of a pair: recognisably the same person. */
const DUPLICATE_GIVEN_NAMES: Record<number, string> = {
  17: 'Cami',
  54: 'Val',
  88: 'Sam',
};

/**
 * The identity for a scenario index.
 *
 * Deterministic: the same index always yields the same person, so a re-seed is
 * reproducible and a screenshot stays valid. The strides (9 and 7) are coprime
 * with the pool sizes, so surnames and dates of birth both cycle fully rather
 * than clumping.
 */
export function identityForIndex(index: number): DemoPatientIdentity {
  const duplicateOf = DELIBERATE_DUPLICATES[index];
  if (duplicateOf !== undefined) {
    const base = identityForIndex(duplicateOf);
    return {
      firstName: DUPLICATE_GIVEN_NAMES[index] ?? base.firstName,
      lastName: base.lastName,
      dateOfBirth: base.dateOfBirth,
      // A DIFFERENT medical record number: two records for one person is
      // exactly the condition being flagged. Sharing the MRN would make them
      // the same record and there would be nothing to decide.
      mrn: `MRN-${String(index).padStart(5, '0')}`,
    };
  }

  const firstName = FIRST_NAMES[index % FIRST_NAMES.length];
  const lastName = LAST_NAMES[(index * 9) % LAST_NAMES.length];

  // Spread across ~60 years so the age mix is plausible for a referral load.
  const year = 1947 + ((index * 7) % 60);
  const month = 1 + (index % 12);
  const day = 1 + ((index * 11) % 28);

  return {
    firstName,
    lastName,
    dateOfBirth: `${year}-${pad2(month)}-${pad2(day)}`,
    mrn: `MRN-${String(index).padStart(5, '0')}`,
  };
}

/** How many deliberate duplicate identities the pool contains. */
export const DELIBERATE_DUPLICATE_COUNT = Object.keys(DELIBERATE_DUPLICATES).length;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export class PatientIdentityRewriteError extends Error {
  constructor(what: string) {
    super(
      `[demo-patients] could not rewrite ${what} in the C-CDA. The fixture's ` +
        'recordTarget shape must have changed. Failing loudly rather than ' +
        'seeding 100 copies of one patient again.',
    );
    this.name = 'PatientIdentityRewriteError';
  }
}

/**
 * Replaces the patient identity inside a C-CDA's `recordTarget`.
 *
 * SCOPED TO `recordTarget` ON PURPOSE. Every seed fixture carries two `<given>`
 * and two `<family>` elements -- the second belongs to the document author, a
 * provider. A document-wide replace would rename the referring clinician to the
 * patient, which is the kind of wrong that looks plausible on screen.
 *
 * THROWS rather than returning the input unchanged. A silent no-op here is the
 * original bug: the seed would run green and every patient would be identical
 * again. Callers must not catch this.
 */
export function applyPatientIdentity(cda: string, identity: DemoPatientIdentity): string {
  const open = cda.indexOf('<recordTarget>');
  const close = cda.indexOf('</recordTarget>');
  if (open === -1 || close === -1 || close < open) throw new PatientIdentityRewriteError('recordTarget');

  const before = cda.slice(0, open);
  const after = cda.slice(close);
  let block = cda.slice(open, close);

  block = replaceOnce(block, /(<given>)[^<]*(<\/given>)/, `$1${identity.firstName}$2`, 'given name');
  block = replaceOnce(block, /(<family>)[^<]*(<\/family>)/, `$1${identity.lastName}$2`, 'family name');
  block = replaceOnce(
    block,
    /(<birthTime\s+value=")[0-9]*(")/,
    `$1${identity.dateOfBirth.replace(/-/g, '')}$2`,
    'birthTime',
  );
  block = replaceOnce(block, /(<id\s+root="[^"]*"\s+extension=")[^"]*(")/, `$1${identity.mrn}$2`, 'patient id');

  return before + block + after;
}

function replaceOnce(haystack: string, pattern: RegExp, replacement: string, what: string): string {
  if (!pattern.test(haystack)) throw new PatientIdentityRewriteError(what);
  return haystack.replace(pattern, replacement);
}
