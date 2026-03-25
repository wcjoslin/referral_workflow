/**
 * Deterministic check for in-network-accept skill.
 *
 * Matches when:
 *  - payer is in the approved payer list, AND
 *  - at least one problem/diagnosis is listed
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
  const clinical = input.clinicalData;
  const payer = clinical.payer as string | undefined;

  if (!approvedPayers || approvedPayers.length === 0 || !payer) {
    return { resolved: false }; // can't determine — let AI evaluate
  }

  const normalized = payer.toLowerCase().trim();
  const isInNetwork = approvedPayers.some((p) => normalized.includes(p.toLowerCase().trim()));

  if (!isInNetwork) {
    return {
      resolved: true,
      matched: false,
      explanation: `Patient's payer (${payer}) is not in the approved payer list — cannot auto-accept.`,
    };
  }

  const problems = clinical.problems as unknown[] | undefined;
  const hasProblems = Array.isArray(problems) && problems.length > 0;

  if (!hasProblems) {
    return {
      resolved: true,
      matched: false,
      explanation: `Payer (${payer}) is in-network but no problems/diagnoses are listed — cannot auto-accept.`,
    };
  }

  return {
    resolved: true,
    matched: true,
    explanation: `Payer (${payer}) is in-network and ${problems!.length} diagnosis/problem(s) are present — referral qualifies for auto-accept.`,
  };
}
