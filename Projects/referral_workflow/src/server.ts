/**
 * Express server for PRD-02 clinician review UI and disposition API.
 *
 * Routes:
 *   GET  /health                        — health check
 *   GET  /referrals/:id/review          — clinician review page
 *   POST /referrals/:id/disposition     — Accept or Decline action
 */

import express, { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { referrals, patients } from './db/schema';
import { accept, decline, ReferralNotFoundError } from './modules/prd02/dispositionService';
import { getCachedAssessment } from './modules/prd02/referralService';
import { InvalidStateTransitionError } from './state/referralStateMachine';
import { config } from './config';

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

    const templatePath = path.join(__dirname, 'views', 'referralReview.html');
    const template = fs.readFileSync(templatePath, 'utf-8');

    const pageData = {
      referralId,
      patient: patient ?? { firstName: '', lastName: '', dateOfBirth: '' },
      referral,
      assessment: assessment ?? null,
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
    if (err instanceof ReferralNotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof InvalidStateTransitionError) {
      res.status(409).json({ error: err.message });
    } else {
      next(err);
    }
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
