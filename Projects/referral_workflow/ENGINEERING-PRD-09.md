# ENGINEERING-PRD-09: AI-Powered Rules Engine with Agent Skills

## 1. Overview

PRD-09 adds a skill-based rules engine that evaluates natural-language automation rules against referral data at three workflow trigger points. Each rule is an Agent Skill — a self-contained directory with a `SKILL.md` file, optional scripts, and optional assets — following the [Agent Skills specification](https://agentskills.io/specification).

The system includes:
1. **Skill loader** — discovers, parses, and catalogs skill directories
2. **Skill evaluation engine** — evaluates skills at trigger points using Gemini
3. **AI-assisted skill generator** — creates skill directories from admin's plain English
4. **Action handlers** — auto-decline, request-info, flag-priority, auto-accept, custom-consult-routing
5. **Rules admin UI** — skill management, asset editing, execution history
6. **Pending-Information flow** — new state, outbound info request, re-ingestion on response, timeout

---

## 2. New Files

```
src/modules/prd09/
  skillLoader.ts            — Discover, parse, catalog SKILL.md files
  skillEvaluator.ts         — Evaluate skills at trigger points via Gemini
  skillGenerator.ts         — AI-assisted skill directory generation
  skillActions.ts           — Execute actions (decline, request-info, flag, accept, consult-routing)
  pendingInfoChecker.ts     — Background timeout job for Pending-Information referrals
  infoRequestService.ts     — Generate and send info request outbound messages

src/views/
  rulesAdmin.html           — Rules management dashboard
  ruleCreate.html           — AI-assisted rule creation form
  ruleEdit.html             — Edit skill details + asset editor
  ruleHistory.html          — Execution history for a specific skill

skills/                     — Skills root directory (at project root)
  payer-network-check/      — Example pre-built skill
    SKILL.md
    scripts/lookup-payer.ts
    assets/approved-payers.json
  missing-icd-codes/        — Example pre-built skill
    SKILL.md
    references/icd-requirements.md

tests/unit/prd09/
  skillLoader.test.ts
  skillEvaluator.test.ts
  skillGenerator.test.ts
  skillActions.test.ts
  pendingInfoChecker.test.ts
```

### Modified Files

```
src/state/referralStateMachine.ts     — Add PENDING_INFORMATION state + transitions
src/db/schema.ts                      — Add skillExecutions table, priorityFlag column
src/modules/prd02/referralService.ts  — Hook skill evaluation after ingestReferral()
src/modules/prd02/dispositionService.ts — Hook skill evaluation after accept()
src/modules/prd05/encounterService.ts — Hook skill evaluation after markEncounterComplete()
src/server.ts                         — Add /rules/* routes
src/views/referralReview.html         — Skill action banners, override button
src/config.ts                         — Add skills directory config
.env.example                          — Add SKILLS_DIR
```

---

## 3. Config Changes

Add to `.env` / `config.ts`:

```
SKILLS_DIR=./skills
SKILL_OVERRIDE_WINDOW_HOURS=24
PENDING_INFO_TIMEOUT_HOURS=72
PENDING_INFO_CHECK_INTERVAL_MS=3600000
```

New config section:

```typescript
skills: {
  dir: string;                       // default: ./skills
  overrideWindowHours: number;       // default: 24
  pendingInfoTimeoutHours: number;   // default: 72
  pendingInfoCheckIntervalMs: number; // default: 3600000 (1 hour)
}
```

---

## 4. State Machine Changes

### New State: `PENDING_INFORMATION`

```typescript
export const ReferralState = {
  RECEIVED: 'Received',
  ACKNOWLEDGED: 'Acknowledged',
  PENDING_INFORMATION: 'Pending-Information',  // ← NEW
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  SCHEDULED: 'Scheduled',
  ENCOUNTER: 'Encounter',
  CLOSED: 'Closed',
  CLOSED_CONFIRMED: 'Closed-Confirmed',
} as const;
```

### New Transitions

```typescript
const VALID_TRANSITIONS: Record<ReferralState, ReferralState[]> = {
  [ReferralState.RECEIVED]: [ReferralState.ACKNOWLEDGED],
  [ReferralState.ACKNOWLEDGED]: [
    ReferralState.ACCEPTED,
    ReferralState.DECLINED,
    ReferralState.PENDING_INFORMATION,  // ← NEW: request-info skill action
  ],
  [ReferralState.PENDING_INFORMATION]: [
    ReferralState.ACKNOWLEDGED,         // ← NEW: info received, re-evaluate
    ReferralState.DECLINED,             // ← NEW: timeout with auto-decline
  ],
  [ReferralState.ACCEPTED]: [ReferralState.SCHEDULED],
  [ReferralState.DECLINED]: [],
  [ReferralState.SCHEDULED]: [ReferralState.ENCOUNTER],
  [ReferralState.ENCOUNTER]: [ReferralState.CLOSED],
  [ReferralState.CLOSED]: [ReferralState.CLOSED_CONFIRMED],
  [ReferralState.CLOSED_CONFIRMED]: [],
};
```

---

## 5. Schema Changes

### New Table: `skill_executions`

```typescript
export const skillExecutions = sqliteTable('skill_executions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  skillName: text('skill_name').notNull(),
  referralId: integer('referral_id').references(() => referrals.id).notNull(),
  triggerPoint: text('trigger_point').notNull(),     // 'post-intake' | 'post-acceptance' | 'encounter-complete'
  matched: integer('matched', { mode: 'boolean' }).notNull(),
  confidence: text('confidence').notNull(),           // stored as text, parsed to float
  actionTaken: text('action_taken'),                  // null if no match, test mode, or below threshold
  explanation: text('explanation').notNull(),
  wasOverridden: integer('was_overridden', { mode: 'boolean' }).notNull().default(false),
  overriddenBy: text('overridden_by'),
  overrideReason: text('override_reason'),
  executedAt: integer('executed_at', { mode: 'timestamp' }).notNull(),
});
```

### Modified Table: `referrals`

Add column:

```typescript
priorityFlag: integer('priority_flag', { mode: 'boolean' }).default(false),
```

---

## 6. Module Details

### 6.1 `skillLoader.ts`

Discovers and catalogs skill directories following the Agent Skills progressive disclosure pattern.

```typescript
export interface SkillRecord {
  name: string;
  description: string;
  triggerPoint: 'post-intake' | 'post-acceptance' | 'encounter-complete';
  actionType: 'auto-decline' | 'request-info' | 'flag-priority' | 'auto-accept' | 'custom-consult-routing';
  confidenceThreshold: number;
  priority: number;
  isActive: boolean;
  isTestMode: boolean;
  timeoutHours?: number;
  timeoutAction?: 'auto-decline' | 'escalate';
  skillDir: string;       // absolute path to skill directory
  skillMdPath: string;    // absolute path to SKILL.md
}

export interface SkillCatalog {
  skills: Map<string, SkillRecord>;
  getSkillsForTrigger(triggerPoint: string): SkillRecord[];
  refresh(): void;
}

// Discover all skill directories under the configured root
export function discoverSkills(skillsDir: string): SkillRecord[];

// Parse a single SKILL.md file — extract frontmatter + body
export function parseSkillMd(filePath: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} | null;

// Build and return the skill catalog singleton
export function getSkillCatalog(): SkillCatalog;

// Start watching for file changes (call on server startup)
export function startSkillWatcher(): void;
```

Implementation notes:
- **Discovery:** Recursively scan `config.skills.dir` for subdirectories containing `SKILL.md`. Skip `.git`, `node_modules`, etc. Max depth 2.
- **Parsing:** Split file on `---` delimiters. Parse YAML frontmatter with `js-yaml`. Extract `name`, `description`, and `metadata` fields. Everything after the closing `---` is the body (stored separately, loaded on activation — Tier 2).
- **Validation:** Warn on malformed YAML but still load if `name` and `description` are present. Skip skills missing `description`. Warn if `name` doesn't match directory name.
- **Catalog:** In-memory `Map<string, SkillRecord>` keyed by skill name. `getSkillsForTrigger()` filters by trigger point, returns sorted by priority (ascending = highest priority first), active only.
- **File watching:** Use `chokidar` to watch `config.skills.dir`. On add/change/unlink of `SKILL.md` files, call `refresh()` to rebuild the catalog.

### 6.2 `skillEvaluator.ts`

Evaluates skills at a trigger point using Gemini with progressive disclosure.

```typescript
export interface SkillEvalResult {
  skillName: string;
  matched: boolean;
  confidence: number;
  explanation: string;
  actionType: string;
  isTestMode: boolean;
}

export interface TriggerEvalResult {
  results: SkillEvalResult[];
  winningAction: SkillEvalResult | null;  // most restrictive match above threshold
}

// Evaluate all active skills for a trigger point against a referral
export async function evaluateSkills(
  triggerPoint: 'post-intake' | 'post-acceptance' | 'encounter-complete',
  referralId: number,
): Promise<TriggerEvalResult>;

// Evaluate a single skill (internal, called by evaluateSkills)
export async function evaluateSingleSkill(
  skill: SkillRecord,
  clinicalContext: string,
  priorResults: SkillEvalResult[],
): Promise<SkillEvalResult>;
```

Implementation notes:

**Evaluation flow:**
1. `getSkillCatalog().getSkillsForTrigger(triggerPoint)` → ordered by priority
2. Load referral + patient + clinicalData from DB
3. Build clinical context string (same format as claudeService.ts `buildPromptContext`)
4. For each skill:
   a. **Tier 2:** Read full `SKILL.md` body from disk
   b. **Tier 3 (scripts):** If `scripts/` exists, execute `.ts` files via `ts-node` or inline `require()`. Script receives clinical data as JSON on stdin, returns `{ resolved: boolean, matched?: boolean }` on stdout. If `resolved: true`, skip Gemini call.
   c. **Tier 3 (assets):** If `assets/` exists, load all `.json` files as context
   d. Build Gemini prompt (see Section 6.2.1)
   e. Call Gemini → parse JSON response → `{ matched, confidence, explanation }`
   f. Log to `skill_executions` table
   g. If matched and confidence ≥ threshold → add to matched list
   h. If matched and confidence < threshold → convert to `flag-priority`
5. **Conflict resolution:** Sort matched results by action restrictiveness:
   ```
   auto-decline (5) > request-info (4) > flag-priority (3) > custom-consult-routing (2) > auto-accept (1)
   ```
   Highest restrictiveness wins. If tie, higher priority (lower number) wins.
6. Return `TriggerEvalResult` with all results and the winning action

**6.2.1 Gemini Prompt:**
```
You are a clinical rules evaluator for a health center referral system.
You are evaluating a single automation rule against a referral.

RULE INSTRUCTIONS:
{SKILL.md body content}

REFERRAL DATA:
- Patient: {firstName} {lastName}, DOB: {dob}
- Reason for Referral: {reason}
- Problems: {problems with source tags}
- Medications: {medications with source tags}
- Allergies: {allergies with source tags}
- Diagnostic Results: {diagnosticResults with source tags}
- Encounters: {encounters}
- Payer: {payer or "(not available)"}

{if assets loaded:}
FACILITY CONFIGURATION:
{JSON contents of each asset file}

{if prior results:}
PRIOR RULE RESULTS (this referral):
{name: matched/not-matched, confidence, explanation for each prior skill}

Follow the evaluation steps in the rule instructions above.
Respond in JSON:
{
  "matched": true or false,
  "confidence": 0.0 to 1.0,
  "explanation": "1-2 sentence explanation"
}

Return only the JSON object with no additional text.
```

**Script execution model:**

Scripts in `scripts/` are TypeScript files that export a `check` function:

```typescript
// scripts/lookup-payer.ts
export interface CheckInput {
  clinicalData: Record<string, unknown>;
  assets: Record<string, unknown>;  // loaded asset files keyed by filename
}

export interface CheckResult {
  resolved: boolean;    // true if the script can determine match/no-match without AI
  matched?: boolean;    // only set if resolved is true
  explanation?: string; // optional explanation if resolved
}

export function check(input: CheckInput): CheckResult;
```

The evaluator loads the script via `require()`, calls `check()`, and skips the Gemini call if `resolved: true`.

### 6.3 `skillGenerator.ts`

AI-assisted generation of skill directories from admin input.

```typescript
export interface SkillGenerationInput {
  description: string;       // admin's plain English rule description
  actionType: string;
  triggerPoint: string;
  confidenceThreshold: number;
  priority: number;
  timeoutHours?: number;     // for request-info actions
  timeoutAction?: string;    // for request-info actions
}

export interface GeneratedSkill {
  skillName: string;
  files: Record<string, string>;  // relative path → file content
}

// Generate a complete skill directory from admin input
export async function generateSkill(input: SkillGenerationInput): Promise<GeneratedSkill>;

// Write generated files to the skills directory
export async function writeSkillToDir(skill: GeneratedSkill): Promise<string>;  // returns absolute path
```

Implementation notes:
- Calls Gemini with a generation prompt that includes the admin's description, action type, trigger point, and metadata values
- Gemini returns JSON with `skillName` and `files` map
- `writeSkillToDir()` creates the directory under `config.skills.dir`, writes all files
- Skill loader picks up the new skill on the next catalog refresh (or immediately via file watcher)
- Generated skill name follows Agent Skills naming: lowercase, hyphens only, max 64 chars

### 6.4 `skillActions.ts`

Executes the winning action from skill evaluation.

```typescript
export async function executeSkillAction(
  result: SkillEvalResult,
  referralId: number,
): Promise<void>;
```

Implementation per action type:

**`auto-decline`:**
```
1. Call dispositionService.decline(referralId, 'SYSTEM-SKILL-{skillName}', explanation)
2. State: Acknowledged → Declined
```

**`request-info`:**
```
1. Call infoRequestService.sendInfoRequest(referralId, explanation, skill.timeoutHours)
2. Transition state: Acknowledged → Pending-Information
3. Log outbound message (type: 'InfoRequest')
```

**`flag-priority`:**
```
1. Update referrals table: set priorityFlag = true
2. No state change — referral stays in clinician review queue
```

**`auto-accept`:**
```
1. Call dispositionService.accept(referralId, 'SYSTEM-SKILL-{skillName}')
2. State: Acknowledged → Accepted → triggers cascade
```

**`custom-consult-routing`:**
```
1. Store routing instructions in a new column or JSON field on the referral
2. consultNoteService reads these instructions and injects them into Gemini prompt
3. (This action only fires at encounter-complete trigger point)
```

### 6.5 `infoRequestService.ts`

Generates and sends outbound info request messages.

```typescript
export async function sendInfoRequest(
  referralId: number,
  explanation: string,
  missingItems: string[],
): Promise<void>;
```

Implementation:
1. Load referral from DB
2. Validate state transition: Acknowledged → Pending-Information
3. Build email body listing the missing items (derived from skill explanation)
4. Send via SMTP to `referral.referrerAddress`
5. Log to `outbound_messages` with `messageType: 'InfoRequest'`
6. Update referral state to Pending-Information
7. Fire autoAck (PRD-06, non-blocking)

### 6.6 `pendingInfoChecker.ts`

Background job for timeout handling, modeled on `prd07/overdueChecker.ts`.

```typescript
export async function checkPendingInfoTimeouts(): Promise<number>;
```

Implementation:
1. Query referrals where `state = 'Pending-Information'`
2. For each, find the `InfoRequest` outbound message in `outbound_messages`
3. Calculate elapsed time since `sentAt`
4. Look up the skill that triggered the info request from `skill_executions`
5. Read the skill's `timeout-hours` and `timeout-action` from metadata
6. If timeout exceeded:
   - `auto-decline`: call `dispositionService.decline(referralId, 'SYSTEM-TIMEOUT', reason)`
   - `escalate`: transition back to Acknowledged, set `priorityFlag = true`
7. Return count of timed-out referrals

Started on a configurable interval from the server startup (similar pattern to inbox monitor polling).

---

## 7. Workflow Integration Points

### 7.1 Post-Intake (referralService.ts)

After `ingestReferral()` creates the referral and transitions to Acknowledged:

```typescript
// existing: fire Gemini assessment in background
assessSufficiency(extended).then(...).catch(...);

// NEW: fire skill evaluation in background (non-blocking)
void evaluateSkills('post-intake', referral.id)
  .then(async (evalResult) => {
    if (evalResult.winningAction && !evalResult.winningAction.isTestMode) {
      await executeSkillAction(evalResult.winningAction, referral.id);
    }
  })
  .catch((err) => {
    console.error(`[SkillEvaluator] Post-intake evaluation failed for referral #${referral.id}:`, err);
  });
