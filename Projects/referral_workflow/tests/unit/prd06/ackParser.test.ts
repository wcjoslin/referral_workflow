import { parseAck } from '../../../src/modules/prd06/ackParser';

const SAMPLE_ACK = [
  'MSH|^~\\&|ReferrerApp|Hospital|ReferralWorkflow|Specialist|20260324120000||ACK^A01|ack-ctrl-1|P|2.5',
  'MSA|AA|c6632330-5508-4211-97bc-12bb5def79b5',
].join('\r\n');

describe('ackParser', () => {
  it('extracts ackCode from MSA-1', () => {
    const result = parseAck(SAMPLE_ACK);
    expect(result.ackCode).toBe('AA');
  });

  it('extracts acknowledgedControlId from MSA-2', () => {
    const result = parseAck(SAMPLE_ACK);
    expect(result.acknowledgedControlId).toBe('c6632330-5508-4211-97bc-12bb5def79b5');
  });

  it('extracts messageControlId from MSH-10', () => {
    const result = parseAck(SAMPLE_ACK);
    expect(result.messageControlId).toBe('ack-ctrl-1');
  });

  it('throws when MSH segment is missing', () => {
    expect(() => parseAck('MSA|AA|some-id')).toThrow('missing MSH segment');
  });

  it('throws when MSA segment is missing', () => {
    const noMsa = 'MSH|^~\\&|App|Fac|App|Fac|20260324||ACK|ctrl|P|2.5';
    expect(() => parseAck(noMsa)).toThrow('missing MSA segment');
  });

  it('throws when MSA-2 (acknowledged control ID) is empty', () => {
    const emptyMsa2 = [
      'MSH|^~\\&|App|Fac|App|Fac|20260324||ACK|ctrl|P|2.5',
      'MSA|AA|',
    ].join('\r\n');
    expect(() => parseAck(emptyMsa2)).toThrow('missing acknowledged Message Control ID');
  });

  it('handles LF line endings', () => {
    const lfAck = SAMPLE_ACK.replace(/\r\n/g, '\n');
    const result = parseAck(lfAck);
    expect(result.ackCode).toBe('AA');
    expect(result.acknowledgedControlId).toBe('c6632330-5508-4211-97bc-12bb5def79b5');
  });

  it('parses AR (rejected) ack code', () => {
    const arAck = SAMPLE_ACK.replace('MSA|AA|', 'MSA|AR|');
    const result = parseAck(arAck);
    expect(result.ackCode).toBe('AR');
  });
});
