import { buildRri, RriOptions } from '../../../src/modules/prd02/rriBuilder';

const BASE_OPTS: RriOptions = {
  messageControlId: 'test-uuid-001',
  sourceMessageId: '<original-msg-001@hospital.direct>',
  referrerAddress: 'referrer@hospital.direct',
  sendingFacility: 'specialist@specialist.direct',
  acceptCode: 'AA',
};

describe('buildRri', () => {
  describe('MSH segment', () => {
    it('starts with MSH', () => {
      const rri = buildRri(BASE_OPTS);
      expect(rri.startsWith('MSH')).toBe(true);
    });

    it('contains the message control ID in MSH-10', () => {
      const rri = buildRri(BASE_OPTS);
      const msh = rri.split('\r\n')[0];
      const fields = msh.split('|');
      expect(fields[9]).toBe('test-uuid-001');
    });

    it('sets message type to RRI^I12^RRI_I12', () => {
      const rri = buildRri(BASE_OPTS);
      const msh = rri.split('\r\n')[0];
      const fields = msh.split('|');
      expect(fields[8]).toBe('RRI^I12^RRI_I12');
    });

    it('sets HL7 version to 2.5', () => {
      const rri = buildRri(BASE_OPTS);
      const msh = rri.split('\r\n')[0];
      const fields = msh.split('|');
      expect(fields[11]).toBe('2.5');
    });
  });

  describe('MSA segment — accept', () => {
    it('contains AA in MSA-1 for accepted referrals', () => {
      const rri = buildRri(BASE_OPTS);
      const msa = rri.split('\r\n')[1];
      expect(msa.startsWith('MSA|AA')).toBe(true);
    });

    it('includes the message control ID in MSA-2', () => {
      const rri = buildRri(BASE_OPTS);
      const msa = rri.split('\r\n')[1];
      const fields = msa.split('|');
      expect(fields[2]).toBe('test-uuid-001');
    });

    it('does not include a decline reason for accepted referrals', () => {
      const rri = buildRri(BASE_OPTS);
      const msa = rri.split('\r\n')[1];
      const fields = msa.split('|');
      expect(fields[3]).toBeUndefined();
    });
  });

  describe('MSA segment — decline', () => {
    const declineOpts: RriOptions = {
      ...BASE_OPTS,
      acceptCode: 'AR',
      declineReason: 'Out of Scope',
    };

    it('contains AR in MSA-1 for declined referrals', () => {
      const rri = buildRri(declineOpts);
      const msa = rri.split('\r\n')[1];
      expect(msa.startsWith('MSA|AR')).toBe(true);
    });

    it('includes the decline reason in MSA-3', () => {
      const rri = buildRri(declineOpts);
      const msa = rri.split('\r\n')[1];
      const fields = msa.split('|');
      expect(fields[3]).toBe('Out of Scope');
    });
  });

  describe('RF1 segment', () => {
    it('contains the source message ID in RF1-7', () => {
      const rri = buildRri(BASE_OPTS);
      const rf1 = rri.split('\r\n')[2];
      expect(rf1.startsWith('RF1')).toBe(true);
      const fields = rf1.split('|');
      expect(fields[7]).toBe('<original-msg-001@hospital.direct>');
    });
  });

  describe('PRD segment', () => {
    it('contains the sending facility address', () => {
      const rri = buildRri(BASE_OPTS);
      const prd = rri.split('\r\n')[3];
      expect(prd.startsWith('PRD')).toBe(true);
      expect(prd).toContain('specialist@specialist.direct');
    });
  });

  describe('message structure', () => {
    it('contains exactly 4 segments', () => {
      const rri = buildRri(BASE_OPTS);
      const segments = rri.split('\r\n');
      expect(segments).toHaveLength(4);
    });

    it('escapes pipe characters in field values', () => {
      const rri = buildRri({ ...BASE_OPTS, declineReason: 'reason|with|pipes', acceptCode: 'AR' });
      // Pipes in values should be escaped, not breaking the segment structure
      const msa = rri.split('\r\n')[1];
      const fields = msa.split('|');
      // MSA has 3 fields (MSA, code, controlId, reason) — reason may contain escaped pipes
      expect(fields[3]).toContain('\\F\\');
    });
  });
});
