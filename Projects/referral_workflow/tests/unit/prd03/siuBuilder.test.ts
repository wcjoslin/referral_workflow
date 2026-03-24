import { buildSiu, SiuOptions, isoToHl7 } from '../../../src/modules/prd03/siuBuilder';

const BASE_OPTS: SiuOptions = {
  messageControlId: 'test-siu-uuid-001',
  appointmentId: '42',
  startDatetime: '20260407100000',
  durationMinutes: 60,
  appointmentType: 'Cardiology Consult',
  locationName: 'Exam Room 2',
  scheduledProvider: 'Dr. Sarah Chen',
  patientId: '7',
  patientFirstName: 'Jane',
  patientLastName: 'Doe',
  patientDob: '19800315',
  referrerAddress: 'referrer@hospital.direct',
  sendingFacility: 'specialist@specialist.direct',
};

describe('buildSiu', () => {
  describe('MSH segment', () => {
    it('starts with MSH', () => {
      const siu = buildSiu(BASE_OPTS);
      expect(siu.startsWith('MSH')).toBe(true);
    });

    it('contains the message control ID in MSH-10', () => {
      const siu = buildSiu(BASE_OPTS);
      const msh = siu.split('\r\n')[0];
      const fields = msh.split('|');
      expect(fields[9]).toBe('test-siu-uuid-001');
    });

    it('sets message type to SIU^S12^SIU_S12', () => {
      const siu = buildSiu(BASE_OPTS);
      const msh = siu.split('\r\n')[0];
      const fields = msh.split('|');
      expect(fields[8]).toBe('SIU^S12^SIU_S12');
    });

    it('sets HL7 version to 2.5.1', () => {
      const siu = buildSiu(BASE_OPTS);
      const msh = siu.split('\r\n')[0];
      const fields = msh.split('|');
      expect(fields[11]).toBe('2.5.1');
    });
  });

  describe('SCH segment', () => {
    it('contains the appointment ID in SCH-1', () => {
      const siu = buildSiu(BASE_OPTS);
      const sch = siu.split('\r\n')[1];
      const fields = sch.split('|');
      expect(fields[1]).toBe('42');
    });

    it('contains the appointment type in SCH-7', () => {
      const siu = buildSiu(BASE_OPTS);
      const sch = siu.split('\r\n')[1];
      const fields = sch.split('|');
      expect(fields[7]).toBe('Cardiology Consult');
    });

    it('contains duration in SCH-11', () => {
      const siu = buildSiu(BASE_OPTS);
      const sch = siu.split('\r\n')[1];
      const fields = sch.split('|');
      expect(fields[11]).toBe('60^min');
    });

    it('contains the scheduled provider in SCH-16', () => {
      const siu = buildSiu(BASE_OPTS);
      const sch = siu.split('\r\n')[1];
      const fields = sch.split('|');
      expect(fields[16]).toBe('Dr. Sarah Chen');
    });

    it('contains the start datetime in SCH-26', () => {
      const siu = buildSiu(BASE_OPTS);
      const sch = siu.split('\r\n')[1];
      const fields = sch.split('|');
      expect(fields[26]).toBe('20260407100000');
    });

    it('contains the location in SCH-27', () => {
      const siu = buildSiu(BASE_OPTS);
      const sch = siu.split('\r\n')[1];
      const fields = sch.split('|');
      expect(fields[27]).toBe('Exam Room 2');
    });
  });

  describe('PID segment', () => {
    it('contains patient name in PID-5 (Last^First)', () => {
      const siu = buildSiu(BASE_OPTS);
      const pid = siu.split('\r\n')[2];
      const fields = pid.split('|');
      expect(fields[5]).toBe('Doe^Jane');
    });

    it('contains patient DOB in PID-7', () => {
      const siu = buildSiu(BASE_OPTS);
      const pid = siu.split('\r\n')[2];
      const fields = pid.split('|');
      expect(fields[7]).toBe('19800315');
    });

    it('contains patient ID in PID-3', () => {
      const siu = buildSiu(BASE_OPTS);
      const pid = siu.split('\r\n')[2];
      const fields = pid.split('|');
      expect(fields[3]).toBe('7');
    });
  });

  describe('PRD segment', () => {
    it('contains the referrer address', () => {
      const siu = buildSiu(BASE_OPTS);
      const prd = siu.split('\r\n')[3];
      expect(prd.startsWith('PRD')).toBe(true);
      expect(prd).toContain('referrer@hospital.direct');
    });
  });

  describe('message structure', () => {
    it('contains exactly 4 segments', () => {
      const siu = buildSiu(BASE_OPTS);
      const segments = siu.split('\r\n');
      expect(segments).toHaveLength(4);
    });

    it('escapes pipe characters in field values', () => {
      const siu = buildSiu({ ...BASE_OPTS, appointmentType: 'Type|With|Pipes' });
      const sch = siu.split('\r\n')[1];
      expect(sch).toContain('\\F\\');
    });
  });
});

describe('isoToHl7', () => {
  it('converts ISO date to HL7 DTM format', () => {
    expect(isoToHl7('2026-04-07')).toBe('20260407000000');
  });

  it('converts ISO datetime to HL7 DTM format', () => {
    expect(isoToHl7('2026-04-07T10:30:00')).toBe('20260407103000');
  });
});
