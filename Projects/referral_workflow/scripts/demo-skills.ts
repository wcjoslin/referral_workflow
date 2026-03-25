/**
 * PRD-09 Skills Demo Script
 *
 * Demonstrates two skill-evaluation scenarios:
 *   Case A — Out-of-network payer (Humana) → auto-decline via payer-network-check
 *   Case B — In-network payer (Aetna) + diagnoses → auto-accept via in-network-accept
 *
 * Run: npx ts-node -r ./scripts/node-polyfill.js scripts/demo-skills.ts
 */

import { db } from '../src/db';
import { patients, referrals } from '../src/db/schema';
import { evaluateSkills } from '../src/modules/prd09/skillEvaluator';
import { executeSkillAction } from '../src/modules/prd09/skillActions';
import { eq } from 'drizzle-orm';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeClinicalData(payer: string, problems: string[]) {
  return JSON.stringify({
    payer,
    problems: problems.map((p) => ({ name: p, source: 'ccda' })),
    medications: [],
    allergies: [],
    diagnosticResults: [],
    missingOptionalSections: [],
    fhirPatientId: null,
    fhirItemsAdded: 0,
  });
}

async function seedReferral(opts: {
  firstName: string;
  lastName: string;
  payer: string;
  problems: string[];
  reason: string;
}): Promise<number> {
  const [patient] = await db
    .insert(patients)
    .values({ firstName: opts.firstName, lastName: opts.lastName, dateOfBirth: '1974-06-25' })
    .returning({ id: patients.id });

  const [referral] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      sourceMessageId: `demo-${Date.now()}-${Math.random()}`,
      referrerAddress: 'demo-referrer@example.direct',
      reasonForReferral: opts.reason,
      state: 'Acknowledged',
      clinicalData: makeClinicalData(opts.payer, opts.problems),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: referrals.id });

  return referral.id;
}

async function checkFinalState(referralId: number): Promise<string> {
  const [r] = await db.select({ state: referrals.state }).from(referrals).where(eq(referrals.id, referralId));
  return r?.state ?? 'unknown';
}

// ── Demo ─────────────────────────────────────────────────────────────────────

async function runDemo() {
  console.log('\n' + '='.repeat(60));
  console.log('  PRD-09 Agent Skills Demo');
  console.log('='.repeat(60));

  // ── Case A: Out-of-network payer → auto-decline ───────────────────────────
  console.log('\n📋 CASE A: Out-of-network payer (Humana)');
  console.log('-'.repeat(60));

  const referralA = await seedReferral({
    firstName: 'Alice',
    lastName: 'TestPatient',
    payer: 'Humana',
    problems: ['E11.9 Type 2 diabetes mellitus without complications', 'Z79.4 Long-term use of insulin'],
    reason: 'Diabetic nephropathy evaluation — referral to nephrology',
  });

  console.log(`Referral #${referralA} seeded — payer: Humana (not in approved list)`);
  console.log('Running post-intake skill evaluation...\n');

  const resultA = await evaluateSkills('post-intake', referralA);

  for (const r of resultA.results) {
    const icon = r.matched ? '✓ MATCHED' : '✗ no match';
    console.log(`  [${r.skillName}] ${icon} (confidence: ${(r.confidence * 100).toFixed(0)}%)`);
    console.log(`    → ${r.explanation}`);
  }

  if (resultA.winningAction) {
    const w = resultA.winningAction;
    console.log(`\n  Winning action: ${w.actionType.toUpperCase()} via "${w.skillName}"`);
    if (!w.isTestMode) {
      await executeSkillAction(w, referralA);
    }
  }

  const stateA = await checkFinalState(referralA);
  console.log(`\n  Final state: ${stateA}`);

  // ── Case B: In-network payer + diagnoses → auto-accept ────────────────────
  console.log('\n\n📋 CASE B: In-network payer (Aetna) + diagnoses present');
  console.log('-'.repeat(60));

  const referralB = await seedReferral({
    firstName: 'Bob',
    lastName: 'TestPatient',
    payer: 'Aetna',
    problems: ['I10 Essential (primary) hypertension', 'Z87.39 Personal history of other endocrine disorders'],
    reason: 'Hypertension management — referral to cardiology',
  });

  console.log(`Referral #${referralB} seeded — payer: Aetna (in approved list)`);
  console.log('Running post-intake skill evaluation...\n');

  const resultB = await evaluateSkills('post-intake', referralB);

  for (const r of resultB.results) {
    const icon = r.matched ? '✓ MATCHED' : '✗ no match';
    console.log(`  [${r.skillName}] ${icon} (confidence: ${(r.confidence * 100).toFixed(0)}%)`);
    console.log(`    → ${r.explanation}`);
  }

  if (resultB.winningAction) {
    const w = resultB.winningAction;
    console.log(`\n  Winning action: ${w.actionType.toUpperCase()} via "${w.skillName}"`);
    if (!w.isTestMode) {
      await executeSkillAction(w, referralB);
    }
  }

  const stateB = await checkFinalState(referralB);
  console.log(`\n  Final state: ${stateB}`);

  console.log('\n' + '='.repeat(60));
  console.log('  Demo complete');
  console.log('='.repeat(60) + '\n');

  process.exit(0);
}

runDemo().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
