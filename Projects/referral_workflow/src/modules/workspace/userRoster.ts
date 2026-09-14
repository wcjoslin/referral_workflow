/**
 * Demo Staff Roster (PRD-17)
 *
 * The single source of the seeded people. Four of them carry the
 * `legacyClinicianId` slugs that already appear in `referrals.clinician_id`
 * across the demo data, so historical rows resolve to a real person and the
 * analytics Clinician filter can label them.
 *
 * `PROVIDER_NAMES` used to live in scripts/seed-full-demo.ts and was duplicated
 * by slug in scripts/seed-analytics-demo.ts. It is derived from this roster now,
 * so the display names have one definition.
 *
 * This module lives under src/ rather than scripts/ so it is type-checked by
 * `npm run build`, counted by coverage, and importable from tests — following
 * the precedent of src/demoScenarios.ts. PRD-17's Deliverables suggested
 * scripts/, which would have been outside all three.
 *
 * Real people only: automation identities (SYSTEM-SKILL-<name>, SYSTEM-TIMEOUT)
 * are never rows in `users`.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema';
import type { JobRole } from './identityService';

export interface RosterEntry {
  displayName: string;
  email: string;
  jobRole: JobRole;
  /** Historical referrals.clinician_id slug, when this person has one. */
  legacyClinicianId?: string;
  /**
   * This person's own Direct address on the organisation's domain, when they
   * have one. Dr. Sarah Kim deliberately has none, so PRD-29's fallback to the
   * organizational intake address is exercised by the demo data.
   */
  directAddress?: string;
  /** The explicit PRD-20 see-all-queues grant. Exactly one seeded user has it. */
  allQueuesAccess?: boolean;
}

/**
 * Individual Direct addresses are on `specialist.direct`, the domain implied by
 * the seeded RECEIVING_DIRECT_ADDRESS=receiving@specialist.direct.
 */
export const USER_ROSTER: readonly RosterEntry[] = [
  {
    displayName: 'Dr. Emily Chen, MD',
    email: 'echen@specialist.example.org',
    jobRole: 'clinician',
    legacyClinicianId: 'dr-chen',
    directAddress: 'echen@specialist.direct',
  },
  {
    displayName: 'Dr. Raj Patel, MD',
    email: 'rpatel@specialist.example.org',
    jobRole: 'clinician',
    legacyClinicianId: 'dr-patel',
    directAddress: 'rpatel@specialist.direct',
  },
  {
    displayName: 'Dr. Carlos Rodriguez, MD',
    email: 'crodriguez@specialist.example.org',
    jobRole: 'clinician',
    legacyClinicianId: 'dr-rodriguez',
    directAddress: 'crodriguez@specialist.direct',
  },
  {
    // No individual Direct address, on purpose — see RosterEntry.directAddress.
    displayName: 'Dr. Sarah Kim, MD',
    email: 'skim@specialist.example.org',
    jobRole: 'clinician',
    legacyClinicianId: 'dr-kim',
  },
  { displayName: 'Dana Ruiz', email: 'druiz@specialist.example.org', jobRole: 'coordinator' },
  { displayName: 'Priya Raman', email: 'praman@specialist.example.org', jobRole: 'coordinator' },
  { displayName: 'Sam Okafor', email: 'sokafor@specialist.example.org', jobRole: 'scheduler' },
  {
    displayName: 'Alex Whitfield',
    email: 'awhitfield@specialist.example.org',
    jobRole: 'manager',
    allQueuesAccess: true,
  },
];

/**
 * Historical clinician slug → display name, derived from the roster.
 *
 * Kept as a plain map because the seed scripts index into it by slug
 * (`PROVIDER_NAMES[clinicianId] ?? clinicianId`).
 */
export const PROVIDER_NAMES: Record<string, string> = Object.fromEntries(
  USER_ROSTER.filter((u) => u.legacyClinicianId).map((u) => [
    u.legacyClinicianId as string,
    u.displayName,
  ]),
);

/** The legacy clinician slugs that map to a real person, in roster order. */
export const CLINICIAN_SLUGS: readonly string[] = USER_ROSTER.filter(
  (u) => u.legacyClinicianId,
).map((u) => u.legacyClinicianId as string);

export interface SeedUsersResult {
  created: number;
  skipped: number;
}

/**
 * Seeds the staff roster. Idempotent on `email`: re-running any seed script
 * leaves the same eight people rather than duplicating them.
 *
 * Deliberately does not update existing rows — a demo operator who renamed
 * someone or flipped a flag keeps their change across reseeds.
 */
export async function seedUsers(): Promise<SeedUsersResult> {
  let created = 0;
  let skipped = 0;

  for (const entry of USER_ROSTER) {
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, entry.email))
      .limit(1);

    if (existing) {
      skipped += 1;
      continue;
    }

    await db.insert(users).values({
      displayName: entry.displayName,
      email: entry.email,
      directAddress: entry.directAddress ?? null,
      jobRole: entry.jobRole,
      legacyClinicianId: entry.legacyClinicianId ?? null,
      allQueuesAccess: entry.allQueuesAccess ?? false,
      active: true,
      createdAt: new Date(),
    });
    created += 1;
  }

  return { created, skipped };
}
