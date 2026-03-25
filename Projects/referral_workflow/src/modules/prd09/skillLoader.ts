/**
 * Skill Loader — PRD-09
 *
 * Discovers, parses, and catalogs Agent Skill directories.
 * Each skill is a directory containing a SKILL.md file with YAML frontmatter.
 * Follows progressive disclosure: Tier 1 (name+description) at startup,
 * Tier 2 (full body) on activation, Tier 3 (scripts/assets) on demand.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { config } from '../../config';

// ── Types ────────────────────────────────────────────────────────────────────

export type TriggerPoint = 'post-intake' | 'post-acceptance' | 'encounter-complete';
export type ActionType = 'auto-decline' | 'request-info' | 'flag-priority' | 'auto-accept' | 'custom-consult-routing';

export interface SkillRecord {
  name: string;
  description: string;
  triggerPoint: TriggerPoint;
  actionType: ActionType;
  confidenceThreshold: number;
  priority: number;
  isActive: boolean;
  isTestMode: boolean;
  timeoutHours?: number;
  timeoutAction?: 'auto-decline' | 'escalate';
  skillDir: string;       // absolute path to skill directory
  skillMdPath: string;    // absolute path to SKILL.md
}

export interface ParsedSkillMd {
  frontmatter: Record<string, unknown>;
  body: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_TRIGGER_POINTS: TriggerPoint[] = ['post-intake', 'post-acceptance', 'encounter-complete'];
const VALID_ACTION_TYPES: ActionType[] = ['auto-decline', 'request-info', 'flag-priority', 'auto-accept', 'custom-consult-routing'];
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);
const MAX_DEPTH = 2;

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a SKILL.md file — extract YAML frontmatter and markdown body.
 */
export function parseSkillMd(filePath: string): ParsedSkillMd | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!fmMatch) {
      console.warn(`[SkillLoader] No frontmatter found in ${filePath}`);
      return null;
    }

    const frontmatter = yaml.load(fmMatch[1]) as Record<string, unknown>;
    const body = fmMatch[2].trim();

    if (!frontmatter || typeof frontmatter !== 'object') {
      console.warn(`[SkillLoader] Invalid YAML frontmatter in ${filePath}`);
      return null;
    }

    return { frontmatter, body };
  } catch (err) {
    console.warn(`[SkillLoader] Failed to parse ${filePath}:`, err);
    return null;
  }
}

/**
 * Convert parsed frontmatter to a SkillRecord.
 */
function frontmatterToRecord(
  parsed: ParsedSkillMd,
  skillDir: string,
  skillMdPath: string,
): SkillRecord | null {
  const fm = parsed.frontmatter;
  const metadata = (fm.metadata ?? fm) as Record<string, unknown>;

  const name = (fm.name as string) ?? path.basename(skillDir);
  const description = fm.description as string | undefined;

  if (!description) {
    console.warn(`[SkillLoader] Skill at ${skillDir} missing description — skipping`);
    return null;
  }

  // Extract trigger/action from metadata block or top-level
  const triggerPoint = (metadata['trigger-point'] ?? metadata.triggerPoint ?? fm['trigger-point']) as string | undefined;
  const actionType = (metadata['action-type'] ?? metadata.actionType ?? fm['action-type']) as string | undefined;

  if (!triggerPoint || !VALID_TRIGGER_POINTS.includes(triggerPoint as TriggerPoint)) {
    console.warn(`[SkillLoader] Skill "${name}" has invalid trigger-point "${triggerPoint}" — skipping`);
    return null;
  }

  if (!actionType || !VALID_ACTION_TYPES.includes(actionType as ActionType)) {
    console.warn(`[SkillLoader] Skill "${name}" has invalid action-type "${actionType}" — skipping`);
    return null;
  }

  // Warn if name doesn't match directory name
  const dirName = path.basename(skillDir);
  if (name !== dirName) {
    console.warn(`[SkillLoader] Skill name "${name}" doesn't match directory "${dirName}"`);
  }

  return {
    name,
    description,
    triggerPoint: triggerPoint as TriggerPoint,
    actionType: actionType as ActionType,
    confidenceThreshold: Number(metadata['confidence-threshold'] ?? metadata.confidenceThreshold ?? 0.8),
    priority: Number(metadata.priority ?? 100),
    isActive: metadata.active !== false && metadata.status !== 'inactive',
    isTestMode: metadata['test-mode'] === true || metadata.testMode === true || metadata.status === 'test',
    timeoutHours: metadata['timeout-hours'] != null ? Number(metadata['timeout-hours']) : undefined,
    timeoutAction: (metadata['timeout-action'] as 'auto-decline' | 'escalate') ?? undefined,
    skillDir,
    skillMdPath,
  };
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Discover all skill directories under the configured root.
 */
export function discoverSkills(skillsDir: string): SkillRecord[] {
  const absDir = path.resolve(skillsDir);
  if (!fs.existsSync(absDir)) {
    console.warn(`[SkillLoader] Skills directory not found: ${absDir}`);
    return [];
  }

  const skills: SkillRecord[] = [];
  scanDir(absDir, 0, skills);
  return skills;
}

function scanDir(dir: string, depth: number, results: SkillRecord[]): void {
  if (depth > MAX_DEPTH) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Check if this directory itself has a SKILL.md
  const skillMdPath = path.join(dir, 'SKILL.md');
  if (fs.existsSync(skillMdPath)) {
    const parsed = parseSkillMd(skillMdPath);
    if (parsed) {
      const record = frontmatterToRecord(parsed, dir, skillMdPath);
      if (record) {
        results.push(record);
      }
    }
    return; // Don't recurse into skill directories
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      scanDir(path.join(dir, entry.name), depth + 1, results);
    }
  }
}

