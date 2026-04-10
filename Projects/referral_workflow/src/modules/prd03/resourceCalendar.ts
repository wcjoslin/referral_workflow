/**
 * Mock resource/asset availability calendar for PRD-03.
 *
 * Provides a small catalogue of rooms and equipment, each with
 * pre-blocked time slots. Used by schedulingService to detect
 * conflicts before confirming an appointment.
 */

export interface TimeSlot {
  start: Date;
  end: Date;
}

export interface Resource {
  id: string;
  name: string;
  department: string;
  blockedSlots: TimeSlot[];
}

/**
 * Seed data — a handful of rooms / equipment with some blocked windows.
 * In a real system this would come from the EHR scheduling module.
 */
function buildCatalogue(): Resource[] {
  return [
    // Cardiology
    {
      id: 'echo-lab',
      name: 'Echocardiography Lab',
      department: 'Cardiology',
      blockedSlots: [
        { start: new Date('2026-03-30T08:00:00'), end: new Date('2026-03-30T12:00:00') },
        { start: new Date('2026-04-01T14:00:00'), end: new Date('2026-04-01T16:00:00') },
      ],
    },
    {
      id: 'stress-test-room',
      name: 'Cardiac Stress Test Room',
      department: 'Cardiology',
      blockedSlots: [
        { start: new Date('2026-03-31T09:00:00'), end: new Date('2026-03-31T11:00:00') },
      ],
    },
    // Imaging
    {
      id: 'mri-suite',
      name: 'MRI Suite',
      department: 'Imaging',
      blockedSlots: [
        { start: new Date('2026-03-30T08:00:00'), end: new Date('2026-03-30T10:00:00') },
      ],
    },
    {
      id: 'ct-scanner',
      name: 'CT Scanner',
      department: 'Imaging',
      blockedSlots: [],
    },
    // Neurology
    {
      id: 'neuro-consult-1',
      name: 'Neurology Consultation Room 1',
      department: 'Neurology',
      blockedSlots: [],
    },
    // Orthopedics
    {
      id: 'ortho-treatment',
      name: 'Orthopedics Treatment Room',
      department: 'Orthopedics',
      blockedSlots: [
        { start: new Date('2026-04-02T13:00:00'), end: new Date('2026-04-02T15:00:00') },
      ],
    },
    // Gastroenterology
    {
      id: 'endoscopy-suite',
      name: 'Endoscopy Suite',
      department: 'Gastroenterology',
      blockedSlots: [
        { start: new Date('2026-04-01T07:00:00'), end: new Date('2026-04-01T12:00:00') },
      ],
    },
    // Physical Therapy
    {
      id: 'pt-gym',
      name: 'Physical Therapy Gym',
      department: 'Physical Therapy',
      blockedSlots: [],
    },
    // Endocrinology
    {
      id: 'endo-consult',
      name: 'Endocrinology Consultation Room',
      department: 'Endocrinology',
      blockedSlots: [],
    },
    // General / shared
    {
      id: 'exam-room-1',
      name: 'Exam Room 1',
      department: 'General',
      blockedSlots: [
        { start: new Date('2026-03-30T10:00:00'), end: new Date('2026-03-30T11:00:00') },
      ],
    },
    {
      id: 'exam-room-2',
      name: 'Exam Room 2',
      department: 'General',
      blockedSlots: [],
    },
  ];
}

let catalogue: Resource[] | null = null;

function getCatalogue(): Resource[] {
  if (!catalogue) catalogue = buildCatalogue();
  return catalogue;
}

/** Returns the full resource list (for UI dropdowns). */
export function getResources(): Resource[] {
  return getCatalogue();
}

/** Returns a single resource by id, or undefined. */
export function getResource(id: string): Resource | undefined {
  return getCatalogue().find((r) => r.id === id);
}

/**
 * Returns resources that conflict with the proposed time window.
 * An empty array means no conflicts — safe to schedule.
 */
export function checkConflicts(
  resourceIds: string[],
  proposedStart: Date,
  durationMinutes: number,
): Resource[] {
  const proposedEnd = new Date(proposedStart.getTime() + durationMinutes * 60_000);

  return getCatalogue().filter((r) => {
    if (!resourceIds.includes(r.id)) return false;
    return r.blockedSlots.some(
      (slot) => proposedStart < slot.end && proposedEnd > slot.start,
    );
  });
}

/** Returns the sorted list of unique department names from the catalogue. */
export function getDepartments(): string[] {
  const depts = new Set(getCatalogue().map((r) => r.department));
  return [...depts].sort();
}

/** Reset catalogue (useful for tests). */
export function _resetCatalogue(): void {
  catalogue = null;
}
