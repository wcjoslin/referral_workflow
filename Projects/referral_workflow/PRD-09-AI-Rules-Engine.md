# PRD-09: AI-Powered Rules Engine with Agent Skills

**Status:** Draft

---

## 1. Overview

### 1.1. Context

Health centers process referrals that frequently require the same administrative decision for the same reason. A clinic that does not accept a particular payer will decline every referral from that payer. A clinic without ICU beds will always redirect critical-care patients. A clinic with strict documentation requirements will always request missing ICD codes before reviewing.

Today, each of these decisions requires a clinician to open the referral, read the data, recognize the pattern, and manually take the action — even though the outcome is predetermined. This repetitive work slows intake throughput and wastes clinical review time on referrals that never had a path to acceptance.

### 1.2. Goal

1. **Eliminate repetitive manual disposition** by allowing clinic administrators to define natural-language rules that automatically trigger actions when incoming referrals match known patterns.
2. **Reduce time-to-action** for referrals that require additional information — automatically request missing documentation from the referrer without waiting for clinician review.
3. **Preserve clinician oversight** through confidence thresholds, test mode, and post-action override capabilities.
4. **Support rule evaluation at multiple workflow stages** — not just intake, but also post-acceptance and encounter completion — so that automation covers the full referral lifecycle.
5. **Use the Agent Skills open specification** as the underlying format, so each rule is a portable, self-contained skill with its own instructions, scripts, and assets.

### 1.3. Scope

