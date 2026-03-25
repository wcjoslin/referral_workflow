/**
 * Skill Generator — PRD-09
 *
 * AI-assisted generation of Agent Skill directories from admin plain-English descriptions.
 * Calls Gemini to produce a SKILL.md and optional scripts/assets, then writes them to disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../../config';
import { getSkillCatalog } from './skillLoader';
import { TriggerPoint, ActionType } from './skillLoader';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillGenerationInput {
  description: string;       // admin's plain English rule description
  actionType: ActionType;
  triggerPoint: TriggerPoint;
  confidenceThreshold: number;
  priority: number;
  timeoutHours?: number;     // for request-info actions
  timeoutAction?: 'auto-decline' | 'escalate';
}

export interface GeneratedSkill {
  skillName: string;
  files: Record<string, string>;  // relative path → file content
}

// ── Generation ───────────────────────────────────────────────────────────────

/**
 * Generate a complete skill directory from admin input.
 */
export async function generateSkill(input: SkillGenerationInput): Promise<GeneratedSkill> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required for skill generation');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const metadataBlock = buildMetadataYaml(input);

  const prompt = `You are a developer assistant that creates Agent Skill directories for a healthcare referral automation system.

The admin wants to create an automation rule with this description:
"${input.description}"

Configuration:
- Trigger point: ${input.triggerPoint}
- Action type: ${input.actionType}
- Confidence threshold: ${input.confidenceThreshold}
- Priority: ${input.priority}
${input.timeoutHours ? `- Timeout: ${input.timeoutHours} hours (action: ${input.timeoutAction || 'auto-decline'})` : ''}

Generate a complete Agent Skill. The skill is a directory with:
1. A SKILL.md file with YAML frontmatter and markdown evaluation instructions
2. Optionally, a scripts/ directory with a TypeScript check function for deterministic evaluation
3. Optionally, an assets/ directory with JSON configuration files

The SKILL.md frontmatter MUST use this exact structure:
\`\`\`
---
name: <lowercase-hyphenated-name>
description: <one-line description>
metadata:
  trigger-point: ${input.triggerPoint}
  action-type: ${input.actionType}
  confidence-threshold: ${input.confidenceThreshold}
  priority: ${input.priority}
  active: true
  test-mode: false
${input.timeoutHours ? `  timeout-hours: ${input.timeoutHours}\n  timeout-action: ${input.timeoutAction || 'auto-decline'}` : ''}
---
\`\`\`

The SKILL.md body should contain:
- A heading with the rule name
- A "Context" section explaining when this rule applies
- An "Evaluation Steps" section with numbered steps for the AI evaluator to follow
- Each step should be specific and actionable

If the rule can be partially or fully evaluated with a deterministic script (e.g., checking a list, comparing values), generate a TypeScript script in scripts/ that exports a \`check(input: CheckInput): CheckResult\` function.

CheckInput has: { clinicalData: Record<string, unknown>, assets: Record<string, unknown> }
CheckResult has: { resolved: boolean, matched?: boolean, explanation?: string }

If the rule needs facility-specific configuration (like a list of approved items), generate a JSON file in assets/.

Respond with a JSON object:
{
  "skillName": "lowercase-hyphenated-name",
  "files": {
    "SKILL.md": "full content of the SKILL.md file",
    "scripts/some-script.ts": "full content (optional)",
    "assets/some-config.json": "full content (optional)"
  }
}

Return only the JSON object with no additional text.`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  // Strip markdown code fences
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = JSON.parse(cleaned) as GeneratedSkill;

  // Validate and sanitize
  if (!parsed.skillName || !parsed.files || !parsed.files['SKILL.md']) {
    throw new Error('Generated skill is missing required fields (skillName, files, SKILL.md)');
  }

  // Sanitize skill name: lowercase, hyphens only, max 64 chars
  parsed.skillName = parsed.skillName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

  return parsed;
}

/**
 * Write generated files to the skills directory.
 */
export async function writeSkillToDir(skill: GeneratedSkill): Promise<string> {
  const skillDir = path.resolve(config.skills.dir, skill.skillName);

  if (fs.existsSync(skillDir)) {
    throw new Error(`Skill directory already exists: ${skillDir}`);
  }

  // Create the skill directory and all subdirectories
  for (const [relPath, content] of Object.entries(skill.files)) {
    const absPath = path.join(skillDir, relPath);
    const dir = path.dirname(absPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
  }

  console.log(`[SkillGenerator] Wrote skill "${skill.skillName}" to ${skillDir}`);

  // Refresh the skill catalog
  getSkillCatalog().refresh();

  return skillDir;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildMetadataYaml(input: SkillGenerationInput): string {
  const lines = [
    `  trigger-point: ${input.triggerPoint}`,
    `  action-type: ${input.actionType}`,
    `  confidence-threshold: ${input.confidenceThreshold}`,
    `  priority: ${input.priority}`,
    '  active: true',
    '  test-mode: false',
  ];
  if (input.timeoutHours) {
    lines.push(`  timeout-hours: ${input.timeoutHours}`);
    lines.push(`  timeout-action: ${input.timeoutAction || 'auto-decline'}`);
  }
  return lines.join('\n');
}
