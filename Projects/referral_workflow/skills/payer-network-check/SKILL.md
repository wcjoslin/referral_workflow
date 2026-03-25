---
name: payer-network-check
description: Auto-decline referrals when the patient's payer is not in the facility's approved payer list
metadata:
  trigger-point: post-intake
  action-type: auto-decline
  confidence-threshold: 0.90
  priority: 1
  active: true
  test-mode: false
---

# Payer Network Check

## Context

This rule evaluates whether the patient's insurance payer is in the facility's approved payer network. Referrals from patients with out-of-network payers should be automatically declined so that the referring provider can redirect the patient to an in-network specialist.

## Evaluation Steps

1. Extract the patient's payer/insurance information from the referral data.
2. Load the approved payer list from the facility configuration.
3. Compare the patient's payer against the approved list (case-insensitive, partial match allowed).
4. If the payer is NOT in the approved list, this rule MATCHES (the referral should be declined).
5. If the payer IS in the approved list, this rule does NOT match.
6. If no payer information is available in the referral, this rule does NOT match (give benefit of the doubt).

## Notes

- A deterministic script (`scripts/lookup-payer.ts`) handles this check when payer data is clearly extractable.
- The AI evaluator is used as a fallback when payer information is embedded in free text or non-standard fields.