- **In Scope:**
  - A skill-based rules engine following the [Agent Skills specification](https://agentskills.io/specification). Each rule is a skill directory containing a `SKILL.md` file, optional scripts for deterministic lookups, and optional assets for facility configuration.
  - AI-assisted skill generation: clinic administrators describe a rule in plain English through a UI, and the system uses Gemini to generate the full skill directory (`SKILL.md`, scripts, asset templates).
  - A lightweight skill loader that discovers, parses, and evaluates skills at the appropriate workflow trigger points.
  - Three workflow trigger points: post-intake, post-acceptance, and encounter-to-closed.
  - Five action types: auto-decline, request additional information, flag for priority review, auto-accept, and custom consult note routing.
  - Facility configuration stored as JSON assets within each skill directory (e.g., approved payer list, available specialties).
  - Confidence threshold per skill — low-confidence matches escalate to human review instead of acting autonomously.
  - Test mode for skills — evaluates and logs what *would* happen without taking action.
  - Clinician override of automated decisions after the fact.
  - A new "Pending-Information" referral state for referrals awaiting requested documentation.
  - Audit trail: 1-2 sentence AI-generated explanation of why each rule fired.
  - Skill execution history viewable per skill and per referral.
  - Dedicated rules admin UI for skill management, asset editing, and execution history.

- **Out of Scope:**
  - Skill export/import or cross-facility sharing (future phase — the Agent Skills format makes this straightforward later).
  - Rules that create new referrals or modify patient records.
  - Real-time rule editing mid-evaluation (skill changes take effect on the next referral).
  - Multi-step rule chains (skill A fires, which triggers skill B) — each skill evaluates independently.
  - Integration with external Agent Skills runtimes — we build our own lightweight loader for this PoC.

---

## 2. User Stories & Acceptance Criteria

### 2.1. As a Clinic Administrator, I want to describe automation rules in plain language and have the system build them for me, so I don't need technical expertise to create automation.

- **AC1:** The admin UI provides a form where the admin enters: a rule description in plain English, the desired action type, and the workflow trigger point.
- **AC2:** On submission, the system calls Gemini to generate a complete Agent Skills directory: `SKILL.md` (with frontmatter and evaluation instructions), optional `scripts/` for deterministic lookups, and optional `assets/` templates for facility configuration.
- **AC3:** The admin can review the generated `SKILL.md` instructions before activating the skill.
- **AC4:** The admin can edit the generated skill's assets (e.g., populate the approved payer list) through the UI without touching files directly.
- **AC5:** Skills can be toggled active/inactive and placed in test mode without deletion.
- **AC6:** Skills are ordered by priority (admin-configurable). When multiple skills match the same referral, the most restrictive action wins.

### 2.2. As a Clinic Administrator, I want to manage facility-specific configuration data as skill assets, so that rules can evaluate against my clinic's specific constraints.

- **AC1:** Each skill that requires facility context includes an `assets/` directory with JSON configuration files (e.g., `approved-payers.json`, `available-specialties.json`).
- **AC2:** The admin UI provides an inline editor for each skill's asset files — adding, removing, and editing entries.
- **AC3:** For deterministic checks (e.g., payer in list), bundled scripts in the skill's `scripts/` directory perform the lookup before calling Gemini — avoiding unnecessary AI calls for simple matches.
- **AC4:** For contextual checks (e.g., "this patient's needs exceed our specialty capabilities"), the asset contents are passed as context to Gemini alongside the skill instructions and clinical data.

### 2.3. As a Clinician, I want automated skill actions to include a clear explanation, so that I can understand why the system took an action and override it if necessary.

- **AC1:** Every skill execution is logged with: skill name, referral ID, action taken, confidence score, and a 1-2 sentence AI-generated explanation of why the skill matched.
- **AC2:** On the referral review page, if a skill has acted on the referral, a banner displays the skill name, action, and explanation.
- **AC3:** For auto-decline and auto-accept actions, a clinician can override the decision from the review page within a configurable window (default: 24 hours).
- **AC4:** Overrides are logged in the audit trail with the clinician's ID and reason.

### 2.4. As a System, I want to automatically request missing information from the referrer, so that incomplete referrals are resolved without clinician involvement.

- **AC1:** When a skill triggers "request additional information," the system generates an outbound message to the referrer specifying the missing items (derived from the skill instructions and clinical data).
- **AC2:** The referral transitions to a new "Pending-Information" state and does not appear in the clinician review queue.
- **AC3:** When a response arrives from the referrer for a Pending-Information referral, the system re-ingests the updated data and re-evaluates all applicable skills.
- **AC4:** If no response is received within a configurable timeout (default: 72 hours), the system either auto-declines or escalates to clinician review (configurable per skill).

### 2.5. As a System, I want to evaluate skills at the correct workflow stage, so that automation applies to the right decisions at the right time.

- **AC1:** Skills with trigger point "post-intake" evaluate after C-CDA parsing and FHIR enrichment, before the referral appears for clinician review.
- **AC2:** Skills with trigger point "post-acceptance" evaluate after a clinician (or auto-accept skill) accepts the referral, before scheduling.
- **AC3:** Skills with trigger point "encounter-complete" evaluate when the encounter is marked complete, before consult note generation.
- **AC4:** Skills at each trigger point have access to the full clinical data available at that stage (C-CDA, FHIR enrichment, skill assets, and any prior skill execution results).

### 2.6. As a Clinic Administrator, I want to see how my skills are performing, so that I can tune or retire ineffective rules.

- **AC1:** The rules admin page shows execution statistics per skill: total evaluations, match count, action count, override count, average confidence score.
- **AC2:** Each skill has an execution history view showing every referral it evaluated, with match/no-match, confidence, action taken, and any override.
- **AC3:** Skills in test mode show what actions *would* have been taken, allowing the admin to validate before activating.

---

## 3. Technical Implementation Details

### 3.1. Agent Skills Directory Structure

Each rule is a self-contained skill directory following the [Agent Skills specification](https://agentskills.io/specification):

```
skills/                                  ← project-level skills root
  payer-network-check/
    SKILL.md                             ← required: metadata + instructions
    scripts/
      lookup-payer.ts                    ← deterministic lookup (avoids AI call)
    assets/
      approved-payers.json               ← facility config maintained by admin
  missing-icd-codes/
    SKILL.md
    references/
      icd-requirements.md               ← what constitutes complete coding
  icu-bed-check/
    SKILL.md
    scripts/
      check-capacity.ts
    assets/
      bed-capacity.json
  auto-accept-complete-referrals/
    SKILL.md
  consult-note-medication-reconciliation/
    SKILL.md
```

### 3.2. SKILL.md Format

Each skill's `SKILL.md` follows the Agent Skills spec: YAML frontmatter with required `name` and `description` fields, plus custom `metadata` fields for our rules engine, followed by a markdown body with evaluation instructions.

**Example — Payer Network Check:**

```markdown
---
name: payer-network-check
description: >
  Auto-decline referrals when the patient's payer is not in the facility's
  approved payer network. Triggers at post-intake after FHIR enrichment.
metadata:
  trigger-point: post-intake
  action-type: auto-decline
  confidence-threshold: "0.9"
  priority: "1"
  is-active: "true"
  is-test-mode: "false"
---

# Payer Network Check

## When to evaluate
After C-CDA parsing and FHIR enrichment, before clinician review.

## Evaluation steps
1. Extract the patient's payer/insurance from the clinical data
2. Run `scripts/lookup-payer.ts` against `assets/approved-payers.json`
3. If the payer is found in the approved list → this rule does NOT match
4. If the payer is NOT found or cannot be determined → this rule matches

## Action on match
Auto-decline the referral with reason: "Patient's payer ({payer name})
is not in this facility's approved payer network."

## Edge cases
- If no payer information is present in the referral, flag for priority
  review instead of declining — the payer may be determinable from
  other sources
- Medicaid and Medicare variants (e.g., "Medicare Advantage") should
  match against the base program if the specific variant is not listed
```

**Example — Missing ICD Codes:**

```markdown
---
name: missing-icd-codes
description: >
  Request additional information from the referrer when the referral is
  missing ICD-10 codes for reported conditions. Triggers at post-intake.
metadata:
  trigger-point: post-intake
  action-type: request-info
  confidence-threshold: "0.8"
  priority: "2"
  is-active: "true"
  is-test-mode: "false"
  timeout-hours: "72"
  timeout-action: escalate
---

# Missing ICD Codes Check

## When to evaluate
After C-CDA parsing and FHIR enrichment, before clinician review.

## Evaluation steps
1. Review the referral's problem list and diagnostic results
2. Check whether ICD-10 codes are present for each reported condition
3. If all conditions have ICD-10 codes → this rule does NOT match
4. If one or more conditions are described only in free text without
   a corresponding ICD-10 code → this rule matches

## Action on match
Request additional information from the referrer. The request should
list the specific conditions that are missing ICD-10 codes.

## What to request
For each condition missing an ICD-10 code, include:
- The condition name as stated in the referral
- A note requesting the corresponding ICD-10 code

See [ICD requirements reference](references/icd-requirements.md) for
the facility's documentation standards.
```

**Example — Encounter-Complete Consult Routing:**

```markdown
---
name: consult-note-medication-reconciliation
description: >
  When encounter completes for a patient on 5+ medications, include an
  extended medication reconciliation section in the consult note.
  Triggers at encounter-complete.
metadata:
  trigger-point: encounter-complete
  action-type: custom-consult-routing
  confidence-threshold: "0.85"
  priority: "1"
  is-active: "true"
  is-test-mode: "false"
---

# Medication Reconciliation Consult Note Routing

## When to evaluate
When an encounter is marked complete, before consult note generation.

## Evaluation steps
1. Count the patient's active medications from the enriched clinical data
2. If the patient has 5 or more active medications → this rule matches
3. If fewer than 5 → this rule does NOT match

## Action on match
Pass the following instruction as additional context to Gemini during
consult note structuring:

"Include an extended Medication Reconciliation section in the consult
note. For each active medication, document: drug name, dosage, frequency,
indication, and whether the medication should be continued, modified,
or discontinued based on the encounter findings. Flag any potential
drug interactions."
```

### 3.3. Custom Metadata Fields

The `metadata` map in the SKILL.md frontmatter stores rules-engine-specific configuration. All values are strings per the Agent Skills spec.

| Key | Required | Description |
|---|---|---|
| `trigger-point` | Yes | One of: `post-intake`, `post-acceptance`, `encounter-complete` |
| `action-type` | Yes | One of: `auto-decline`, `request-info`, `flag-priority`, `auto-accept`, `custom-consult-routing` |
| `confidence-threshold` | Yes | Float as string, 0.0–1.0. Below this, match escalates to human review |
| `priority` | Yes | Integer as string. Lower = higher priority. Used for conflict resolution |
| `is-active` | Yes | `"true"` or `"false"` |
| `is-test-mode` | Yes | `"true"` or `"false"`. Evaluates but does not act |
| `timeout-hours` | No | For `request-info` skills. Hours before timeout (default: 72) |
| `timeout-action` | No | For `request-info` skills. `auto-decline` or `escalate` |

### 3.4. Skill Loader

A lightweight loader built into the application that follows the Agent Skills progressive disclosure pattern:

**Tier 1 — Discovery (server startup):**
1. Scan the configured skills directory (`skills/` at project root)
2. For each subdirectory containing a `SKILL.md`, parse YAML frontmatter
3. Extract `name`, `description`, and `metadata` fields
4. Store in an in-memory skill catalog: `Map<string, SkillRecord>`
5. Token cost: ~50-100 tokens per skill in catalog

**Tier 2 — Activation (trigger point reached):**
1. Filter catalog to active skills matching the current trigger point, ordered by priority
2. For each matching skill, read the full `SKILL.md` body into memory
3. Pass the skill body + clinical data + any loaded assets to Gemini for evaluation

**Tier 3 — Resources (on demand):**
1. If the skill's instructions reference `scripts/` files, execute them
2. If the skill's instructions reference `assets/` files, load them as context
3. If the skill references `references/` files, load them for additional context

**Catalog refresh:** The loader watches the skills directory for changes (file add/remove/modify) and refreshes the in-memory catalog. This means admins can edit skill files and see changes on the next referral without restarting the server.

```typescript
interface SkillRecord {
  name: string;
  description: string;
  triggerPoint: string;
  actionType: string;
  confidenceThreshold: number;
  priority: number;
  isActive: boolean;
  isTestMode: boolean;
  timeoutHours?: number;
  timeoutAction?: string;
  skillDir: string;        // absolute path to skill directory
  skillMdPath: string;     // absolute path to SKILL.md
}

interface SkillCatalog {
  skills: Map<string, SkillRecord>;
  getSkillsForTrigger(triggerPoint: string): SkillRecord[];
  refresh(): void;
}
```

### 3.5. Skill Evaluation Engine

Each skill is evaluated independently with its own Gemini call. This follows the Agent Skills model of self-contained skills and supports rules at different workflow stages.

**Evaluation flow at a given trigger point:**

```
1. skillCatalog.getSkillsForTrigger(triggerPoint) → ordered by priority
2. For each skill:
   a. Read full SKILL.md body (Tier 2)
   b. If skill has scripts/ → execute deterministic lookup (Tier 3)
      - If script resolves the condition → skip Gemini call
   c. If skill has assets/ → load asset files as context (Tier 3)
   d. Build Gemini prompt:
      - System: "You are a clinical rules evaluator..."
      - Skill instructions (the SKILL.md body)
      - Clinical data (from referral record)
      - Asset contents (if loaded)
      - Prior skill results (from earlier skills in this evaluation)
   e. Call Gemini → returns { matched, confidence, explanation }
   f. Log execution record to DB
   g. If matched AND confidence ≥ threshold AND not test mode → queue action
   h. If matched AND confidence < threshold → queue flag-priority instead
3. Conflict resolution on queued actions:
   - Restriction order: auto-decline > request-info > flag-priority > custom-consult-routing > auto-accept
   - If multiple skills match, the most restrictive action wins
4. Execute the winning action (or no-op if no skills matched)
```

### 3.6. Gemini Prompt Structure

```
You are a clinical rules evaluator for a health center referral system.
You are evaluating a single automation rule against an incoming referral.

RULE INSTRUCTIONS:
{full SKILL.md body content}

REFERRAL DATA:
- Patient: {name}, DOB: {dob}, Gender: {gender}
- Reason for Referral: {reason}
- Problems: {problems list with sources}
- Medications: {medications list with sources}
- Allergies: {allergies list with sources}
- Diagnostic Results: {diagnosticResults list with sources}
- Encounters: {encounters list}
- Payer: {payer if available}

{if assets loaded:}
FACILITY CONFIGURATION:
{asset file contents}

{if prior results:}
PRIOR RULE RESULTS (this referral):
{results from higher-priority skills evaluated earlier}

Follow the evaluation steps in the rule instructions above.
Respond in JSON:
{
  "matched": true/false,
  "confidence": 0.0-1.0,
  "explanation": "1-2 sentence explanation of why this referral does or does not match the rule"
}
```

### 3.7. AI-Assisted Skill Generation

When an admin creates a new rule through the UI, the system calls Gemini to generate the skill directory:

**Input from admin:**
- Rule description in plain English (e.g., "Decline referrals where the patient's payer is not in our approved list")
- Action type (e.g., auto-decline)
- Trigger point (e.g., post-intake)
- Confidence threshold (e.g., 0.9)
- Priority (e.g., 1)

**Gemini generation prompt:**

```
You are generating an Agent Skill for a health center referral automation system.

The administrator wants this rule:
"{admin's plain English description}"

Action: {action type}
Trigger: {trigger point}

Generate the following:

1. A SKILL.md file with proper YAML frontmatter (name, description, metadata)
   and a markdown body with:
   - "When to evaluate" section
   - "Evaluation steps" section (numbered, specific)
   - "Action on match" section
   - "Edge cases" section

2. If the rule involves checking against a list or configuration data,
   also generate:
   - A scripts/{name}.ts file that performs the deterministic lookup
   - An assets/{config-name}.json template file with example entries

3. If the rule needs reference documentation, generate a
   references/{topic}.md file.

Respond in JSON:
{
  "skillName": "kebab-case-name",
  "files": {
    "SKILL.md": "...",
    "scripts/lookup.ts": "..." (optional),
    "assets/config.json": "..." (optional),
    "references/topic.md": "..." (optional)
  }
}
```

The system writes the generated files to `skills/{skillName}/`, and the skill loader picks them up on the next catalog refresh.

### 3.8. Action Implementations

**`auto-decline`**
- Calls existing `dispositionService.decline()` with `clinicianId: 'SYSTEM-SKILL-{skillName}'` and decline reason from AI explanation
- State: Acknowledged → Declined

**`request-info`**
- Generates an outbound email to the referrer listing specific missing items
- Items determined by Gemini from the skill instructions + clinical data (e.g., "Missing ICD-10 codes for reported conditions," "Payer authorization number not included")
- New outbound message type: `InfoRequest`
- State: Acknowledged → Pending-Information
- Starts timeout timer (configurable per skill via `timeout-hours` metadata)

**`flag-priority`**
- Sets a `priorityFlag` field on the referral record (new column)
- Referral remains in the clinician review queue but is visually highlighted
- Does not change state

**`auto-accept`**
- Calls existing `dispositionService.accept()` with `clinicianId: 'SYSTEM-SKILL-{skillName}'`
- State: Acknowledged → Accepted
- Triggers downstream cascade (schedule → encounter → etc.)

**`custom-consult-routing`**
- At encounter-complete trigger point, modifies the consult note generation behavior
- Skill instructions contain the routing context to pass to Gemini during note structuring (e.g., "include extended medication reconciliation")
- The routing instructions are extracted from the Gemini evaluation response and injected into the consult note pipeline

### 3.9. Execution Logging (DB)

Skill execution records are stored in the database for audit and analytics. The skill files themselves live on disk following the Agent Skills spec, but execution history is relational.

**`skill_executions` table:**

| Field | Type | Description |
|---|---|---|
| `id` | integer | Primary key |
| `skillName` | string | Skill name (matches directory name) |
| `referralId` | integer | FK to referral |
| `triggerPoint` | string | Which workflow stage triggered this evaluation |
| `matched` | boolean | Whether the skill condition was met |
| `confidence` | float | AI confidence score (0.0–1.0) |
| `actionTaken` | string? | The action executed (null if no match, test mode, or below threshold) |
| `explanation` | text | 1-2 sentence AI explanation |
| `wasOverridden` | boolean | Whether a clinician later overrode this action |
| `overriddenBy` | string? | Clinician ID who overrode |
| `overrideReason` | string? | |
| `executedAt` | timestamp | |

### 3.10. New Referral State: Pending-Information

Added to the state machine:

```
Acknowledged → Pending-Information → Acknowledged (when info arrives)
Pending-Information → Declined (on timeout with auto-decline action)
```

When a response arrives from the referrer for a Pending-Information referral:
1. Match inbound email to the referral via `sourceMessageId` or referrer address + patient name
2. Re-parse the updated C-CDA (if attached) or extract info from email body
3. Re-run FHIR enrichment
4. Transition back to Acknowledged
5. Re-evaluate all post-intake skills on the updated data

### 3.11. Clinician Override

For referrals that were auto-actioned by a skill:
- The review page shows a banner: "This referral was [action] by skill '[name]': [explanation]"
- An "Override" button allows the clinician to reverse the action within a configurable window (default: 24 hours)
- Override reverses the state transition (e.g., Declined → Acknowledged) and logs the override in the skill execution record
- After the override window, the action is final

### 3.12. Timeout Handling for Pending-Information

A background job (similar to the existing overdue message checker) runs on a configurable interval:
1. Query all referrals in Pending-Information state
2. For each, look up the skill that triggered the info request (from `skill_executions`)
3. Read the skill's `timeout-hours` and `timeout-action` from metadata
4. If the timeout has elapsed since the info request was sent:
   - `auto-decline`: decline the referral with reason "No response to information request within {hours} hours"
   - `escalate`: transition back to Acknowledged and flag for priority review

---

## 4. UI Design

### 4.1. Rules Admin Page (`/rules/admin`)

**Header:** "Automation Rules" with a "Create Rule" button.

**Skills Table:**
| Priority | Name | Trigger | Action | Confidence | Status | Executions | Match Rate | Actions |
|----------|------|---------|--------|------------|--------|------------|------------|---------|
| 1 | payer-network-check | Post-Intake | Auto-Decline | 0.9 | Active | 47 | 38% | Edit / Toggle / History |
| 2 | missing-icd-codes | Post-Intake | Request Info | 0.8 | Test Mode | 12 | 67% | Edit / Toggle / History |
| 3 | icu-bed-check | Post-Intake | Flag Priority | 0.85 | Inactive | 0 | — | Edit / Toggle / History |

**Create Rule Form (AI-assisted):**
- Description (large text area — plain English rule description)
- Trigger Point (dropdown: Post-Intake, Post-Acceptance, Encounter-Complete)
- Action Type (dropdown: Auto-Decline, Request Info, Flag Priority, Auto-Accept, Custom Consult Routing)
- Confidence Threshold (slider, 0.5–1.0, default 0.85)
- Priority (number input)
- Timeout settings (shown for Request Info actions only)
- **[Generate Skill]** button → calls Gemini to produce the skill directory
- Preview panel shows the generated `SKILL.md` for review before saving
- **[Save & Activate]** or **[Save as Test Mode]** buttons

**Edit Skill View:**
- Read-only view of `SKILL.md` content (or editable for advanced users)
- Inline editor for asset files (e.g., edit the approved payers list)
- Active / Test Mode / Inactive toggle
- Priority and confidence threshold sliders

### 4.2. Skill Asset Editor

Accessible from the edit view of any skill that has `assets/`. Renders each JSON asset file as an editable list or key-value editor.

Example for `payer-network-check/assets/approved-payers.json`:
```
Approved Payers:
  [x] Blue Cross Blue Shield
  [x] Aetna
  [x] Cigna
  [x] Medicare
  [x] Medicaid
  [ + Add payer... ]
```

Changes are written directly to the asset file in the skill directory.

### 4.3. Skill Execution History (`/rules/:name/history`)

Table of every evaluation for a specific skill:
| Referral | Patient | Date | Matched | Confidence | Action | Overridden | Explanation |
|----------|---------|------|---------|------------|--------|------------|-------------|
| #12 | Michael Kihn | Mar 24 | Yes | 0.95 | Auto-Declined | No | Patient's payer (United Health) is not in the approved payer list. |
| #13 | Sarah Jones | Mar 24 | No | 0.15 | — | — | Patient's payer (Blue Cross) is in the approved list. |

### 4.4. Referral Review Page Updates

When a skill has acted on a referral, a banner appears above the clinical data:

```
⚙ Skill Action: "payer-network-check" auto-declined this referral.
"Patient's payer (United Health) is not in the facility's approved payer list."
[Override Decision]  (available for 24 hours)
```

For test-mode skills, a subtle info banner:
```
ℹ Test Skill: "missing-icd-codes" would have requested additional information.
"Referral is missing ICD-10 codes for 3 of 6 reported conditions."
```

---

## 5. Dependencies

| Package | Purpose | Status |
|---|---|---|
| `@google/generative-ai` | Gemini API for skill evaluation and generation | Already installed |
| `js-yaml` | Parse SKILL.md YAML frontmatter | New |
| `chokidar` | Watch skills directory for changes (catalog refresh) | New |

---

## 6. Test Plan

### Unit Tests
- **Skill loader:** Discovers skill directories, parses SKILL.md frontmatter, builds catalog. Handles malformed YAML gracefully.
- **Skill evaluation:** Mock Gemini responses → verify match/no-match, confidence thresholds, action selection.
- **Script execution:** Deterministic lookup scripts resolve conditions without Gemini call.
- **Conflict resolution:** Multiple skills match → most restrictive action wins. Priority ordering respected.
- **Action execution:** Each action type correctly triggers the right downstream function (decline, request-info email, flag, accept, consult routing).
- **Skill generation:** Mock Gemini generation response → verify skill directory created with correct structure.
- **Timeout handling:** Pending-Information referral past timeout → correct timeout action fires.
- **Override:** Clinician override reverses state, logs audit trail.

### Integration Tests
- Full intake flow: referral arrives → skill auto-declines → review page shows skill banner → clinician overrides → referral returns to Acknowledged.
- Request-info flow: referral arrives → skill requests info → state becomes Pending-Information → response arrives → re-ingestion → skills re-evaluate.
- Test mode: skill matches → no action taken → execution history shows "would have" result.
- Skill generation: admin describes rule → Gemini generates skill → skill appears in catalog → evaluates on next referral.

---

## 7. Deliverables

1. **Skill loader** — Discovers `skills/` directory, parses SKILL.md frontmatter, maintains in-memory catalog with file watching for hot reload.
2. **Skill evaluation engine** — Per-skill Gemini evaluation with progressive disclosure (Tier 1 → 2 → 3), script execution for deterministic lookups, asset loading, conflict resolution, and confidence thresholds.
3. **AI-assisted skill generator** — Gemini-powered generation of complete skill directories from admin's plain English description.
4. **Action handlers** — auto-decline, request-info (new outbound message type + Pending-Information state), flag-priority, auto-accept, custom-consult-routing.
5. **Workflow integration** — Skill evaluation hooks at post-intake, post-acceptance, and encounter-complete trigger points.
6. **Pending-Information flow** — New state, re-ingestion on response, timeout background job.
7. **DB schema extensions** — `skill_executions` table; new `Pending-Information` state in state machine; `priorityFlag` column on referrals.
8. **Rules admin UI** — AI-assisted skill creation, skill management table, asset editor, execution history and statistics.
9. **Review page updates** — Skill action banners, override button, test-mode indicators.
10. **Example skills** — 2-3 pre-built skill directories (payer-network-check, missing-icd-codes, icu-bed-check) as starter templates.
11. **Unit and integration tests** for all components.
