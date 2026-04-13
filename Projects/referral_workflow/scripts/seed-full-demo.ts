/**
 * Full Demo Seed Script
 *
 * Runs 20 varied scenarios through the actual message processing + referral
 * service layer to produce rich, realistic analytics data.
 *
 * Key design decisions:
 * - Uses processInboundMessage + ingestReferral for ingestion (real events emitted)
 * - Uses direct DB transitions post-Acknowledged (avoids SMTP/Gemini/HTTP race conditions)
 * - Inserts prior auth records directly (avoids mock payer HTTP dependency)
 * - Spreads timestamps 90 days back after each scenario
 * - Idempotent: clears 'full-demo-seed-*' prefixed data on each run
 *
 * Usage: npm run seed:full-demo
 */

import * as fs from 'fs';
import * as path from 'path';
import { eq, sql } from 'drizzle-orm';
import { processInboundMessage } from '../src/modules/prd01/messageProcessor';
import { ingestReferral } from '../src/modules/prd02/referralService';
import { emitEvent } from '../src/modules/analytics/eventService';
import { db } from '../src/db';
import { referrals, priorAuthRequests, priorAuthResponses } from '../src/db/schema';
import { ReferralState } from '../src/state/referralStateMachine';
import { PriorAuthState } from '../src/state/priorAuthStateMachine';

const FIXTURES_DIR = path.resolve(__dirname, '../tests/fixtures');

// ── Constants ─────────────────────────────────────────────────────────────────

const CONSULT_NOTES: Record<string, string> = {
  Cardiology:
    'Patient evaluated for chest pain and dyspnea. ECG showed ST changes. Recommend cardiac catheterization and beta-blocker therapy. Follow-up in 4 weeks.',
  Neurology:
    'Patient presents with recurrent headaches and visual disturbances. MRI brain unremarkable. Diagnosed with migraine with aura. Initiated topiramate 25mg.',
  Orthopedics:
    'Knee pain evaluation complete. X-ray shows moderate osteoarthritis. Conservative management with PT recommended. Surgical consult if no improvement in 6 weeks.',
  Oncology:
    'Biopsy results reviewed. Stage II finding confirmed. Oncology team recommends adjuvant chemotherapy protocol. Patient counselled and consented.',
  Gastroenterology:
    'Colonoscopy performed. Two polyps removed, sent for pathology. Recommend repeat colonoscopy in 3 years. Patient tolerating well.',
};

const LOCATIONS: Record<string, string> = {
  Cardiology: 'Heart Center — Suite 300',
  Neurology: 'Neuroscience Clinic — Suite 210',
  Orthopedics: 'Orthopedic Center — Suite 150',
  Oncology: 'Cancer Care Center — Suite 400',
  Gastroenterology: 'GI Clinic — Suite 120',
};

const PROVIDER_NAMES: Record<string, string> = {
  'dr-chen': 'Dr. Emily Chen, MD',
  'dr-patel': 'Dr. Raj Patel, MD',
  'dr-rodriguez': 'Dr. Carlos Rodriguez, MD',
  'dr-kim': 'Dr. Sarah Kim, MD',
};

const PA_SERVICE_CODES: Record<string, { code: string; display: string }> = {
  Cardiology: { code: '93306', display: 'Echocardiography' },
  Neurology: { code: '70553', display: 'MRI Brain with Contrast' },
  Orthopedics: { code: '27447', display: 'Total Knee Arthroplasty' },
  Oncology: { code: '96413', display: 'Chemotherapy Administration' },
  Gastroenterology: { code: '45378', display: 'Diagnostic Colonoscopy' },
};

const DEPT_PAYERS: Record<string, { name: string; id: string }> = {
  Cardiology: { name: 'Aetna', id: 'aetna' },
  Neurology: { name: 'Blue Cross Blue Shield', id: 'bcbs' },
  Orthopedics: { name: 'United Health', id: 'united' },
  Oncology: { name: 'Aetna', id: 'aetna' },
  Gastroenterology: { name: 'Blue Cross Blue Shield', id: 'bcbs' },
};

// ── Scenario Definitions ──────────────────────────────────────────────────────

type PaOutcome = 'approved' | 'denied' | 'pended';

interface Scenario {
  index: number;
  fixture: string;
  dept: string;
  clinicianId: string;
  endState:
    | 'Closed-Confirmed'
    | 'Encounter'
    | 'No-Show'
    | 'Declined'
    | 'Pending-Information'
    | 'Scheduled';
  pa?: PaOutcome;
  declineReason?: string;
  /** Override the From address in the raw email (used to cluster pending-info by referrer) */
  referrerAddress?: string;
  /** Days back from today to backdate this referral's created_at */
  daysBack: number;
}

