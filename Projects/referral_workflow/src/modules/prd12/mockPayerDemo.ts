/**
 * PRD-12 Mock Payer Demo
 *
 * Demonstrates three prior authorization scenarios:
 *   A: Immediate approval (service code ending 0-5)
 *   B: Immediate denial (service code ending 6-7)
 *   C: Pend then approve via subscription (service code ending 8-9)
 *
 * Can be run standalone via ts-node or integrated with the demo launcher.
 */

import { db } from '../../db';
import { patients } from '../../db/schema';
import { submitPriorAuth, getStatus } from './priorAuthService';

async function ensureDemoPatient(): Promise<number> {
  // Check if demo patient exists
  const existing = await db.select().from(patients);
  const demoPatient = existing.find((p) => p.firstName === 'PA-Demo' && p.lastName === 'Patient');
  if (demoPatient) return demoPatient.id;

  const [inserted] = await db
    .insert(patients)
    .values({
      firstName: 'PA-Demo',
      lastName: 'Patient',
      dateOfBirth: '1985-03-15',
    })
    .returning();
  return inserted.id;
}

export async function runPriorAuthDemo(): Promise<void> {
  console.log('\n=== PRD-12: Prior Authorization Demo ===\n');

  const patientId = await ensureDemoPatient();

  // Scenario A: Immediate Approval
  console.log('--- Scenario A: Immediate Approval (code 99213) ---');
  const approveResult = await submitPriorAuth({
    patientId,
    insurerName: 'Aetna',
    insurerId: '60054',
    subscriberId: 'MEM-DEMO-001',
    serviceCode: '99213',
    serviceDisplay: 'Office visit, established patient',
    providerNpi: '1234567890',
    providerName: 'Dr. Smith',
    diagnoses: [{ code: 'M54.5', display: 'Low back pain' }],
  });
  console.log(`  Result: ${approveResult.state} | Auth #: ${approveResult.authNumber ?? 'N/A'}`);

  // Scenario B: Immediate Denial
  console.log('\n--- Scenario B: Immediate Denial (code 27447) ---');
  const denyResult = await submitPriorAuth({
    patientId,
    insurerName: 'UnitedHealthcare',
    insurerId: '87726',
    subscriberId: 'MEM-DEMO-002',
    serviceCode: '27447',
    serviceDisplay: 'Total knee replacement',
    providerNpi: '1234567890',
    providerName: 'Dr. Smith',
    diagnoses: [{ code: 'M17.11', display: 'Primary osteoarthritis, right knee' }],
  });
  console.log(`  Result: ${denyResult.state} | Reason: ${denyResult.denialReason ?? 'N/A'}`);

  // Scenario C: Pend then Approve via Subscription
  console.log('\n--- Scenario C: Pend → Approve via subscription (code 70559) ---');
  const pendResult = await submitPriorAuth({
    patientId,
    insurerName: 'Cigna',
    insurerId: '62308',
    subscriberId: 'MEM-DEMO-003',
    serviceCode: '70559',
    serviceDisplay: 'MRI brain with and without contrast',
    providerNpi: '1234567890',
    providerName: 'Dr. Smith',
    diagnoses: [{ code: 'G43.909', display: 'Migraine, unspecified' }],
  });
  console.log(`  Initial: ${pendResult.state} | ${pendResult.message ?? ''}`);

  // Wait for subscription notification to resolve
  console.log('  Waiting for payer decision...');
  await new Promise<void>((resolve) => {
    const check = (): void => {
      void getStatus(pendResult.id).then((status) => {
        if (status.state !== 'Pended') {
          console.log(`  Resolved: ${status.state} | Auth #: ${status.authNumber ?? 'N/A'}`);
          resolve();
        } else {
          setTimeout(check, 1000);
        }
      });
    };
    setTimeout(check, 2000);
  });

  console.log('\n=== Demo Complete ===\n');
}

/**
 * Launch a prior-auth demo scenario from the demo launcher.
 * Seeds a patient and returns the PA request ID.
 */
export async function launchPriorAuth(): Promise<number> {
  const patientId = await ensureDemoPatient();

  // Use a "pend" code so the demo is interactive — clinician sees the status update
  const result = await submitPriorAuth({
    patientId,
    insurerName: 'Aetna',
    insurerId: '60054',
    subscriberId: 'MEM-DEMO-PA',
    serviceCode: '99213',
    serviceDisplay: 'Office visit, established patient',
    providerNpi: '1234567890',
    providerName: 'Dr. Smith',
    diagnoses: [{ code: 'M54.5', display: 'Low back pain' }],
  });

  console.log(`[Demo] Prior auth scenario launched — PA Request #${result.id} (${result.state})`);
  return result.id;
}