// ── Catalog ──────────────────────────────────────────────────────────────────

export interface SkillCatalog {
  skills: Map<string, SkillRecord>;
  getSkillsForTrigger(triggerPoint: TriggerPoint): SkillRecord[];
  getSkill(name: string): SkillRecord | undefined;
  refresh(): void;
}

let catalogSingleton: SkillCatalog | null = null;

function buildCatalog(skillsDir: string): SkillCatalog {
  const skillsMap = new Map<string, SkillRecord>();

  function load() {
    skillsMap.clear();
    const discovered = discoverSkills(skillsDir);
    for (const skill of discovered) {
      if (skillsMap.has(skill.name)) {
        console.warn(`[SkillLoader] Duplicate skill name "${skill.name}" — keeping first`);
        continue;
      }
      skillsMap.set(skill.name, skill);
    }
    console.log(`[SkillLoader] Loaded ${skillsMap.size} skill(s) from ${skillsDir}`);
  }

  load();

  return {
    skills: skillsMap,
    getSkillsForTrigger(triggerPoint: TriggerPoint): SkillRecord[] {
      return Array.from(skillsMap.values())
        .filter((s) => s.triggerPoint === triggerPoint && (s.isActive || s.isTestMode))
        .sort((a, b) => a.priority - b.priority);
    },
    getSkill(name: string): SkillRecord | undefined {
      return skillsMap.get(name);
    },
    refresh() {
      load();
    },
  };
}

/**
 * Build and return the skill catalog singleton.
 */
export function getSkillCatalog(): SkillCatalog {
  if (!catalogSingleton) {
    catalogSingleton = buildCatalog(config.skills.dir);
  }
  return catalogSingleton;
}

/**
 * Reset the catalog singleton (for testing).
 */
export function resetCatalog(): void {
  catalogSingleton = null;
}

// ── File Watcher ─────────────────────────────────────────────────────────────

let watcherStarted = false;

/**
 * Start watching for skill file changes (call on server startup).
 */
export function startSkillWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;

  // Dynamic import to avoid loading chokidar at test time
  import('chokidar').then(({ default: chokidar }) => {
    const skillsDir = path.resolve(config.skills.dir);
    if (!fs.existsSync(skillsDir)) {
      console.warn(`[SkillLoader] Skills directory not found for watcher: ${skillsDir}`);
      return;
    }

    const watcher = chokidar.watch(path.join(skillsDir, '**/SKILL.md'), {
      ignoreInitial: true,
      persistent: true,
    });

    watcher.on('all', (event: string, filePath: string) => {
      console.log(`[SkillLoader] Detected ${event} on ${filePath} — refreshing catalog`);
      getSkillCatalog().refresh();
    });

    console.log(`[SkillLoader] Watching ${skillsDir} for skill changes`);
  }).catch((err) => {
    console.warn('[SkillLoader] Failed to start file watcher:', err);
  });
}

// ── Tier 2/3 Loaders ────────────────────────────────────────────────────────

/**
 * Load the full SKILL.md body (Tier 2 — on activation).
 */
export function loadSkillBody(skill: SkillRecord): string {
  const parsed = parseSkillMd(skill.skillMdPath);
  return parsed?.body ?? '';
}

/**
 * Load all asset files from a skill's assets/ directory (Tier 3 — on demand).
 * Returns a map of filename → parsed JSON content.
 */
export function loadSkillAssets(skill: SkillRecord): Record<string, unknown> {
  const assetsDir = path.join(skill.skillDir, 'assets');
  if (!fs.existsSync(assetsDir)) return {};

  const assets: Record<string, unknown> = {};
  const files = fs.readdirSync(assetsDir);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = fs.readFileSync(path.join(assetsDir, file), 'utf-8');
      assets[file] = JSON.parse(content);
    } catch (err) {
      console.warn(`[SkillLoader] Failed to parse asset ${file}:`, err);
    }
  }
  return assets;
}

/**
 * Load reference files from a skill's references/ directory (Tier 3 — on demand).
 * Returns a map of filename → text content.
 */
export function loadSkillReferences(skill: SkillRecord): Record<string, string> {
  const refsDir = path.join(skill.skillDir, 'references');
  if (!fs.existsSync(refsDir)) return {};

  const refs: Record<string, string> = {};
  const files = fs.readdirSync(refsDir);
  for (const file of files) {
    try {
      refs[file] = fs.readFileSync(path.join(refsDir, file), 'utf-8');
    } catch (err) {
      console.warn(`[SkillLoader] Failed to read reference ${file}:`, err);
    }
  }
  return refs;
}
