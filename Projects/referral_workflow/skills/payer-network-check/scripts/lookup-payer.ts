/**
 * Deterministic payer lookup script for payer-network-check skill.
 *
 * Checks if the patient's payer is in the approved payer list.
 * Returns resolved=true if a clear determination can be made;
 * resolved=false to fall through to AI evaluation.
 */

interface CheckInput {
  clinicalData: Record<string, unknown>;
  assets: Record<string, unknown>;
}

interface CheckResult {
  resolved: boolean;
  matched?: boolean;
  explanation?: string;
}

export function check(input: CheckInput): CheckResult {
  const approvedPayers = input.assets['approved-payers.json'] as string[] | undefined;
  if (!approvedPayers || approvedPayers.length === 0) {
    return { resolved: false }; // no config — let AI evaluate
  }

  // Extract payer from clinical data
  const clinical = input.clinicalData;
  const payer = (clinical as Record<string, unknown>).payer as string | undefined;

  if (!payer) {
    return { resolved: false }; // payer not extractable — let AI evaluate
  }

  const normalized = payer.toLowerCase().trim();
  const isApproved = approvedPayers.some(
    (p) => normalized.includes(p.toLowerCase().trim()),
  );

  if (isApproved) {
    return {
      resolved: true,
      matched: false,
      explanation: `Patient's payer (${payer}) is in the approved payer list.`,
    };
  }

  return {
    resolved: true,
    matched: true,
    explanation: `Patient's payer (${payer}) is not in the facility's approved payer list.`,
  };
}
