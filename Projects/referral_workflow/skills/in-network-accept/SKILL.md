---
name: in-network-accept
description: Auto-accept referrals where the patient's payer is in-network and the referral includes diagnosis codes
metadata:
  trigger-point: post-intake
  action-type: auto-accept
  confidence-threshold: 0.90
  priority: 10
  active: true
  test-mode: false
---

# In-Network Auto-Accept

## Context

This rule fast-tracks referrals that meet both baseline administrative criteria:
1. The patient's payer is in the facility's approved payer network.
2. The referral includes at least one diagnosis code (ICD-10 or problem description) supporting the reason for referral.

When both conditions are met, the referral can be auto-accepted, bypassing the manual clinician queue.

## Evaluation Steps

1. Check that the patient's payer is present in the facility approved payer list (from assets/approved-payers.json).
2. Check that the problems list includes at least one item.
3. If BOTH conditions are true, this rule MATCHES (the referral should be auto-accepted).
4. If either condition is false, this rule does NOT match.
5. If no payer information is available, this rule does NOT match.

## Notes

- A deterministic script (`scripts/check-complete.ts`) handles this check when payer data is available.
- This rule is intentionally lenient — the goal is to clear administrative bottlenecks, not replace clinical review.
