/**
 * Express server for clinician review UI, disposition API, and scheduler UI.
 *
 * Routes:
 *   GET  /health                        — health check
 *   GET  /referrals/:id/review          — clinician review page (PRD-02)
 *   POST /referrals/:id/disposition     — Accept or Decline action (PRD-02)
 *   GET  /scheduler/queue               — scheduling queue page (PRD-03)
 *   GET  /referrals/:id/schedule        — scheduling form page (PRD-03)
 *   POST /referrals/:id/schedule        — submit appointment (PRD-03)
 *   GET  /referrals/:id/encounter       — encounter status page (PRD-05)
 *   POST /referrals/:id/encounter       — mark encounter complete (PRD-05)
 *   GET  /referrals/:id/consult-note    — consult note form (PRD-04)
 *   POST /referrals/:id/consult-note    — generate and send consult note (PRD-04)
 *   GET  /messages                      — message history dashboard (PRD-07)
 */

import express, { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { referrals, patients, outboundMessages } from './db/schema';
import { accept, decline, ReferralNotFoundError as DispositionNotFoundError } from './modules/prd02/dispositionService';
import { getCachedAssessment } from './modules/prd02/referralService';
import { scheduleReferral, ReferralNotFoundError, SchedulingConflictError } from './modules/prd03/schedulingService';
import { getResources } from './modules/prd03/resourceCalendar';
import { markEncounterComplete, ReferralNotFoundError as EncounterNotFoundError } from './modules/prd05/encounterService';
import { generateAndSend, ReferralNotFoundError as ConsultNotFoundError } from './modules/prd04/consultNoteService';
import { InvalidStateTransitionError } from './state/referralStateMachine';
import { config } from './config';
import { skillExecutions } from './db/schema';
import { getSkillCatalog, loadSkillBody, loadSkillAssets, loadSkillReferences, parseSkillMd } from './modules/prd09/skillLoader';
import { generateSkill, writeSkillToDir } from './modules/prd09/skillGenerator';
import { desc, and } from 'drizzle-orm';

export const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Clinician review page
app.get('/referrals/:id/review', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const [referral] = await db
      .select()
      .from(referrals)
      .where(eq(referrals.id, referralId));

    if (!referral) {
      res.status(404).json({ error: 'Referral not found' });
      return;
    }

    const [patient] = await db
      .select()
      .from(patients)
      .where(eq(patients.id, referral.patientId));

    let assessment = getCachedAssessment(referralId);
    if (!assessment && referral.aiAssessment) {
      try {
        assessment = JSON.parse(referral.aiAssessment);
      } catch {
        // malformed DB value — leave as undefined
      }
    }

    // Fetch outbound messages for the timeline
    const messages = await db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.referralId, referralId));

    const templatePath = path.join(__dirname, 'views', 'referralReview.html');
    const template = fs.readFileSync(templatePath, 'utf-8');

    const pageData = {
      referralId,
      patient: patient ?? { firstName: '', lastName: '', dateOfBirth: '' },
      referral,
      assessment: assessment ?? null,
      outboundMessages: messages,
    };

    // Inject data as a JSON block the page script can read
    const html = template.replace(
      '/*__PAGE_DATA__*/',
      `window.__PAGE_DATA__ = ${JSON.stringify(pageData)};`,
    );

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// Disposition API
app.post('/referrals/:id/disposition', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const { decision, clinicianId, declineReason } = req.body as {
      decision?: string;
      clinicianId?: string;
      declineReason?: string;
    };

    if (!decision || !clinicianId) {
      res.status(400).json({ error: 'decision and clinicianId are required' });
      return;
    }

    if (decision !== 'Accept' && decision !== 'Decline') {
      res.status(400).json({ error: 'decision must be "Accept" or "Decline"' });
      return;
    }

    if (decision === 'Decline' && !declineReason) {
      res.status(400).json({ error: 'declineReason is required when decision is "Decline"' });
      return;
    }

    if (decision === 'Accept') {
      await accept(referralId, clinicianId);
    } else {
      await decline(referralId, clinicianId, declineReason!);
    }

    res.json({ success: true, decision });
  } catch (err) {
    if (err instanceof DispositionNotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof InvalidStateTransitionError) {
      res.status(409).json({ error: err.message });
    } else {
      next(err);
    }
  }
});

// ── PRD-03: Scheduler routes ──────────────────────────────────────────────────