const SCENARIOS: Scenario[] = [
  // ── Original 20 scenarios ─────────────────────────────────────────────────
  // Happy paths — Closed-Confirmed
  { index: 1,  fixture: 'demo-full-workflow.xml',   dept: 'Cardiology',       clinicianId: 'dr-chen',      endState: 'Closed-Confirmed', daysBack: 85 },
  { index: 2,  fixture: 'demo-full-workflow.xml',   dept: 'Neurology',        clinicianId: 'dr-patel',     endState: 'Closed-Confirmed', daysBack: 78 },
  { index: 3,  fixture: 'demo-full-workflow.xml',   dept: 'Orthopedics',      clinicianId: 'dr-rodriguez', endState: 'Closed-Confirmed', pa: 'approved', daysBack: 70 },
  { index: 4,  fixture: 'demo-full-workflow.xml',   dept: 'Oncology',         clinicianId: 'dr-chen',      endState: 'Closed-Confirmed', pa: 'approved', daysBack: 65 },
  { index: 5,  fixture: 'demo-full-workflow.xml',   dept: 'Gastroenterology', clinicianId: 'dr-kim',       endState: 'Closed-Confirmed', daysBack: 60 },
  { index: 6,  fixture: 'demo-full-workflow.xml',   dept: 'Cardiology',       clinicianId: 'dr-patel',     endState: 'Closed-Confirmed', daysBack: 55 },
  { index: 7,  fixture: 'demo-full-workflow.xml',   dept: 'Orthopedics',      clinicianId: 'dr-chen',      endState: 'Closed-Confirmed', daysBack: 50 },
  { index: 8,  fixture: 'demo-full-workflow.xml',   dept: 'Neurology',        clinicianId: 'dr-rodriguez', endState: 'Closed-Confirmed', daysBack: 45 },
  // Stalled at Encounter
  { index: 9,  fixture: 'demo-full-workflow.xml',   dept: 'Cardiology',       clinicianId: 'dr-kim',       endState: 'Encounter',        daysBack: 14 },
  // No-shows
  { index: 10, fixture: 'demo-no-show.xml',         dept: 'Cardiology',       clinicianId: 'dr-rodriguez', endState: 'No-Show',          daysBack: 20 },
  { index: 11, fixture: 'demo-no-show.xml',         dept: 'Neurology',        clinicianId: 'dr-chen',      endState: 'No-Show',          daysBack: 18 },
  // Consult resolved
  { index: 12, fixture: 'demo-consult.xml',         dept: 'Gastroenterology', clinicianId: 'dr-patel',     endState: 'Closed-Confirmed', daysBack: 40 },
  // Declines
  { index: 13, fixture: 'demo-full-workflow.xml',   dept: 'Oncology',         clinicianId: 'dr-rodriguez', endState: 'Declined', declineReason: 'Patient does not meet criteria',          daysBack: 35 },
  { index: 14, fixture: 'demo-full-workflow.xml',   dept: 'Neurology',        clinicianId: 'dr-kim',       endState: 'Declined', declineReason: 'Insufficient clinical information',        daysBack: 30 },
  { index: 15, fixture: 'demo-full-workflow.xml',   dept: 'Orthopedics',      clinicianId: 'dr-patel',     endState: 'Declined', declineReason: 'Capacity unavailable',                     daysBack: 28 },
  // Payer rejection (auto-decline)
  { index: 16, fixture: 'demo-payer-rejection.xml', dept: 'Cardiology',       clinicianId: 'dr-chen',      endState: 'Declined', declineReason: 'Out-of-network payer: auto-declined by payer-network-check skill', daysBack: 25 },
  // Pending-Information
  { index: 17, fixture: 'demo-incomplete-info.xml', dept: 'Gastroenterology', clinicianId: 'dr-rodriguez', endState: 'Pending-Information', daysBack: 10 },
  // PA Denied / Pended — stalled at Scheduled
  { index: 18, fixture: 'demo-full-workflow.xml',   dept: 'Orthopedics',      clinicianId: 'dr-kim',       endState: 'Scheduled', pa: 'denied',  daysBack: 8 },
  { index: 19, fixture: 'demo-full-workflow.xml',   dept: 'Neurology',        clinicianId: 'dr-chen',      endState: 'Scheduled', pa: 'pended',  daysBack: 5 },
  // PA Approved — full happy path
  { index: 20, fixture: 'demo-full-workflow.xml',   dept: 'Cardiology',       clinicianId: 'dr-patel',     endState: 'Closed-Confirmed', pa: 'approved', daysBack: 3 },

  // ── Denial cluster A: dr-kim × Neurology (9 referrals) ───────────────────
  // Agent should surface: "Insufficient clinical information" pattern for this clinician×dept
  { index: 21, fixture: 'demo-full-workflow.xml', dept: 'Neurology', clinicianId: 'dr-kim', endState: 'Declined', declineReason: 'Insufficient clinical information', daysBack: 82 },
  { index: 22, fixture: 'demo-full-workflow.xml', dept: 'Neurology', clinicianId: 'dr-kim', endState: 'Declined', declineReason: 'Insufficient clinical information', daysBack: 75 },
  { index: 23, fixture: 'demo-full-workflow.xml', dept: 'Neurology', clinicianId: 'dr-kim', endState: 'Declined', declineReason: 'Insufficient clinical information', daysBack: 68 },
  { index: 24, fixture: 'demo-full-workflow.xml', dept: 'Neurology', clinicianId: 'dr-kim', endState: 'Declined', declineReason: 'Insufficient clinical information', daysBack: 62 },
  { index: 25, fixture: 'demo-full-workflow.xml', dept: 'Neurology', clinicianId: 'dr-kim', endState: 'Declined', declineReason: 'Insufficient clinical information', daysBack: 55 },
  { index: 26, fixture: 'demo-full-workflow.xml', dept: 'Neurology', clinicianId: 'dr-kim', endState: 'Declined', declineReason: 'Insufficient clinical information', daysBack: 47 },
  { index: 27, fixture: 'demo-full-workflow.xml', dept: 'Neurology', clinicianId: 'dr-kim', endState: 'Declined', declineReason: 'Insufficient clinical information', daysBack: 40 },
  { index: 28, fixture: 'demo-full-workflow.xml', dept: 'Neurology', clinicianId: 'dr-kim', endState: 'Declined', declineReason: 'Insufficient clinical information', daysBack: 32 },
  { index: 29, fixture: 'demo-full-workflow.xml', dept: 'Neurology', clinicianId: 'dr-kim', endState: 'Declined', declineReason: 'Insufficient clinical information', daysBack: 22 },

  // ── Denial cluster B: dr-rodriguez × Oncology (7 referrals) ─────────────
  // Agent should surface: "Patient does not meet criteria" pattern
  { index: 30, fixture: 'demo-full-workflow.xml', dept: 'Oncology', clinicianId: 'dr-rodriguez', endState: 'Declined', declineReason: 'Patient does not meet criteria', daysBack: 79 },
  { index: 31, fixture: 'demo-full-workflow.xml', dept: 'Oncology', clinicianId: 'dr-rodriguez', endState: 'Declined', declineReason: 'Patient does not meet criteria', daysBack: 71 },
  { index: 32, fixture: 'demo-full-workflow.xml', dept: 'Oncology', clinicianId: 'dr-rodriguez', endState: 'Declined', declineReason: 'Patient does not meet criteria', daysBack: 63 },
  { index: 33, fixture: 'demo-full-workflow.xml', dept: 'Oncology', clinicianId: 'dr-rodriguez', endState: 'Declined', declineReason: 'Patient does not meet criteria', daysBack: 56 },
  { index: 34, fixture: 'demo-full-workflow.xml', dept: 'Oncology', clinicianId: 'dr-rodriguez', endState: 'Declined', declineReason: 'Patient does not meet criteria', daysBack: 48 },
  { index: 35, fixture: 'demo-full-workflow.xml', dept: 'Oncology', clinicianId: 'dr-rodriguez', endState: 'Declined', declineReason: 'Patient does not meet criteria', daysBack: 38 },
  { index: 36, fixture: 'demo-full-workflow.xml', dept: 'Oncology', clinicianId: 'dr-rodriguez', endState: 'Declined', declineReason: 'Patient does not meet criteria', daysBack: 26 },

  // ── PA denial pattern: Cardiology × Aetna × 93306 (11 referrals) ─────────
  // All Cardiology referrals → DEPT_PAYERS['Cardiology'] = Aetna, PA_SERVICE_CODES['Cardiology'] = 93306
  // Agent should surface: Aetna denying echocardiography PAs repeatedly
  { index: 37, fixture: 'demo-full-workflow.xml', dept: 'Cardiology', clinicianId: 'dr-chen',      endState: 'Scheduled', pa: 'denied', daysBack: 88 },
  { index: 38, fixture: 'demo-full-workflow.xml', dept: 'Cardiology', clinicianId: 'dr-patel',     endState: 'Scheduled', pa: 'denied', daysBack: 83 },
  { index: 39, fixture: 'demo-full-workflow.xml', dept: 'Cardiology', clinicianId: 'dr-rodriguez', endState: 'Scheduled', pa: 'denied', daysBack: 77 },
  { index: 40, fixture: 'demo-full-workflow.xml', dept: 'Cardiology', clinicianId: 'dr-kim',       endState: 'Scheduled', pa: 'denied', daysBack: 72 },
  { index: 41, fixture: 'demo-full-workflow.xml', dept: 'Cardiology', clinicianId: 'dr-chen',      endState: 'Scheduled', pa: 'denied', daysBack: 66 },
  { index: 42, fixture: 'demo-full-workflow.xml', dept: 'Cardiology', clinicianId: 'dr-patel',     endState: 'Scheduled', pa: 'denied', daysBack: 61 },
  { index: 43, fixture: 'demo-full-workflow.xml', dept: 'Cardiology', clinicianId: 'dr-rodriguez', endState: 'Scheduled', pa: 'denied', daysBack: 54 },
  { index: 44, fixture: 'demo-full-workflow.xml', dept: 'Cardiology', clinicianId: 'dr-kim',       endState: 'Scheduled', pa: 'denied', daysBack: 49 },
  { index: 45, fixture: 'demo-full-workflow.xml', dept: 'Cardiology', clinicianId: 'dr-chen',      endState: 'Scheduled', pa: 'denied', daysBack: 43 },
  { index: 46, fixture: 'demo-full-workflow.xml', dept: 'Cardiology', clinicianId: 'dr-patel',     endState: 'Scheduled', pa: 'denied', daysBack: 37 },
  { index: 47, fixture: 'demo-full-workflow.xml', dept: 'Cardiology', clinicianId: 'dr-rodriguez', endState: 'Scheduled', pa: 'denied', daysBack: 28 },

  // ── No-show cluster: Cardiology (10 referrals) ────────────────────────────
  // Agent should surface: Cardiology has a disproportionate no-show rate
  { index: 48, fixture: 'demo-no-show.xml', dept: 'Cardiology', clinicianId: 'dr-chen',      endState: 'No-Show', daysBack: 86 },
  { index: 49, fixture: 'demo-no-show.xml', dept: 'Cardiology', clinicianId: 'dr-patel',     endState: 'No-Show', daysBack: 80 },
  { index: 50, fixture: 'demo-no-show.xml', dept: 'Cardiology', clinicianId: 'dr-rodriguez', endState: 'No-Show', daysBack: 74 },
  { index: 51, fixture: 'demo-no-show.xml', dept: 'Cardiology', clinicianId: 'dr-kim',       endState: 'No-Show', daysBack: 67 },
  { index: 52, fixture: 'demo-no-show.xml', dept: 'Cardiology', clinicianId: 'dr-chen',      endState: 'No-Show', daysBack: 60 },
  { index: 53, fixture: 'demo-no-show.xml', dept: 'Cardiology', clinicianId: 'dr-patel',     endState: 'No-Show', daysBack: 53 },
  { index: 54, fixture: 'demo-no-show.xml', dept: 'Cardiology', clinicianId: 'dr-rodriguez', endState: 'No-Show', daysBack: 46 },
  { index: 55, fixture: 'demo-no-show.xml', dept: 'Cardiology', clinicianId: 'dr-kim',       endState: 'No-Show', daysBack: 38 },
  { index: 56, fixture: 'demo-no-show.xml', dept: 'Cardiology', clinicianId: 'dr-chen',      endState: 'No-Show', daysBack: 30 },
  { index: 57, fixture: 'demo-no-show.xml', dept: 'Cardiology', clinicianId: 'dr-patel',     endState: 'No-Show', daysBack: 20 },

  // ── Pending-info cluster: same referrer address (6 referrals) ─────────────
  // Agent should surface: dr-incomplete@referring.direct consistently sends sparse referrals
  { index: 58, fixture: 'demo-incomplete-info.xml', dept: 'Gastroenterology', clinicianId: 'dr-rodriguez', endState: 'Pending-Information', referrerAddress: 'dr-incomplete@referring.direct', daysBack: 58 },
  { index: 59, fixture: 'demo-incomplete-info.xml', dept: 'Gastroenterology', clinicianId: 'dr-rodriguez', endState: 'Pending-Information', referrerAddress: 'dr-incomplete@referring.direct', daysBack: 51 },
  { index: 60, fixture: 'demo-incomplete-info.xml', dept: 'Neurology',        clinicianId: 'dr-patel',     endState: 'Pending-Information', referrerAddress: 'dr-incomplete@referring.direct', daysBack: 44 },
  { index: 61, fixture: 'demo-incomplete-info.xml', dept: 'Cardiology',       clinicianId: 'dr-chen',      endState: 'Pending-Information', referrerAddress: 'dr-incomplete@referring.direct', daysBack: 37 },
  { index: 62, fixture: 'demo-incomplete-info.xml', dept: 'Gastroenterology', clinicianId: 'dr-kim',       endState: 'Pending-Information', referrerAddress: 'dr-incomplete@referring.direct', daysBack: 28 },
  { index: 63, fixture: 'demo-incomplete-info.xml', dept: 'Oncology',         clinicianId: 'dr-rodriguez', endState: 'Pending-Information', referrerAddress: 'dr-incomplete@referring.direct', daysBack: 19 },

  // ── Happy-path baseline: varied depts + clinicians (20 referrals) ─────────
  { index: 64, fixture: 'demo-full-workflow.xml', dept: 'Orthopedics',      clinicianId: 'dr-patel',     endState: 'Closed-Confirmed', daysBack: 87 },
  { index: 65, fixture: 'demo-full-workflow.xml', dept: 'Neurology',        clinicianId: 'dr-chen',      endState: 'Closed-Confirmed', daysBack: 84 },
  { index: 66, fixture: 'demo-full-workflow.xml', dept: 'Gastroenterology', clinicianId: 'dr-kim',       endState: 'Closed-Confirmed', daysBack: 81 },
  { index: 67, fixture: 'demo-full-workflow.xml', dept: 'Cardiology',       clinicianId: 'dr-rodriguez', endState: 'Closed-Confirmed', daysBack: 77 },
  { index: 68, fixture: 'demo-full-workflow.xml', dept: 'Oncology',         clinicianId: 'dr-patel',     endState: 'Closed-Confirmed', daysBack: 74 },
  { index: 69, fixture: 'demo-full-workflow.xml', dept: 'Neurology',        clinicianId: 'dr-rodriguez', endState: 'Closed-Confirmed', daysBack: 71 },
  { index: 70, fixture: 'demo-full-workflow.xml', dept: 'Orthopedics',      clinicianId: 'dr-kim',       endState: 'Closed-Confirmed', daysBack: 67 },
  { index: 71, fixture: 'demo-full-workflow.xml', dept: 'Gastroenterology', clinicianId: 'dr-chen',      endState: 'Closed-Confirmed', daysBack: 64 },
  { index: 72, fixture: 'demo-full-workflow.xml', dept: 'Cardiology',       clinicianId: 'dr-kim',       endState: 'Closed-Confirmed', pa: 'approved', daysBack: 61 },
  { index: 73, fixture: 'demo-full-workflow.xml', dept: 'Oncology',         clinicianId: 'dr-chen',      endState: 'Closed-Confirmed', daysBack: 57 },
  { index: 74, fixture: 'demo-full-workflow.xml', dept: 'Neurology',        clinicianId: 'dr-patel',     endState: 'Closed-Confirmed', daysBack: 54 },
  { index: 75, fixture: 'demo-full-workflow.xml', dept: 'Orthopedics',      clinicianId: 'dr-rodriguez', endState: 'Closed-Confirmed', pa: 'approved', daysBack: 50 },
  { index: 76, fixture: 'demo-consult.xml',       dept: 'Gastroenterology', clinicianId: 'dr-patel',     endState: 'Closed-Confirmed', daysBack: 46 },
  { index: 77, fixture: 'demo-full-workflow.xml', dept: 'Cardiology',       clinicianId: 'dr-chen',      endState: 'Closed-Confirmed', daysBack: 43 },
  { index: 78, fixture: 'demo-full-workflow.xml', dept: 'Oncology',         clinicianId: 'dr-kim',       endState: 'Closed-Confirmed', daysBack: 39 },
  { index: 79, fixture: 'demo-full-workflow.xml', dept: 'Neurology',        clinicianId: 'dr-rodriguez', endState: 'Closed-Confirmed', daysBack: 35 },
  { index: 80, fixture: 'demo-full-workflow.xml', dept: 'Orthopedics',      clinicianId: 'dr-chen',      endState: 'Closed-Confirmed', daysBack: 31 },
  { index: 81, fixture: 'demo-full-workflow.xml', dept: 'Gastroenterology', clinicianId: 'dr-kim',       endState: 'Closed-Confirmed', daysBack: 27 },
  { index: 82, fixture: 'demo-full-workflow.xml', dept: 'Cardiology',       clinicianId: 'dr-patel',     endState: 'Closed-Confirmed', pa: 'approved', daysBack: 23 },
  { index: 83, fixture: 'demo-full-workflow.xml', dept: 'Oncology',         clinicianId: 'dr-rodriguez', endState: 'Closed-Confirmed', daysBack: 16 },

  // ── In-progress: Scheduled (10 referrals) ────────────────────────────────
  { index: 84, fixture: 'demo-full-workflow.xml', dept: 'Cardiology',       clinicianId: 'dr-chen',      endState: 'Scheduled', daysBack: 29 },
  { index: 85, fixture: 'demo-full-workflow.xml', dept: 'Neurology',        clinicianId: 'dr-kim',       endState: 'Scheduled', daysBack: 26 },
  { index: 86, fixture: 'demo-full-workflow.xml', dept: 'Orthopedics',      clinicianId: 'dr-patel',     endState: 'Scheduled', daysBack: 23 },
  { index: 87, fixture: 'demo-full-workflow.xml', dept: 'Gastroenterology', clinicianId: 'dr-chen',      endState: 'Scheduled', daysBack: 20 },
  { index: 88, fixture: 'demo-full-workflow.xml', dept: 'Oncology',         clinicianId: 'dr-patel',     endState: 'Scheduled', daysBack: 17 },
  { index: 89, fixture: 'demo-full-workflow.xml', dept: 'Cardiology',       clinicianId: 'dr-rodriguez', endState: 'Scheduled', daysBack: 14 },
  { index: 90, fixture: 'demo-full-workflow.xml', dept: 'Neurology',        clinicianId: 'dr-chen',      endState: 'Scheduled', daysBack: 11 },
  { index: 91, fixture: 'demo-full-workflow.xml', dept: 'Orthopedics',      clinicianId: 'dr-kim',       endState: 'Scheduled', daysBack: 8 },
  { index: 92, fixture: 'demo-full-workflow.xml', dept: 'Gastroenterology', clinicianId: 'dr-rodriguez', endState: 'Scheduled', daysBack: 5 },
  { index: 93, fixture: 'demo-full-workflow.xml', dept: 'Oncology',         clinicianId: 'dr-kim',       endState: 'Scheduled', pa: 'pended', daysBack: 2 },

  // ── Stalled: Encounter (7 referrals) ─────────────────────────────────────
  { index: 94,  fixture: 'demo-full-workflow.xml', dept: 'Cardiology',       clinicianId: 'dr-patel',     endState: 'Encounter', daysBack: 19 },
  { index: 95,  fixture: 'demo-full-workflow.xml', dept: 'Neurology',        clinicianId: 'dr-rodriguez', endState: 'Encounter', daysBack: 16 },
  { index: 96,  fixture: 'demo-full-workflow.xml', dept: 'Orthopedics',      clinicianId: 'dr-chen',      endState: 'Encounter', daysBack: 13 },
  { index: 97,  fixture: 'demo-full-workflow.xml', dept: 'Gastroenterology', clinicianId: 'dr-patel',     endState: 'Encounter', daysBack: 10 },
  { index: 98,  fixture: 'demo-full-workflow.xml', dept: 'Oncology',         clinicianId: 'dr-chen',      endState: 'Encounter', daysBack: 7 },
  { index: 99,  fixture: 'demo-full-workflow.xml', dept: 'Cardiology',       clinicianId: 'dr-kim',       endState: 'Encounter', daysBack: 5 },
  { index: 100, fixture: 'demo-full-workflow.xml', dept: 'Neurology',        clinicianId: 'dr-patel',     endState: 'Encounter', daysBack: 3 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function readFixture(filename: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8');
}

function buildRawEmail(cdaContent: string, suffix: string, fromAddress = 'referrer@hospital.direct'): string {
  const boundary = 'SEED_BOUNDARY_001';
  const CRLF = '\r\n';
  const headers = [
    `From: Demo Referrer <${fromAddress}>`,
    'To: receiving@specialist.direct',
    'Subject: Referral — Demo Patient',
    `Message-ID: <demo-full-demo-seed-${suffix}@hospital.direct>`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
  ].join(CRLF);

  const textPart = [`--${boundary}`, 'Content-Type: text/plain', '', 'Referral attached.'].join(CRLF);

  const cdaPart = [
    `--${boundary}`,
    'Content-Type: application/xml',
    'Content-Disposition: attachment; filename="referral.xml"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(cdaContent).toString('base64'),
  ].join(CRLF);

  return headers + [textPart, cdaPart, `--${boundary}--`].join(CRLF);
}

async function ingestFixture(fixtureName: string, suffix: string, fromAddress?: string): Promise<number> {
  const cda = readFixture(fixtureName);
  const rawEmail = buildRawEmail(cda, suffix, fromAddress);
  const processed = await processInboundMessage(rawEmail);
  const referralId = await ingestReferral(processed);
  if (referralId === null) {
    throw new Error(`[Seed] ingestReferral returned null for ${fixtureName} (suffix=${suffix})`);
  }
  return referralId;
}

async function setDepartment(referralId: number, dept: string): Promise<void> {
  await db
    .update(referrals)
    .set({ routingDepartment: dept, updatedAt: new Date() })
    .where(eq(referrals.id, referralId));
}

async function acceptReferral(referralId: number, clinicianId: string): Promise<void> {
  await db
    .update(referrals)
    .set({ state: ReferralState.ACCEPTED, clinicianId, updatedAt: new Date() })
    .where(eq(referrals.id, referralId));
  await emitEvent({
    eventType: 'referral.accepted',
    entityType: 'referral',
    entityId: referralId,
    fromState: ReferralState.ACKNOWLEDGED,
    toState: ReferralState.ACCEPTED,
    actor: `clinician:${clinicianId}`,
    metadata: { clinicianId },
  });
}

async function declineReferral(referralId: number, clinicianId: string, reason: string): Promise<void> {
  await db
    .update(referrals)
    .set({ state: ReferralState.DECLINED, clinicianId, declineReason: reason, updatedAt: new Date() })
    .where(eq(referrals.id, referralId));
  await emitEvent({
    eventType: 'referral.declined',
    entityType: 'referral',
    entityId: referralId,
    fromState: ReferralState.ACKNOWLEDGED,
    toState: ReferralState.DECLINED,
    actor: `clinician:${clinicianId}`,
    metadata: { clinicianId, declineReason: reason },
  });
}

async function scheduleReferral(
  referralId: number,
  clinicianId: string,
  dept: string,
  apptDaysFromNow: number,
): Promise<void> {
  const apptDate =
    new Date(Date.now() + apptDaysFromNow * 86_400_000).toISOString().slice(0, 10) + 'T09:00:00';
  const location = LOCATIONS[dept] ?? `${dept} Clinic`;
  const providerName = PROVIDER_NAMES[clinicianId] ?? clinicianId;

  await db
    .update(referrals)
    .set({
      state: ReferralState.SCHEDULED,
      appointmentDate: apptDate,
      appointmentLocation: location,
      scheduledProvider: providerName,
      updatedAt: new Date(),
    })
    .where(eq(referrals.id, referralId));
  await emitEvent({
    eventType: 'referral.scheduled',
    entityType: 'referral',
    entityId: referralId,
    fromState: ReferralState.ACCEPTED,
    toState: ReferralState.SCHEDULED,
    actor: 'system',
    metadata: { appointmentDate: apptDate, locationName: location, scheduledProvider: providerName },
  });
}

async function encounterReferral(referralId: number): Promise<void> {
  await db
    .update(referrals)
    .set({ state: ReferralState.ENCOUNTER, updatedAt: new Date() })
    .where(eq(referrals.id, referralId));
  await emitEvent({
    eventType: 'referral.encounter_complete',
    entityType: 'referral',
    entityId: referralId,
    fromState: ReferralState.SCHEDULED,
    toState: ReferralState.ENCOUNTER,
    actor: 'system',
    metadata: {},
  });
}

async function closeReferral(referralId: number, dept: string): Promise<void> {
  // Encounter → Closed
  await db
    .update(referrals)
    .set({ state: ReferralState.CLOSED, updatedAt: new Date() })
    .where(eq(referrals.id, referralId));
  await emitEvent({
    eventType: 'referral.closed',
    entityType: 'referral',
    entityId: referralId,
    fromState: ReferralState.ENCOUNTER,
    toState: ReferralState.CLOSED,
    actor: 'system',
    metadata: { consultNote: CONSULT_NOTES[dept] ?? 'Consultation complete.' },
  });

  // Closed → Closed-Confirmed
  await db
    .update(referrals)
    .set({ state: ReferralState.CLOSED_CONFIRMED, updatedAt: new Date() })
    .where(eq(referrals.id, referralId));
  await emitEvent({
    eventType: 'referral.closed_confirmed',
    entityType: 'referral',
    entityId: referralId,
    fromState: ReferralState.CLOSED,
    toState: ReferralState.CLOSED_CONFIRMED,
    actor: 'system',
    metadata: {},
  });
}

async function noShowReferral(referralId: number): Promise<void> {
  await db
    .update(referrals)
    .set({ state: ReferralState.NO_SHOW, updatedAt: new Date() })
    .where(eq(referrals.id, referralId));
  await emitEvent({
    eventType: 'referral.no_show',
    entityType: 'referral',
    entityId: referralId,
    fromState: ReferralState.SCHEDULED,
    toState: ReferralState.NO_SHOW,
    actor: 'system',
    metadata: {},
  });
}

async function pendingInfoReferral(referralId: number): Promise<void> {
  await db
    .update(referrals)
    .set({ state: ReferralState.PENDING_INFORMATION, updatedAt: new Date() })
    .where(eq(referrals.id, referralId));
  await emitEvent({
    eventType: 'referral.pending_info',
    entityType: 'referral',
    entityId: referralId,
    fromState: ReferralState.ACKNOWLEDGED,
    toState: ReferralState.PENDING_INFORMATION,
    actor: 'skill:completeness-check',
    metadata: {
      skillName: 'completeness-check',
      explanation: 'Missing required ICD-10 diagnosis codes. Please provide specific codes for the stated diagnosis.',
    },
  });
}

async function insertPriorAuth(
  referralId: number,
  patientId: number,
  dept: string,
  outcome: PaOutcome,
): Promise<void> {
  const payer = DEPT_PAYERS[dept] ?? { name: 'Aetna', id: 'aetna' };
  const svc = PA_SERVICE_CODES[dept] ?? { code: '99213', display: 'Office Visit' };
  const providerName = PROVIDER_NAMES['dr-chen'];

  const paState =
    outcome === 'approved'
      ? PriorAuthState.APPROVED
      : outcome === 'denied'
        ? PriorAuthState.DENIED
        : PriorAuthState.PENDED;

  const authNumber = outcome === 'approved' ? `AUTH-SEED-${String(referralId).padStart(4, '0')}` : null;
  const denialReason = outcome === 'denied' ? 'Not medically necessary' : null;

  const now = new Date();

  const [inserted] = await db
    .insert(priorAuthRequests)
    .values({
      referralId,
      patientId,
      state: paState,
      claimJson: JSON.stringify({ resourceType: 'Claim', id: `seed-claim-${referralId}` }),
      insurerName: payer.name,
      insurerId: payer.id,
      serviceCode: svc.code,
      serviceDisplay: svc.display,
      providerNpi: '1234567890',
      providerName,
      createdAt: now,
      updatedAt: now,
      submittedAt: now,
    })
    .returning({ id: priorAuthRequests.id });

  await db.insert(priorAuthResponses).values({
    requestId: inserted.id,
    responseJson: JSON.stringify({ resourceType: 'ClaimResponse', outcome }),
    outcome,
    authNumber,
    denialReason,
    receivedVia: 'sync',
    receivedAt: now,
  });

  await emitEvent({
    eventType: 'prior_auth.submitted',
    entityType: 'priorAuth',
    entityId: inserted.id,
    fromState: PriorAuthState.DRAFT,
    toState: PriorAuthState.SUBMITTED,
    actor: 'system',
    metadata: { insurerName: payer.name, serviceCode: svc.code },
  });

  await emitEvent({
    eventType: `prior_auth.${outcome}`,
    entityType: 'priorAuth',
    entityId: inserted.id,
    fromState: PriorAuthState.SUBMITTED,
    toState: paState,
    actor: `payer:${payer.name}`,
    metadata: {
      receivedVia: 'sync',
      ...(authNumber ? { authNumber } : {}),
      ...(denialReason ? { denialReason } : {}),
    },
  });
}

/**
 * Backdate a referral and all its related workflow events to targetDate.
 * Events are offset proportionally so relative timing is preserved.
 */
async function spreadTimestamps(referralId: number, targetDate: Date): Promise<void> {
  const nowMs = Date.now();
  const targetMs = targetDate.getTime();
  const deltaMs = nowMs - targetMs; // positive = subtract to go backward

  // Update referral created_at
  await db.update(referrals).set({ createdAt: targetDate }).where(eq(referrals.id, referralId));

  // Backdate referral workflow events
  await db.run(sql`
    UPDATE workflow_events
    SET created_at = created_at - ${deltaMs}
    WHERE entity_type = 'referral' AND entity_id = ${referralId}
  `);

  // Backdate PA events for this referral
  await db.run(sql`
    UPDATE workflow_events
    SET created_at = created_at - ${deltaMs}
    WHERE entity_type = 'priorAuth' AND entity_id IN (
      SELECT id FROM prior_auth_requests WHERE referral_id = ${referralId}
    )
  `);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Scenario Runner ───────────────────────────────────────────────────────────

async function runScenario(scenario: Scenario): Promise<number> {
  const suffix = `${scenario.index}-${Date.now()}`;
  console.log(`  Scenario ${scenario.index}: ${scenario.fixture} → ${scenario.dept}/${scenario.clinicianId} → ${scenario.endState}${scenario.pa ? ` (PA ${scenario.pa})` : ''}`);

  const referralId = await ingestFixture(scenario.fixture, suffix, scenario.referrerAddress);

  // Set routing department (Gemini routing fires in background but we override synchronously)
  await setDepartment(referralId, scenario.dept);

  // Get patient ID for PA inserts
  const [referral] = await db.select({ patientId: referrals.patientId }).from(referrals).where(eq(referrals.id, referralId));
  const patientId = referral?.patientId ?? 1;

  switch (scenario.endState) {
    case 'Closed-Confirmed': {
      await acceptReferral(referralId, scenario.clinicianId);
      if (scenario.pa === 'approved') {
        await insertPriorAuth(referralId, patientId, scenario.dept, 'approved');
      }
      await scheduleReferral(referralId, scenario.clinicianId, scenario.dept, -7); // 7 days ago
      await encounterReferral(referralId);
      await closeReferral(referralId, scenario.dept);
      break;
    }
    case 'Encounter': {
      await acceptReferral(referralId, scenario.clinicianId);
      await scheduleReferral(referralId, scenario.clinicianId, scenario.dept, -3);
      await encounterReferral(referralId);
      break;
    }
    case 'Scheduled': {
      await acceptReferral(referralId, scenario.clinicianId);
      await scheduleReferral(referralId, scenario.clinicianId, scenario.dept, 7); // future appointment
      if (scenario.pa) {
        await insertPriorAuth(referralId, patientId, scenario.dept, scenario.pa);
      }
      break;
    }
    case 'No-Show': {
      await acceptReferral(referralId, scenario.clinicianId);
      await scheduleReferral(referralId, scenario.clinicianId, scenario.dept, -2);
      await noShowReferral(referralId);
      break;
    }
    case 'Declined': {
      const reason = scenario.declineReason ?? 'Referral declined';
      await declineReferral(referralId, scenario.clinicianId, reason);
      break;
    }
    case 'Pending-Information': {
      await pendingInfoReferral(referralId);
      break;
    }
  }

  // Spread timestamps across the last 90 days
  const targetDate = new Date(Date.now() - scenario.daysBack * 86_400_000);
  await spreadTimestamps(referralId, targetDate);

  return referralId;
}

// ── Clear Previous Seed Data ──────────────────────────────────────────────────

async function clearSeedData(): Promise<void> {
  // Use raw SQL to cascade-delete in the correct order
  await db.run(sql`
    DELETE FROM workflow_events
    WHERE entity_type = 'priorAuth' AND entity_id IN (
      SELECT par.id FROM prior_auth_requests par
      JOIN referrals r ON par.referral_id = r.id
      WHERE r.source_message_id LIKE '%full-demo-seed-%'
    )
  `);
  await db.run(sql`
    DELETE FROM prior_auth_responses
    WHERE request_id IN (
      SELECT par.id FROM prior_auth_requests par
      JOIN referrals r ON par.referral_id = r.id
      WHERE r.source_message_id LIKE '%full-demo-seed-%'
    )
  `);
  await db.run(sql`
    DELETE FROM prior_auth_requests
    WHERE referral_id IN (
      SELECT id FROM referrals WHERE source_message_id LIKE '%full-demo-seed-%'
    )
  `);
  await db.run(sql`
    DELETE FROM workflow_events
    WHERE entity_type = 'referral' AND entity_id IN (
      SELECT id FROM referrals WHERE source_message_id LIKE '%full-demo-seed-%'
    )
  `);
  await db.run(sql`
    DELETE FROM skill_executions
    WHERE referral_id IN (
      SELECT id FROM referrals WHERE source_message_id LIKE '%full-demo-seed-%'
    )
  `);
  await db.run(sql`
    DELETE FROM outbound_messages
    WHERE referral_id IN (
      SELECT id FROM referrals WHERE source_message_id LIKE '%full-demo-seed-%'
    )
  `);
  await db.run(sql`
    DELETE FROM referrals WHERE source_message_id LIKE '%full-demo-seed-%'
  `);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Full Demo Seed Script ===\n');

  console.log('Clearing previous seed data...');
  await clearSeedData();
  console.log('Cleared.\n');

  console.log(`Running ${SCENARIOS.length} scenarios:\n`);

  const inserted: number[] = [];

  for (const scenario of SCENARIOS) {
    try {
      const referralId = await runScenario(scenario);
      inserted.push(referralId);
      await sleep(50); // small delay to spread created_at timestamps naturally
    } catch (err) {
      console.error(`  [ERROR] Scenario ${scenario.index} failed:`, (err as Error).message);
      // Continue with remaining scenarios
    }
  }

  // Wait for background routing assessments (Claude/Gemini) to complete before
  // re-applying departments. assessRouting fires in ingestReferral and
  // unconditionally overwrites routingDepartment — this final pass wins the race.
  console.log('\nWaiting 4s for background routing assessments to settle...');
  await sleep(4000);

  console.log('Re-applying department assignments...');
  for (let i = 0; i < inserted.length; i++) {
    await setDepartment(inserted[i], SCENARIOS[i].dept);
  }

  console.log(`\n✓ Seeded ${inserted.length}/${SCENARIOS.length} referrals`);
  console.log('\nRun `npm run dev` → visit http://localhost:3000/analytics');
  console.log('Expected anomaly clusters: dr-kim/Neurology denials (9), dr-rodriguez/Oncology denials (7),');
  console.log('  Aetna/Cardiology PA denials (11), Cardiology no-shows (10), same-referrer pending-info (6)\n');
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