```

### 7.2 Post-Acceptance (dispositionService.ts)

After `accept()` transitions to Accepted, before firing the mock scheduler:

```typescript
// existing: fire mock scheduler (non-blocking)
void onReferralAccepted(referralId).catch(...);

// NEW: fire skill evaluation (non-blocking)
void evaluateSkills('post-acceptance', referralId)
  .then(async (evalResult) => {
    if (evalResult.winningAction && !evalResult.winningAction.isTestMode) {
      await executeSkillAction(evalResult.winningAction, referralId);
    }
  })
  .catch((err) => {
    console.error(`[SkillEvaluator] Post-acceptance evaluation failed for referral #${referralId}:`, err);
  });
```

### 7.3 Encounter-Complete (encounterService.ts)

After `markEncounterComplete()` transitions to Encounter, before firing mockEhr:

```typescript
// NEW: fire skill evaluation (non-blocking)
void evaluateSkills('encounter-complete', referralId)
  .then(async (evalResult) => {
    if (evalResult.winningAction && !evalResult.winningAction.isTestMode) {
      await executeSkillAction(evalResult.winningAction, referralId);
    }
  })
  .catch((err) => {
    console.error(`[SkillEvaluator] Encounter-complete evaluation failed for referral #${referralId}:`, err);
  });