// Scheduler queue — lists all Accepted referrals
app.get('/scheduler/queue', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await db
      .select()
      .from(referrals)
      .where(eq(referrals.state, 'Accepted'));

    const items = await Promise.all(
      rows.map(async (r) => {
        const [patient] = await db.select().from(patients).where(eq(patients.id, r.patientId));
        return { referral: r, patient: patient ?? { firstName: '', lastName: '', dateOfBirth: '' } };
      }),
    );

    const templatePath = path.join(__dirname, 'views', 'schedulerQueue.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__QUEUE_DATA__*/',
      `window.__QUEUE_DATA__ = ${JSON.stringify(items)};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// Schedule form page
app.get('/referrals/:id/schedule', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    if (!referral) {
      res.status(404).json({ error: 'Referral not found' });
      return;
    }

    const [patient] = await db.select().from(patients).where(eq(patients.id, referral.patientId));

    const templatePath = path.join(__dirname, 'views', 'scheduleAppointment.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__SCHEDULE_DATA__*/',
      `window.__SCHEDULE_DATA__ = ${JSON.stringify({
        referralId,
        patient: patient ?? { firstName: '', lastName: '', dateOfBirth: '' },
        referral,
        resources: getResources().map((r) => ({ id: r.id, name: r.name })),
      })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// Schedule appointment API
app.post('/referrals/:id/schedule', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const { appointmentDatetime, durationMinutes, locationName, scheduledProvider, resourceIds } =
      req.body as {
        appointmentDatetime?: string;
        durationMinutes?: number;
        locationName?: string;
        scheduledProvider?: string;
        resourceIds?: string[];
      };

    if (!appointmentDatetime || !locationName || !scheduledProvider) {
      res.status(400).json({ error: 'appointmentDatetime, locationName, and scheduledProvider are required' });
      return;
    }

    await scheduleReferral(referralId, {
      appointmentDatetime,
      durationMinutes: durationMinutes ?? 60,
      locationName,
      scheduledProvider,
      resourceIds,
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof ReferralNotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof SchedulingConflictError) {
      res.status(409).json({ error: err.message, conflicts: err.conflicts.map((c) => c.name) });
    } else if (err instanceof InvalidStateTransitionError) {
      res.status(409).json({ error: err.message });
    } else {
      next(err);
    }
  }
});

// ── PRD-05: Encounter routes ──────────────────────────────────────────────────

// Encounter status page
app.get('/referrals/:id/encounter', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    if (!referral) {
      res.status(404).json({ error: 'Referral not found' });
      return;
    }

    const [patient] = await db.select().from(patients).where(eq(patients.id, referral.patientId));

    const templatePath = path.join(__dirname, 'views', 'encounterAction.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__ENCOUNTER_DATA__*/',
      `window.__ENCOUNTER_DATA__ = ${JSON.stringify({
        referralId,
        patient: patient ?? { firstName: '', lastName: '', dateOfBirth: '' },
        referral,
      })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// Mark encounter complete API
app.post('/referrals/:id/encounter', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const { sendInterimUpdate } = req.body as { sendInterimUpdate?: boolean };

    await markEncounterComplete({
      referralId,
      sendInterimUpdate: sendInterimUpdate ?? true,
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof EncounterNotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof InvalidStateTransitionError) {
      res.status(409).json({ error: err.message });
    } else {
      next(err);
    }
  }
});

// ── PRD-04: Consult Note routes ───────────────────────────────────────────────

// Consult note form page
app.get('/referrals/:id/consult-note', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    if (!referral) {
      res.status(404).json({ error: 'Referral not found' });
      return;
    }

    const [patient] = await db.select().from(patients).where(eq(patients.id, referral.patientId));

    const templatePath = path.join(__dirname, 'views', 'consultNoteAction.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__CONSULT_DATA__*/',
      `window.__CONSULT_DATA__ = ${JSON.stringify({
        referralId,
        patient: patient ?? { firstName: '', lastName: '', dateOfBirth: '' },
        referral,
      })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// Generate and send consult note API
app.post('/referrals/:id/consult-note', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const { noteText } = req.body as { noteText?: string };
    if (!noteText || noteText.trim().length === 0) {
      res.status(400).json({ error: 'noteText is required' });
      return;
    }

    await generateAndSend({ referralId, noteText: noteText.trim() });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof ConsultNotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof InvalidStateTransitionError) {
      res.status(409).json({ error: err.message });
    } else {
      next(err);
    }
  }
});

// ── PRD-07: Message History dashboard ─────────────────────────────────────────

app.get('/messages', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const messages = await db.select().from(outboundMessages);

    const templatePath = path.join(__dirname, 'views', 'messageHistory.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__HISTORY_DATA__*/',
      `window.__HISTORY_DATA__ = ${JSON.stringify({ messages })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// ── PRD-09: Rules Admin routes ──────────────────────────────────────────────

// Rules admin dashboard
app.get('/rules/admin', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const catalog = getSkillCatalog();
    const skills = Array.from(catalog.skills.values());

    // Get execution stats for each skill
    const skillStats = await Promise.all(
      skills.map(async (skill) => {
        const executions = await db
          .select()
          .from(skillExecutions)
          .where(eq(skillExecutions.skillName, skill.name));
        const totalEvals = executions.length;
        const matchCount = executions.filter((e) => e.matched).length;
        const matchRate = totalEvals > 0 ? Math.round((matchCount / totalEvals) * 100) : null;
        return { ...skill, totalEvals, matchRate };
      }),
    );

    const templatePath = path.join(__dirname, 'views', 'rulesAdmin.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__RULES_DATA__*/',
      `window.__RULES_DATA__ = ${JSON.stringify({ skills: skillStats })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// Rule creation form
app.get('/rules/create', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const templatePath = path.join(__dirname, 'views', 'ruleCreate.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.send(template);
  } catch (err) {
    next(err);
  }
});

// Generate skill via Gemini
app.post('/rules/create', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { description, actionType, triggerPoint, confidenceThreshold, priority, timeoutHours, timeoutAction } =
      req.body as Record<string, unknown>;

    if (!description || !actionType || !triggerPoint) {
      res.status(400).json({ error: 'description, actionType, and triggerPoint are required' });
      return;
    }

    const generated = await generateSkill({
      description: String(description),
      actionType: actionType as 'auto-decline' | 'request-info' | 'flag-priority' | 'auto-accept' | 'custom-consult-routing',
      triggerPoint: triggerPoint as 'post-intake' | 'post-acceptance' | 'encounter-complete',
      confidenceThreshold: Number(confidenceThreshold) || 0.8,
      priority: Number(priority) || 100,
      timeoutHours: timeoutHours ? Number(timeoutHours) : undefined,
      timeoutAction: timeoutAction as 'auto-decline' | 'escalate' | undefined,
    });

    res.json({ success: true, skill: generated });
  } catch (err) {
    next(err);
  }
});

// Save generated skill to disk
app.post('/rules/save', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { skillName, files, testMode } = req.body as {
      skillName?: string;
      files?: Record<string, string>;
      testMode?: boolean;
    };

    if (!skillName || !files) {
      res.status(400).json({ error: 'skillName and files are required' });
      return;
    }

    // If test mode, update the frontmatter to set test-mode: true
    if (testMode && files['SKILL.md']) {
      files['SKILL.md'] = files['SKILL.md'].replace('test-mode: false', 'test-mode: true');
    }

    const skillDir = await writeSkillToDir({ skillName, files });
    res.json({ success: true, skillDir });
  } catch (err) {
    next(err);
  }
});

