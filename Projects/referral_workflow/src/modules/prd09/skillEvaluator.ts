/**
 * Skill Evaluator — PRD-09
 *
 * Evaluates skills at trigger points. For each skill:
 * 1. Try deterministic script (Tier 3) — if resolved, skip AI
 * 2. Otherwise call Gemini with SKILL.md body + clinical context + assets
 * 3. Log result to skill_executions table
 *
 * Conflict resolution: most restrictive action wins.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { db } from '../../db';
import { referrals, patients, skillExecutions } from '../../db/schema';
import { eq } from 'drizzle-orm';
import {
  SkillRecord,
  TriggerPoint,
  ActionType,
  getSkillCatalog,
  loadSkillBody,
  loadSkillAssets,
  loadSkillReferences,
} from './skillLoader';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillEvalResult {
  skillName: string;
  matched: boolean;
  confidence: number;
  explanation: string;
  actionType: ActionType;
  isTestMode: boolean;
}

export interface TriggerEvalResult {
  results: SkillEvalResult[];
  winningAction: SkillEvalResult | null;
}

export interface CheckInput {
  clinicalData: Record<string, unknown>;
  assets: Record<string, unknown>;
}

export interface CheckResult {
  resolved: boolean;
  matched?: boolean;
  explanation?: string;
}

// ── Action Restrictiveness (higher = more restrictive) ───────────────────────

const ACTION_RESTRICTIVENESS: Record<ActionType, number> = {
  'auto-decline': 5,
  'request-info': 4,
  'flag-priority': 3,
  'custom-consult-routing': 2,
  'auto-accept': 1,
};

// ── Main Evaluation ──────────────────────────────────────────────────────────

/**
 * Evaluate all active skills for a trigger point against a referral.
 */
export async function evaluateSkills(
  triggerPoint: TriggerPoint,
  referralId: number,
): Promise<TriggerEvalResult> {
  const catalog = getSkillCatalog();
  const skills = catalog.getSkillsForTrigger(triggerPoint);

  if (skills.length === 0) {
    return { results: [], winningAction: null };
  }

  // Load referral + patient data
  const referral = await db.query.referrals.findFirst({
    where: eq(referrals.id, referralId),
  });
  if (!referral) {
    console.error(`[SkillEvaluator] Referral #${referralId} not found`);
    return { results: [], winningAction: null };
  }

  const patient = await db.query.patients.findFirst({
    where: eq(patients.id, referral.patientId),
  });

  // Build clinical context
  const clinicalData = referral.clinicalData ? JSON.parse(referral.clinicalData) : {};
  const clinicalContext = buildClinicalContext(referral, patient, clinicalData);

  // Evaluate each skill
  const results: SkillEvalResult[] = [];
  for (const skill of skills) {
    try {
      const result = await evaluateSingleSkill(skill, clinicalContext, clinicalData, results);
      results.push(result);

      // Log to skill_executions
      await db.insert(skillExecutions).values({
        skillName: result.skillName,
        referralId,
        triggerPoint,
        matched: result.matched,
        confidence: String(result.confidence),
        actionTaken: result.matched && !result.isTestMode && result.confidence >= skill.confidenceThreshold
          ? result.actionType
          : null,
        explanation: result.explanation,
        executedAt: new Date(),
      });
    } catch (err) {
      console.error(`[SkillEvaluator] Error evaluating skill "${skill.name}":`, err);
      results.push({
        skillName: skill.name,
        matched: false,
        confidence: 0,
        explanation: `Evaluation error: ${err instanceof Error ? err.message : String(err)}`,
        actionType: skill.actionType,
        isTestMode: skill.isTestMode,
      });
    }
  }

  // Conflict resolution: most restrictive action wins
  const matched = results.filter(
    (r) => r.matched && r.confidence >= (catalog.getSkill(r.skillName)?.confidenceThreshold ?? 0.8),
  );

  let winningAction: SkillEvalResult | null = null;
  if (matched.length > 0) {
    matched.sort((a, b) => {
      const restrictDiff = ACTION_RESTRICTIVENESS[b.actionType] - ACTION_RESTRICTIVENESS[a.actionType];
      if (restrictDiff !== 0) return restrictDiff;
      // Tie-break by priority (lower number = higher priority)
      const aPriority = catalog.getSkill(a.skillName)?.priority ?? 100;
      const bPriority = catalog.getSkill(b.skillName)?.priority ?? 100;
      return aPriority - bPriority;
    });
    winningAction = matched[0];
  }

  // If any match is below threshold, convert to flag-priority
  const belowThreshold = results.filter(
    (r) => r.matched && r.confidence < (catalog.getSkill(r.skillName)?.confidenceThreshold ?? 0.8),
  );
  if (belowThreshold.length > 0 && !winningAction) {
    // Convert the highest-confidence below-threshold match to flag-priority
    belowThreshold.sort((a, b) => b.confidence - a.confidence);
    winningAction = {
      ...belowThreshold[0],
      actionType: 'flag-priority',
      explanation: `${belowThreshold[0].explanation} (below confidence threshold — flagged for review)`,
    };
  }

  return { results, winningAction };
}