// existing: fire mockEhr (non-blocking)
void onEncounterComplete(referralId).catch(...);
```

### 7.4 Re-Ingestion (inboxMonitor.ts)

When a message arrives for a referral in Pending-Information state:

```typescript
// In pollOnce(), after processInboundMessage():
// Check if the referrer address matches a Pending-Information referral
const pendingReferral = await findPendingReferralByReferrer(processed.referrerAddress);
if (pendingReferral) {
  // Re-ingest: re-parse CDA, re-enrich, transition back to Acknowledged
  await reIngestReferral(pendingReferral.id, processed);
  // Re-evaluate post-intake skills on the updated data
  void evaluateSkills('post-intake', pendingReferral.id)
    .then(async (evalResult) => {
      if (evalResult.winningAction && !evalResult.winningAction.isTestMode) {
        await executeSkillAction(evalResult.winningAction, pendingReferral.id);
      }
    })
    .catch(console.error);
}
```

---

## 8. Server Routes

### New Routes

| Route | Method | Purpose |
|---|---|---|
| `/rules/admin` | GET | Rules management dashboard |
| `/rules/create` | GET | AI-assisted rule creation form |
| `/rules/create` | POST | Generate skill via Gemini and write to disk |
| `/rules/:name` | GET | Edit skill view (SKILL.md + assets) |
| `/rules/:name` | PUT | Update skill metadata (active, test mode, priority, threshold) |
| `/rules/:name` | DELETE | Delete skill directory |
| `/rules/:name/assets/:filename` | GET | Read asset file contents |
| `/rules/:name/assets/:filename` | PUT | Update asset file contents |
| `/rules/:name/history` | GET | Execution history page |
| `/rules/:name/history.json` | GET | Execution history API (JSON) |
| `/referrals/:id/override` | POST | Override a skill action on a referral |

---

## 9. UI Details

### 9.1 Rules Admin Page (`rulesAdmin.html`)

Table of all discovered skills with computed stats from `skill_executions`:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Automation Rules                                    [+ Create Rule]    │
├──────┬──────────────────────┬───────────┬────────────┬────────┬────────┤
│ Pri  │ Name                 │ Trigger   │ Action     │ Status │ Stats  │
├──────┼──────────────────────┼───────────┼────────────┼────────┼────────┤
│ 1    │ payer-network-check  │ Post-Intk │ Auto-Decl  │ Active │ 47/38% │
│ 2    │ missing-icd-codes    │ Post-Intk │ Req Info   │ Test   │ 12/67% │
│ 3    │ icu-bed-check        │ Post-Intk │ Flag       │ Off    │ 0/—    │
└──────┴──────────────────────┴───────────┴────────────┴────────┴────────┘
```

