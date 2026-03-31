/**
 * Demo Claims Data Seeder
 *
 * Creates sample X12 277 messages in the claims-inbox directory
 * for testing the full claims workflow end-to-end.
 *
 * Usage: npx ts-node scripts/seed-claims-demo.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../src/config';

// Ensure inbox directory exists
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Generate a sample X12 277 message.
 * Uses fixed ISA13 control number for simplicity.
 */
function generateX12_277(options: {
  controlNumber: string;
  claimNumber: string;
  payerName: string;
  payerCode: string;
  patientFirstName: string;
  patientLastName: string;
  patientDob: string;
  patientId: string;
  loincCodes: string[];
}): string {
  const { controlNumber, claimNumber, payerName, payerCode, patientFirstName, patientLastName, patientDob, patientId, loincCodes } = options;

  // Build STC segments for each LOINC code
  const stcSegments = loincCodes.map((loinc) => `STC~T~~~~${loinc}`).join('~\n');

  // X12 277 message (simplified format for parser)
  const message = `ISA~00~          ~01~          ~01~PROVIDER     ~01~${payerName.padEnd(15)}~260101~0000~00401~${controlNumber}~0~T~:
ST~275~001
BHT~0019~00~${generateControlNumber()}~20260101~0000~CH
NM1~PR~2~${payerName}~~~20~${payerCode}
NM1~IL~1~${patientLastName}~${patientFirstName}~M~~~MR~${patientId}
CLM~${claimNumber}
${stcSegments}
SE~9~001
GE~1~001
IEA~1~${controlNumber}`;

  return message;
}

/**
 * Generate a random 9-digit control number.
 */
function generateControlNumber(): string {
  return Math.floor(Math.random() * 1000000000)
    .toString()
    .padStart(9, '0');
}

/**
 * Main seeder.
 */
async function seed(): Promise<void> {
  const inboxDir = config.claims.watchDir;
  ensureDir(inboxDir);

  const demos = [
    {
      filename: 'demo-277-history-physical.edi',
      controlNumber: '000000001',
      claimNumber: 'CLM-2024-001',
      payerName: 'ACME Insurance',
      payerCode: 'ACME123',
      patientFirstName: 'John',
      patientLastName: 'Smith',
      patientDob: '19800515',
      patientId: '12345678',
      loincCodes: ['34117-2'], // History and Physical
    },
    {
      filename: 'demo-277-consultation.edi',
      controlNumber: '000000002',
      claimNumber: 'CLM-2024-002',
      payerName: 'Blue Cross',
      payerCode: 'BCBS456',
      patientFirstName: 'Jane',
      patientLastName: 'Doe',
      patientDob: '19750810',
      patientId: '87654321',
      loincCodes: ['11488-4'], // Consultation Note
    },
    {
      filename: 'demo-277-multiple-docs.edi',
      controlNumber: '000000003',
      claimNumber: 'CLM-2024-003',
      payerName: 'United Health',
      payerCode: 'UHC789',
      patientFirstName: 'Robert',
      patientLastName: 'Johnson',
      patientDob: '19900320',
      patientId: '11223344',
      loincCodes: ['34117-2', '11506-3', '18842-5'], // H&P, Progress Note, Discharge Summary
    },
    {
      filename: 'demo-277-outpatient.edi',
      controlNumber: '000000004',
      claimNumber: 'CLM-2024-004',
      payerName: 'Aetna',
      payerCode: 'AETNA999',
      patientFirstName: 'Sarah',
      patientLastName: 'Williams',
      patientDob: '19880706',
      patientId: '55667788',
      loincCodes: ['34101-6'], // Outpatient Consult Note
    },
  ];

  for (const demo of demos) {
    const x12 = generateX12_277(demo);
    const filePath = path.join(inboxDir, demo.filename);
    fs.writeFileSync(filePath, x12, 'utf-8');
    console.log(`✅ Created ${demo.filename}`);
  }

  console.log(`\n📋 ${demos.length} sample 277 messages created in ${inboxDir}`);
  console.log('💡 The EDI watcher will automatically process these files.');
  console.log('📍 Check the database for attachment_requests records.');
}

seed().catch((err) => {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
});