/**
 * Evaluate a single skill against clinical data.
 */
export async function evaluateSingleSkill(
  skill: SkillRecord,
  clinicalContext: string,
  clinicalData: Record<string, unknown>,
  priorResults: SkillEvalResult[],
): Promise<SkillEvalResult> {
  // Tier 3: Try deterministic script first
  const scriptResult = tryScript(skill, clinicalData);
  if (scriptResult?.resolved) {
    return {
      skillName: skill.name,
      matched: scriptResult.matched ?? false,
      confidence: scriptResult.matched ? 1.0 : 0.0, // deterministic = full confidence
      explanation: scriptResult.explanation ?? (scriptResult.matched ? 'Matched by script' : 'Not matched by script'),
      actionType: skill.actionType,
      isTestMode: skill.isTestMode,
    };
  }

  // Tier 2: Load full SKILL.md body
  const body = loadSkillBody(skill);

  // Tier 3: Load assets and references for context
  const assets = loadSkillAssets(skill);
  const references = loadSkillReferences(skill);

  // Build Gemini prompt and call
  return callGemini(skill, body, clinicalContext, assets, references, priorResults);
}

// ── Script Execution ─────────────────────────────────────────────────────────

function tryScript(skill: SkillRecord, clinicalData: Record<string, unknown>): CheckResult | null {
  const scriptsDir = path.join(skill.skillDir, 'scripts');
  if (!fs.existsSync(scriptsDir)) return null;

  const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.ts') || f.endsWith('.js'));
  if (files.length === 0) return null;

  // Execute the first script found
  const scriptPath = path.join(scriptsDir, files[0]);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const scriptModule = require(scriptPath);
    const checkFn = scriptModule.check || scriptModule.default?.check;
    if (typeof checkFn !== 'function') {
      console.warn(`[SkillEvaluator] Script ${scriptPath} has no check() export`);
      return null;
    }

    const assets = loadSkillAssets(skill);
    const input: CheckInput = { clinicalData, assets };
    return checkFn(input);
  } catch (err) {
    console.warn(`[SkillEvaluator] Script execution failed for ${scriptPath}:`, err);
    return null;
  }
}

// ── Gemini Call ──────────────────────────────────────────────────────────────