// Edit skill view
app.get('/rules/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nameParam = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const catalog = getSkillCatalog();
    const skill = catalog.getSkill(nameParam);

    if (!skill) {
      res.status(404).json({ error: `Skill "${nameParam}" not found` });
      return;
    }

    const body = loadSkillBody(skill);
    const assets = loadSkillAssets(skill);
    const references = loadSkillReferences(skill);

    const templatePath = path.join(__dirname, 'views', 'ruleEdit.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__EDIT_DATA__*/',
      `window.__EDIT_DATA__ = ${JSON.stringify({ skill, body, assets, references })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// Update skill metadata
app.put('/rules/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nameParam = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const catalog = getSkillCatalog();
    const skill = catalog.getSkill(nameParam);

    if (!skill) {
      res.status(404).json({ error: `Skill "${nameParam}" not found` });
      return;
    }

    const updates = req.body as Record<string, unknown>;
    const parsed = parseSkillMd(skill.skillMdPath);
    if (!parsed) {
      res.status(500).json({ error: 'Failed to parse SKILL.md' });
      return;
    }

    // Update metadata fields
    const metadata = (parsed.frontmatter.metadata ?? parsed.frontmatter) as Record<string, unknown>;
    if (updates.active !== undefined) metadata.active = updates.active;
    if (updates.testMode !== undefined) metadata['test-mode'] = updates.testMode;
    if (updates.priority !== undefined) metadata.priority = Number(updates.priority);
    if (updates.confidenceThreshold !== undefined) metadata['confidence-threshold'] = Number(updates.confidenceThreshold);

    // Rewrite SKILL.md
    const yaml = require('js-yaml');
    const newContent = `---\n${yaml.dump(parsed.frontmatter).trim()}\n---\n\n${parsed.body}`;
    fs.writeFileSync(skill.skillMdPath, newContent, 'utf-8');

    catalog.refresh();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Delete skill
app.delete('/rules/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nameParam = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const catalog = getSkillCatalog();
    const skill = catalog.getSkill(nameParam);

    if (!skill) {
      res.status(404).json({ error: `Skill "${nameParam}" not found` });
      return;
    }

    fs.rmSync(skill.skillDir, { recursive: true, force: true });
    catalog.refresh();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Read asset file
app.get('/rules/:name/assets/:filename', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nameParam = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
    const catalog = getSkillCatalog();
    const skill = catalog.getSkill(nameParam);

    if (!skill) {
      res.status(404).json({ error: `Skill "${nameParam}" not found` });
      return;
    }

    const assetPath = path.join(skill.skillDir, 'assets', filename);
    if (!fs.existsSync(assetPath)) {
      res.status(404).json({ error: `Asset "${filename}" not found` });
      return;
    }

    const content = fs.readFileSync(assetPath, 'utf-8');
    res.json({ content });
  } catch (err) {
    next(err);
  }
});

// Update asset file
app.put('/rules/:name/assets/:filename', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nameParam = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
    const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
    const catalog = getSkillCatalog();
    const skill = catalog.getSkill(nameParam);

    if (!skill) {
      res.status(404).json({ error: `Skill "${nameParam}" not found` });
      return;
    }

    const { content } = req.body as { content?: string };
    if (content === undefined) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const assetPath = path.join(skill.skillDir, 'assets', filename);
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, content, 'utf-8');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Execution history page
app.get('/rules/:name/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nameParam = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;

    const executions = await db
      .select()
      .from(skillExecutions)
      .where(eq(skillExecutions.skillName, nameParam))
      .orderBy(desc(skillExecutions.executedAt));

    const templatePath = path.join(__dirname, 'views', 'ruleHistory.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__HISTORY_DATA__*/',
      `window.__HISTORY_DATA__ = ${JSON.stringify({ skillName: nameParam, executions })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    next(err);
  }
});

