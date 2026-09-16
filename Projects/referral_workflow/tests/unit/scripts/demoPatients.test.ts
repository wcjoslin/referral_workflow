/**
 * Guards the full-demo seed's patient identity pool.
 *
 * The bug this exists to prevent is not hypothetical: the seed shipped 100
 * patients drawn from five distinct (surname, date-of-birth) pairs, which fired
 * 95 correct duplicate-patient exceptions and left PRD-26's rule table and
 * ours-vs-theirs indicator with no data to render. Nothing failed -- it looked
 * exactly like the features working.
 *
 * `applyPatientIdentity` is a string rewrite over XML, so its failure mode is a
 * silent no-op that puts every patient back to "Sarah Chen". These tests run it
 * against the REAL fixtures for that reason.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  applyPatientIdentity,
  DELIBERATE_DUPLICATE_COUNT,
  identityForIndex,
  PatientIdentityRewriteError,
  type DemoPatientIdentity,
} from '../../../scripts/demo-patients';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures');

/** Every fixture the full-demo seed ingests. */
const SEED_FIXTURES = [
  'demo-full-workflow.xml',
  'demo-consult.xml',
  'demo-incomplete-info.xml',
  'demo-no-show.xml',
  'demo-payer-rejection.xml',
];

/** The seed runs scenario indices 1..100. */
const INDICES = Array.from({ length: 100 }, (_, i) => i + 1);

const patientBlock = (cda: string): string =>
  cda.slice(cda.indexOf('<recordTarget>'), cda.indexOf('</recordTarget>'));

describe('identityForIndex', () => {
  it('is deterministic — a re-seed reproduces the same people', () => {
    for (const i of [1, 7, 42, 99]) {
      expect(identityForIndex(i)).toEqual(identityForIndex(i));
    }
  });

  it('yields exactly DELIBERATE_DUPLICATE_COUNT colliding (surname, dob) pairs across the seed', () => {
    const counts = new Map<string, number>();
    for (const i of INDICES) {
      const id = identityForIndex(i);
      const key = `${id.lastName}|${id.dateOfBirth}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    // One extra record per deliberate pair. Before this pool the same
    // measurement was 95.
    const extras = [...counts.values()].reduce((sum, n) => sum + (n - 1), 0);
    expect(extras).toBe(DELIBERATE_DUPLICATE_COUNT);
  });

  it('gives every patient a unique medical record number, duplicates included', () => {
    const mrns = INDICES.map((i) => identityForIndex(i).mrn);
    expect(new Set(mrns).size).toBe(INDICES.length);
  });

  it('makes each deliberate duplicate a genuine judgement call, not a data glitch', () => {
    // Same surname and date of birth -- which is what the detector matches on
    // -- but a different given name and a different record number. That is the
    // ambiguous case a human is meant to resolve.
    const pairs = INDICES.map((i) => identityForIndex(i)).reduce((acc, id) => {
      const key = `${id.lastName}|${id.dateOfBirth}`;
      (acc[key] ??= []).push(id);
      return acc;
    }, {} as Record<string, DemoPatientIdentity[]>);

    const collisions = Object.values(pairs).filter((group) => group.length > 1);
    expect(collisions).toHaveLength(DELIBERATE_DUPLICATE_COUNT);

    for (const group of collisions) {
      expect(new Set(group.map((g) => g.firstName)).size).toBe(group.length);
      expect(new Set(group.map((g) => g.mrn)).size).toBe(group.length);
    }
  });

  it('produces valid, plausibly spread dates of birth', () => {
    const years = new Set<number>();
    for (const i of INDICES) {
      const dob = identityForIndex(i).dateOfBirth;
      expect(dob).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const [year, month, day] = dob.split('-').map(Number);
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
      expect(day).toBeGreaterThanOrEqual(1);
      // Capped at 28 so no index can generate 31 February.
      expect(day).toBeLessThanOrEqual(28);
      years.add(year);
    }
    expect(years.size).toBeGreaterThan(20);
  });
});

describe('applyPatientIdentity', () => {
  const identity: DemoPatientIdentity = {
    firstName: 'Tobias',
    lastName: 'Ferreira',
    dateOfBirth: '1963-11-04',
    mrn: 'MRN-42424',
  };

  it.each(SEED_FIXTURES)('rewrites the patient identity in %s', (fixture) => {
    const original = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf-8');
    const rewritten = applyPatientIdentity(original, identity);

    const block = patientBlock(rewritten);
    expect(block).toContain('<given>Tobias</given>');
    expect(block).toContain('<family>Ferreira</family>');
    expect(block).toContain('<birthTime value="19631104"');
    expect(block).toContain('extension="MRN-42424"');
  });

  it.each(SEED_FIXTURES)('leaves the document author in %s alone', (fixture) => {
    const original = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf-8');
    const rewritten = applyPatientIdentity(original, identity);

    // Each fixture carries two <given>/<family> pairs: the patient and the
    // authoring provider. A document-wide replace would rename the referring
    // clinician to the patient -- wrong in a way that looks plausible.
    const authorBefore = original.slice(original.indexOf('</recordTarget>'));
    const authorAfter = rewritten.slice(rewritten.indexOf('</recordTarget>'));
    expect(authorAfter).toBe(authorBefore);
    expect(authorAfter).not.toContain('Ferreira');
  });

  it.each(SEED_FIXTURES)('actually changes %s — never a silent no-op', (fixture) => {
    const original = fs.readFileSync(path.join(FIXTURES_DIR, fixture), 'utf-8');
    expect(applyPatientIdentity(original, identity)).not.toBe(original);
  });

  it('gives every seeded index a distinct patient name in the rendered C-CDA', () => {
    const original = fs.readFileSync(path.join(FIXTURES_DIR, 'demo-full-workflow.xml'), 'utf-8');
    const names = INDICES.map((i) => {
      const block = patientBlock(applyPatientIdentity(original, identityForIndex(i)));
      const given = /<given>([^<]*)<\/given>/.exec(block)?.[1];
      const family = /<family>([^<]*)<\/family>/.exec(block)?.[1];
      return `${given} ${family}`;
    });

    // 78 of the 100 seeded referrals used to render "Sarah Chen".
    expect(names.filter((n) => n === 'Sarah Chen')).toHaveLength(0);
    expect(new Set(names).size).toBe(INDICES.length);
  });

  it('throws when there is no recordTarget rather than returning the input', () => {
    expect(() => applyPatientIdentity('<ClinicalDocument/>', identity)).toThrow(
      PatientIdentityRewriteError,
    );
  });

  it('throws when the patient block loses its name element', () => {
    const noName = '<recordTarget><patientRole><patient/></patientRole></recordTarget>';
    expect(() => applyPatientIdentity(noName, identity)).toThrow(PatientIdentityRewriteError);
  });

  it('throws when the fixture shape changes mid-block', () => {
    // A name but no birthTime: the rewrite is partial, which would seed a
    // distinct name against a shared date of birth and re-trip the detector.
    const noDob =
      '<recordTarget><patientRole><id root="x" extension="A"/>' +
      '<patient><name><given>A</given><family>B</family></name></patient>' +
      '</patientRole></recordTarget>';
    expect(() => applyPatientIdentity(noDob, identity)).toThrow(PatientIdentityRewriteError);
  });
});