async function callGemini(
  skill: SkillRecord,
  body: string,
  clinicalContext: string,
  assets: Record<string, unknown>,
  references: Record<string, string>,
  priorResults: SkillEvalResult[],
): Promise<SkillEvalResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn(`[SkillEvaluator] GEMINI_API_KEY not set — skipping AI evaluation for "${skill.name}"`);
    return {
      skillName: skill.name,
      matched: false,
      confidence: 0,
      explanation: 'AI evaluation unavailable (no API key)',
      actionType: skill.actionType,
      isTestMode: skill.isTestMode,
    };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  let prompt = `You are a clinical rules evaluator for a health center referral system.
You are evaluating a single automation rule against a referral.

RULE INSTRUCTIONS:
${body}

REFERRAL DATA:
${clinicalContext}`;

  // Add asset context
  if (Object.keys(assets).length > 0) {
    prompt += `\n\nFACILITY CONFIGURATION:\n${JSON.stringify(assets, null, 2)}`;
  }

  // Add reference context
  if (Object.keys(references).length > 0) {
    prompt += '\n\nREFERENCE DOCUMENTS:';
    for (const [name, content] of Object.entries(references)) {
      prompt += `\n--- ${name} ---\n${content}`;
    }
  }

  // Add prior results
  if (priorResults.length > 0) {
    prompt += '\n\nPRIOR RULE RESULTS (this referral):';
    for (const r of priorResults) {
      prompt += `\n- ${r.skillName}: ${r.matched ? 'matched' : 'not matched'}, confidence ${r.confidence}, "${r.explanation}"`;
    }
  }

  prompt += `\n\nFollow the evaluation steps in the rule instructions above.
Respond in JSON:
{
  "matched": true or false,
  "confidence": 0.0 to 1.0,
  "explanation": "1-2 sentence explanation"
}

Return only the JSON object with no additional text.`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      skillName: skill.name,
      matched: Boolean(parsed.matched),
      confidence: Number(parsed.confidence) || 0,
      explanation: String(parsed.explanation || ''),
      actionType: skill.actionType,
      isTestMode: skill.isTestMode,
    };
  } catch (err) {
    console.error(`[SkillEvaluator] Gemini call failed for skill "${skill.name}":`, err);
    return {
      skillName: skill.name,
      matched: false,
      confidence: 0,
      explanation: `AI evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      actionType: skill.actionType,
      isTestMode: skill.isTestMode,
    };
  }
}

// ── Clinical Context Builder ─────────────────────────────────────────────────

function buildClinicalContext(
  referral: Record<string, unknown>,
  patient: Record<string, unknown> | null | undefined,
  clinicalData: Record<string, unknown>,
): string {
  const firstName = patient ? (patient as { firstName?: string }).firstName : 'Unknown';
  const lastName = patient ? (patient as { lastName?: string }).lastName : 'Unknown';
  const dob = patient ? (patient as { dateOfBirth?: string }).dateOfBirth : 'Unknown';

  const formatList = (items: unknown): string => {
    if (!Array.isArray(items) || items.length === 0) return '(none listed)';
    return items.map((item: unknown) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'name' in item) {
        const i = item as { name: string; source?: string; detail?: string };
        return i.detail ? `${i.name} [${i.source}] (${i.detail})` : `${i.name} [${i.source || 'unknown'}]`;
      }
      return String(item);
    }).join(', ');
  };

  const lines = [
    `Patient: ${firstName} ${lastName}, DOB: ${dob}`,
    `Reason for Referral: ${referral.reasonForReferral || '(not provided)'}`,
    `Problems: ${formatList(clinicalData.problems)}`,
    `Medications: ${formatList(clinicalData.medications)}`,
    `Allergies: ${formatList(clinicalData.allergies)}`,
    `Diagnostic Results: ${formatList(clinicalData.diagnosticResults)}`,
  ];

  // Add encounters if present (from FHIR enrichment)
  if (Array.isArray(clinicalData.encounters) && clinicalData.encounters.length > 0) {
    lines.push(`Encounters: ${formatList(clinicalData.encounters)}`);
  }

  // Add payer if present
  if (clinicalData.payer) {
    lines.push(`Payer: ${clinicalData.payer}`);
  } else {
    lines.push('Payer: (not available)');
  }

  return lines.join('\n');
}