Stats column: `{total evaluations}/{match rate}`. Computed via `SELECT COUNT(*), AVG(matched) FROM skill_executions WHERE skill_name = ?`.

Navigation link added to referralReview.html and the main `/messages` page.

### 9.2 Rule Creation Form (`ruleCreate.html`)

```
┌──────────────────────────────────────────────────────────────┐
│ Create Automation Rule                                       │
├──────────────────────────────────────────────────────────────┤
│ Describe your rule in plain English:                         │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Decline any referral where the patient's payer is not    │ │
│ │ in our approved payer list                               │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ Trigger Point: [Post-Intake ▾]                               │
│ Action Type:   [Auto-Decline ▾]                              │
│ Confidence:    [====●=====] 0.90                             │
│ Priority:      [1]                                           │
│                                                              │
│              [Generate Skill]                                │
│                                                              │
│ ── Generated Preview ──────────────────────────────────────  │
│ SKILL.md:                                                    │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ ---                                                      │ │
│ │ name: payer-network-check                                │ │
│ │ description: Auto-decline referrals when...              │ │
│ │ ---                                                      │ │
│ │ # Payer Network Check                                    │ │
│ │ ## Evaluation steps                                      │ │
│ │ 1. Extract the patient's payer...                        │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ Generated files: SKILL.md, scripts/lookup-payer.ts,          │
│                  assets/approved-payers.json                  │
│                                                              │
│    [Save & Activate]  [Save as Test Mode]  [Cancel]          │
└──────────────────────────────────────────────────────────────┘
```

