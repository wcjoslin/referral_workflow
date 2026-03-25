---
name: missing-icd-codes
description: Request additional information when a referral is missing required ICD-10 diagnosis codes
metadata:
  trigger-point: post-intake
  action-type: request-info
  confidence-threshold: 0.85
  priority: 2
  active: true
  test-mode: true
  timeout-hours: 72
  timeout-action: auto-decline
---

# Missing ICD Codes Check

## Context

This rule evaluates whether the referral includes appropriate ICD-10 diagnosis codes to support the reason for referral. Many facilities require specific diagnosis codes for billing, prior authorization, and clinical decision-making. When codes are missing, the referral should be paused and the referring provider asked to supply them.

## Evaluation Steps

1. Review the patient's problems/diagnoses list in the referral data.
2. Check if any items include ICD-10 codes (format: letter followed by digits, with optional decimal — e.g., M54.5, E11.9, J45.20).
3. Compare the reason for referral against the listed diagnoses. The diagnoses should clinically support the referral reason.
4. Consult the facility's ICD documentation requirements in the references section.
5. If NO ICD-10 codes are found in the problems list, this rule MATCHES.
6. If ICD-10 codes are present but do not appear to support the reason for referral, this rule MATCHES with lower confidence.
7. If appropriate ICD-10 codes are present, this rule does NOT match.

## Expected Response

When this rule matches, the explanation should list which specific documentation is missing (e.g., "No ICD-10 diagnosis codes found in the referral. The reason for referral mentions chronic pain but no supporting diagnosis code is provided.").
