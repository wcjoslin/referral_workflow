import { checkConflicts, getResources, getResource, getDepartments, _resetCatalogue } from '../../../src/modules/prd03/resourceCalendar';

beforeEach(() => {
  _resetCatalogue();
});

describe('getResources', () => {
  it('returns the full resource catalogue', () => {
    const resources = getResources();
    expect(resources.length).toBeGreaterThanOrEqual(3);
    expect(resources.map((r) => r.id)).toContain('echo-lab');
    expect(resources.map((r) => r.id)).toContain('exam-room-2');
  });
});

describe('getResource', () => {
  it('returns a resource by id', () => {
    const r = getResource('echo-lab');
    expect(r).toBeDefined();
    expect(r!.name).toBe('Echocardiography Lab');
  });

  it('returns undefined for unknown id', () => {
    expect(getResource('nonexistent')).toBeUndefined();
  });
});

describe('getDepartments', () => {
  it('returns the sorted unique list of departments', () => {
    const depts = getDepartments();
    expect(depts).toEqual([...new Set(depts)].sort());
    expect(depts.length).toBeGreaterThanOrEqual(3);
    expect(depts).toContain('Cardiology');
    expect(depts).toContain('Imaging');
    expect(depts).toContain('General');
  });
});

describe('resource department field', () => {
  it('every resource has a department string', () => {
    const resources = getResources();
    resources.forEach((r) => {
      expect(typeof r.department).toBe('string');
      expect(r.department.length).toBeGreaterThan(0);
    });
  });
});

describe('checkConflicts', () => {
  it('returns conflicting resources for an overlapping slot', () => {
    // echo-lab is blocked 2026-03-30 08:00–12:00
    const conflicts = checkConflicts(
      ['echo-lab'],
      new Date('2026-03-30T09:00:00'),
      60, // 09:00–10:00, overlaps with 08:00–12:00
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].id).toBe('echo-lab');
  });

  it('returns empty array when no conflict', () => {
    // echo-lab blocked 08:00–12:00; propose 13:00–14:00 — no overlap
    const conflicts = checkConflicts(
      ['echo-lab'],
      new Date('2026-03-30T13:00:00'),
      60,
    );
    expect(conflicts).toHaveLength(0);
  });

  it('returns empty array for resources with no blocked slots', () => {
    // exam-room-2 has no blocked slots
    const conflicts = checkConflicts(
      ['exam-room-2'],
      new Date('2026-03-30T09:00:00'),
      60,
    );
    expect(conflicts).toHaveLength(0);
  });

  it('only checks requested resources', () => {
    // echo-lab is blocked at this time, but we only check exam-room-2
    const conflicts = checkConflicts(
      ['exam-room-2'],
      new Date('2026-03-30T09:00:00'),
      60,
    );
    expect(conflicts).toHaveLength(0);
  });

  it('detects conflict at the boundary (proposed end == block start is no conflict)', () => {
    // echo-lab blocked from 08:00. Propose 07:00–08:00 — end touches start, no overlap
    const conflicts = checkConflicts(
      ['echo-lab'],
      new Date('2026-03-30T07:00:00'),
      60,
    );
    expect(conflicts).toHaveLength(0);
  });

  it('detects conflict when proposed slot spans the entire blocked window', () => {
    // echo-lab blocked 08:00–12:00. Propose 07:00–13:00 — fully spans
    const conflicts = checkConflicts(
      ['echo-lab'],
      new Date('2026-03-30T07:00:00'),
      360, // 6 hours
    );
    expect(conflicts).toHaveLength(1);
  });

  it('checks multiple resources at once', () => {
    // echo-lab blocked 2026-03-30 08:00–12:00, exam-room-1 blocked 10:00–11:00
    const conflicts = checkConflicts(
      ['echo-lab', 'exam-room-1'],
      new Date('2026-03-30T10:00:00'),
      30,
    );
    expect(conflicts).toHaveLength(2);
  });
});