### 9.3 Skill Edit View (`ruleEdit.html`)

Shows the skill's `SKILL.md` (read-only or editable for advanced users), metadata toggles, and an inline asset editor:

- Active / Test Mode / Inactive radio buttons
- Confidence threshold slider
- Priority number input
- Asset files rendered as editable lists (for JSON arrays) or key-value editors (for JSON objects)
- Save button writes metadata changes to the SKILL.md frontmatter and asset changes to the asset files

### 9.4 Referral Review Page Updates

When a skill has acted on a referral, a card appears between the Journey timeline and Patient Demographics:

```html
<div class="card skill-action-card">
  <h2>Automated Rule Action</h2>
  <div class="skill-banner">
    <strong>payer-network-check</strong> auto-declined this referral.
    <p class="skill-explanation">"Patient's payer (United Health) is not in the facility's approved payer list."</p>
    <p class="skill-meta">Confidence: 0.95 · Evaluated Mar 24, 2:15 PM</p>
    <button class="btn btn-override" onclick="overrideSkillAction()">Override Decision</button>
    <span class="override-window">Available for 23h 45m</span>
  </div>
</div>
```

For test-mode skills, a lighter info-style banner with no override button.

For flagged-priority referrals, a yellow highlight on the review page header.

---

## 10. Dependencies