// Execution history JSON API
app.get('/rules/:name/history.json', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const nameParam = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;

    const executions = await db
      .select()
      .from(skillExecutions)
      .where(eq(skillExecutions.skillName, nameParam))
      .orderBy(desc(skillExecutions.executedAt));

    res.json({ skillName: nameParam, executions });
  } catch (err) {
    next(err);
  }
});

// Override a skill action on a referral
app.post('/referrals/:id/override', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const { clinicianId, reason } = req.body as { clinicianId?: string; reason?: string };
    if (!clinicianId) {
      res.status(400).json({ error: 'clinicianId is required' });
      return;
    }

    // Find the most recent skill execution for this referral
    const [execution] = await db
      .select()
      .from(skillExecutions)
      .where(
        and(
          eq(skillExecutions.referralId, referralId),
        ),
      )
      .orderBy(desc(skillExecutions.executedAt));

    if (!execution) {
      res.status(404).json({ error: 'No skill execution found for this referral' });
      return;
    }

    // Check override window
    const executedTime = execution.executedAt instanceof Date
      ? execution.executedAt.getTime()
      : Number(execution.executedAt) * 1000;
    const windowMs = config.skills.overrideWindowHours * 60 * 60 * 1000;
    if (Date.now() - executedTime > windowMs) {
      res.status(409).json({ error: 'Override window has expired' });
      return;
    }

    // Mark as overridden
    await db
      .update(skillExecutions)
      .set({
        wasOverridden: true,
        overriddenBy: clinicianId,
        overrideReason: reason ?? null,
      })
      .where(eq(skillExecutions.id, execution.id));

    // If the skill auto-declined, transition back to Acknowledged
    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    if (referral && referral.state === 'Declined') {
      await db
        .update(referrals)
        .set({
          state: 'Acknowledged',
          declineReason: null,
          clinicianId: null,
          updatedAt: new Date(),
        })
        .where(eq(referrals.id, referralId));
    } else if (referral && referral.state === 'Pending-Information') {
      await db
        .update(referrals)
        .set({
          state: 'Acknowledged',
          updatedAt: new Date(),
        })
        .where(eq(referrals.id, referralId));
    }

    // Clear priority flag if it was set by a skill
    if (referral?.priorityFlag) {
      await db
        .update(referrals)
        .set({ priorityFlag: false, updatedAt: new Date() })
        .where(eq(referrals.id, referralId));
    }

    res.json({ success: true, overriddenExecution: execution.id });
  } catch (err) {
    next(err);
  }
});

// Generic error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export function startServer(): void {
  const port = config.server.port;
  app.listen(port, () => {
    console.log(`[Server] Clinician review UI running at http://localhost:${port}`);
  });
}