| Package | Purpose | Status |
|---|---|---|
| `js-yaml` | Parse SKILL.md YAML frontmatter | New — install |
| `chokidar` | Watch skills directory for changes | New — install |
| `@google/generative-ai` | Gemini API for evaluation + generation | Already installed |

---

## 11. Example Pre-Built Skills

### 11.1 `payer-network-check`

```
skills/payer-network-check/
├── SKILL.md
├── scripts/
│   └── lookup-payer.ts
└── assets/
    └── approved-payers.json
```

**SKILL.md** — See PRD-09 Section 3.2 for the full content.

**scripts/lookup-payer.ts:**
```typescript
import { CheckInput, CheckResult } from '../../src/modules/prd09/skillEvaluator';

export function check(input: CheckInput): CheckResult {
  const approvedPayers = input.assets['approved-payers.json'] as string[] | undefined;
  if (!approvedPayers || approvedPayers.length === 0) {
    return { resolved: false }; // no config — let AI evaluate
  }

  // Extract payer from clinical data (look in problems, reason, or dedicated field)
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
```

**assets/approved-payers.json:**
```json
[
  "Blue Cross Blue Shield",
  "Aetna",
  "Cigna",
  "Medicare",
  "Medicaid",
  "UnitedHealthcare"
]
```

### 11.2 `missing-icd-codes`

```
skills/missing-icd-codes/
├── SKILL.md
└── references/
    └── icd-requirements.md
```

**SKILL.md** — See PRD-09 Section 3.2 for the full content.

No script (this is a contextual evaluation requiring AI judgment). The `references/icd-requirements.md` file documents the facility's documentation standards and is loaded as additional context when the skill is activated.

---

## 12. Test Plan

### Unit Tests

**`skillLoader.test.ts`:**
- Discovers skill directories with valid SKILL.md files
- Parses YAML frontmatter correctly (name, description, metadata)
- Handles malformed YAML gracefully (warns, skips)
- Filters by trigger point and returns sorted by priority
- Catalog refreshes when files change

**`skillEvaluator.test.ts`:**
- Mock Gemini responses → verify matched/not-matched, confidence parsed correctly
- Confidence below threshold → converts to flag-priority
- Script execution: resolved=true → skips Gemini call
- Script execution: resolved=false → falls through to Gemini
- Conflict resolution: multiple matches → most restrictive wins
- Test mode skills → logged but no action executed
- Execution logged to skill_executions table
- Prior results passed to subsequent skill evaluations

**`skillGenerator.test.ts`:**
- Mock Gemini generation response → verify skill directory created
- Generated SKILL.md has valid frontmatter with correct metadata
- Generated skill name follows naming conventions
- Asset templates created when applicable

**`skillActions.test.ts`:**
- auto-decline → calls dispositionService.decline() with correct clinicianId
- request-info → sends outbound message, transitions to Pending-Information
- flag-priority → sets priorityFlag on referral, no state change
- auto-accept → calls dispositionService.accept(), triggers cascade
- custom-consult-routing → stores instructions for consult note pipeline

**`pendingInfoChecker.test.ts`:**
- Identifies Pending-Information referrals past timeout
- auto-decline timeout action → declines referral
- escalate timeout action → transitions back to Acknowledged + flags priority
- Referrals within timeout window → not affected

### Integration Tests
- Full post-intake flow: referral arrives → skill auto-declines → review page shows skill banner → clinician overrides → referral returns to Acknowledged
- Request-info flow: referral arrives → skill requests info → Pending-Information state → response arrives → re-ingestion → skills re-evaluate
- Test mode: skill matches → no action taken → execution history shows "would have" result
- Skill generation: admin describes rule → Gemini generates skill → skill appears in catalog → evaluates on next referral

---

## 13. Demo Flow

1. **Start server** (`npm run dev`) — skill loader discovers 2 pre-built skills
2. **Open rules admin** (`/rules/admin`) — shows payer-network-check (active) and missing-icd-codes (test mode)
3. **Edit payer list** — add/remove payers from `assets/approved-payers.json` via inline editor
4. **Send referral** with a payer not in the approved list
5. **Post-intake skills fire:**
   - `payer-network-check` matches (confidence 0.95) → auto-declines
   - Review page shows: "payer-network-check auto-declined this referral" with override button
6. **Clinician overrides** → referral returns to Acknowledged → clinician accepts manually
7. **Send another referral** with missing ICD codes
8. **Post-intake skills fire:**
   - `missing-icd-codes` matches (test mode) → logged as "would have requested info"
   - Review page shows test-mode info banner
9. **Admin activates** `missing-icd-codes` via rules admin
10. **Send another referral** with missing ICD codes
11. **Skill requests info** → referral enters Pending-Information → outbound email sent to referrer
12. **Admin creates new rule** via the create form ("Flag any referral for patients over 80 as priority") → Gemini generates skill → skill appears in admin table
