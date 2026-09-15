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
 *   GET  /referrals/:id/encounter        — encounter status page (PRD-05)
 *   POST /referrals/:id/encounter        — mark encounter complete (PRD-05)
 *   POST /referrals/:id/no-show          — mark no-show and notify referrer (PRD-11)
 *   POST /referrals/:id/consult          — enter Consult state (PRD-11)
 *   POST /referrals/:id/consult/resolve  — resolve consult and move to Closed (PRD-11)
 *   GET  /referrals/:id/consult-note    — consult note form (PRD-04)
 *   POST /referrals/:id/consult-note    — generate and send consult note (PRD-04)
 *   GET  /api/referrals/:id/preview      — lightweight preview data for dashboard expand row
 *   GET  /messages                      — message history dashboard (PRD-07)
 *   GET  /claims                        — claims attachment queue (claims intake)
 *   GET  /claims/:id                    — claims request detail + sign UI
 *   POST /claims/:id/sign               — sign and embed provider info
 *   POST /claims/:id/send               — build 275 and send
 */

import express, { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { eq, inArray } from 'drizzle-orm';
import { db } from './db';
import { referrals, patients, outboundMessages, attachmentRequests, attachmentResponses, priorAuthRequests, referralMessages } from './db/schema';
import { accept, decline, ReferralNotFoundError as DispositionNotFoundError } from './modules/prd02/dispositionService';
import { getCachedAssessment } from './modules/prd02/referralService';
import { scheduleReferral, ReferralNotFoundError, SchedulingConflictError } from './modules/prd03/schedulingService';
import { getResources, getDepartments } from './modules/prd03/resourceCalendar';
import { embedJson } from './util/htmlSafe';
import { markEncounterComplete, ReferralNotFoundError as EncounterNotFoundError } from './modules/prd05/encounterService';
import { generateAndSend, ReferralNotFoundError as ConsultNotFoundError } from './modules/prd04/consultNoteService';
import { markNoShow, ReferralNotFoundError as NoShowNotFoundError } from './modules/prd11/noShowService';
import { markConsult, resolveConsult, ReferralNotFoundError as ConsultStateNotFoundError } from './modules/prd11/consultService';
import {
  ACTING_USER_COOKIE,
  clinicianSlugFor,
  listUsers,
  tryGetActingUser,
  formatActor,
} from './modules/workspace/identityService';
import {
  backfillWorkspaces,
  proposeForReferral,
  getWorkspace,
  setWorkStatus,
  resyncWorkStatus,
  WorkspaceNotFoundError,
} from './modules/workspace/workspaceService';
import {
  OwnerFilter,
  buildWorkspacePayload,
  listWorkspaceRows,
  workspaceIdForReferral,
} from './modules/workspace/workspaceView';
import {
  OwnerNotFoundError,
  OwnershipConflictError,
  ReleaseReasonRequiredError,
  WorkspaceArchivedError,
  WorkspaceNotFoundError as AssignmentWorkspaceNotFoundError,
  assignOwner,
  claimOwnership,
  getMyWork,
  releaseOwnership,
} from './modules/workspace/assignmentService';
import {
  AddressAlreadyClaimedError,
  NoDirectAddressError,
  PartyNotFoundError,
  backfillParties,
  getParties,
  isProtocolMode,
  setProtocolMode,
  updateParty,
} from './modules/workspace/partyService';
import {
  CannotRemoveOwnerError,
  ParticipantUserNotFoundError,
  WorkspaceNotFoundError as ParticipantWorkspaceNotFoundError,
  addParticipant,
  getParticipants,
  isParticipantRole,
  removeParticipant,
} from './modules/workspace/participantService';
import {
  InvitationExpiredError,
  InvitationAlreadyAcceptedError,
  InvitationNotFoundError,
  InvitationRevokedError,
  PartyNotOnWorkspaceError,
  acceptInvitation,
  createInvitation,
  listInvitations,
  reissueInvitation,
  revokeInvitation,
} from './modules/workspace/invitationService';
import { randomUUID } from 'crypto';
import { emitEvent } from './modules/analytics/eventService';
import {
  GUEST_SESSION_COOKIE,
  GuestContext,
  GuestAccessRevokedError,
  GuestScopeMismatchError,
  GuestSessionExpiredError,
  GuestSessionMissingError,
  buildGuestPayload,
  formatGuestActor,
  guestCookiePresent,
  requireGuest,
} from './modules/workspace/guestAccess';
import {
  AssertionNotAvailableError,
  AssertionNotPermittedError,
  AssertionWorkspaceNotFoundError,
  MissingAssertionContextError,
  PartyNotOnWorkspaceError as AssertionPartyNotOnWorkspaceError,
  assertionsAvailableFor,
  getAssertions,
  submitAssertion,
  transmitPending,
} from './modules/workspace/protocolGateway';
import { isAssertionType } from './modules/workspace/assertionCatalog';
import {
  InvalidWorkStatusTransitionError,
  allowedTransitions,
  isValidState as isValidWorkStatus,
} from './state/workStatusMachine';
import { InvalidStateTransitionError, ReferralState, transition as referralTransition } from './state/referralStateMachine';
import { InvalidClaimsStateTransitionError } from './state/claimsStateMachine';
import { InvalidPriorAuthStateTransitionError } from './state/priorAuthStateMachine';
import { handleMockSubmit, handleMockInquiry, handleMockSubscription } from './modules/prd12/mockPayerServer';
import {
  submitPriorAuth,
  getStatus as getPriorAuthStatus,
  handlePayerNotification,
  inquirePriorAuth,
  listPriorAuthRequests,
  getPriorAuthDetail,
  getReferralFormData,
  PriorAuthNotFoundError,
} from './modules/prd12/priorAuthService';
import { config } from './config';
import { skillExecutions } from './db/schema';
import { getSkillCatalog, loadSkillBody, loadSkillAssets, loadSkillReferences, parseSkillMd } from './modules/prd09/skillLoader';
import { generateSkill, writeSkillToDir } from './modules/prd09/skillGenerator';
import { signRequest } from './modules/claims/review/signatureService';
import { sendResponse } from './modules/claims/response/responseService';
import { desc, and } from 'drizzle-orm';
import {
  getKpis,
  getReferralStateCounts,
  getDailyIntake,
  getReferralFunnel,
  getPriorAuthOutcomes,
  getTopDenialReasons,
  getSkillMatchRates,
  getAvgStateTimings,
  getEventCount,
  getFilterOptions,
  type AnalyticsFilters,
} from './modules/analytics/analyticsQueries';
import { runAnalyticsAgent } from './modules/analytics/analyticsAgent';

export const app = express();
app.use(express.json({ type: ['application/json', 'application/fhir+json'] }));

/**
 * Internal routes refuse any request carrying a guest session cookie.
 *
 * THIS IS A MITIGATION, NOT AUTHENTICATION. The application authenticates
 * nothing: `tryGetActingUser()` falls back to the first active user when the
 * acting-user cookie is absent, so an unauthenticated caller is served as real
 * staff. That was a documented simulation while every user was internal.
 *
 * PRD-30 hands a URL to an external organization, which makes it a PHI exposure
 * — a guest who edits their path to `/workspaces/3` would otherwise be served a
 * different patient's internal workspace. This closes exactly that path: a
 * browser holding a guest session cannot reach an internal surface with it.
 *
 * It does NOT stop an unauthenticated stranger, and it is not meant to. PRD-20
 * owns the real boundary; deploying guest access to a publicly reachable host is
 * gated on it.
 *
 * Deliberately placed before every route so no future internal route can forget
 * it, and deliberately allowing `/guest` and `/api/guest`, which are the only
 * surfaces a guest cookie is for.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const isGuestSurface = req.path === '/health' || req.path.startsWith('/guest') || req.path.startsWith('/api/guest');
  if (isGuestSurface || !guestCookiePresent(req)) {
    next();
    return;
  }
  res.status(403);
  if (req.path.startsWith('/api/')) {
    res.json({ error: 'This session is scoped to one referral. Internal APIs are not available.' });
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.send(guestScopePage());
  }
});

// ── Vendor static assets (for @kno2/ccdaview on demo pages) ──────────────────
const nodeModulesDir = path.join(__dirname, '..', 'node_modules');
app.use('/static/ccdaview', express.static(path.join(nodeModulesDir, '@kno2', 'ccdaview', 'dist')));
app.use('/static/bootstrap', express.static(path.join(nodeModulesDir, 'bootstrap', 'dist')));
app.use('/static/jquery',    express.static(path.join(nodeModulesDir, 'jquery', 'dist')));
app.use('/static/riot',      express.static(path.join(nodeModulesDir, 'riot')));
app.use('/static/lodash',    express.static(path.join(nodeModulesDir, 'lodash')));
app.use('/static/dragula',   express.static(path.join(nodeModulesDir, 'dragula', 'dist')));

// ── Navigation ────────────────────────────────────────────────────────────────

const NAV_HTML = `<style>
:root {
  --color-nav-bg: #0d2d3a;
  --color-brand: #009aab;
  --color-brand-hover: #007d8a;
  --color-bg-page: #f0f2f5;
  --color-text: #212529;
  --color-text-muted: #6c757d;
  --color-border: #dee2e6;
  --color-card: #fff;
  --color-table-header: #f0f2f4;
  --color-badge-pending: #fff3cd;
  --color-badge-pending-text: #664d03;
  --color-badge-accepted: #d1e7dd;
  --color-badge-accepted-text: #0a3622;
  --color-badge-declined: #f8d7da;
  --color-badge-declined-text: #58151c;
  --color-priority: #dc3545;
}
</style>
<nav style="background:var(--color-nav-bg);padding:12px 24px;display:flex;gap:24px;align-items:center;position:sticky;top:0;z-index:100;box-shadow:0 2px 4px rgba(0,0,0,0.4);">
  <span style="color:#fff;font-weight:700;font-size:0.95rem;letter-spacing:0.02em;">360X Referral</span>
  <a href="/" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;margin-left:8px;">Home</a>
  <a href="/workspaces" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Workspaces</a>
  <a href="/overview" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Overview</a>
  <a href="/claims" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Claims</a>
  <a href="/prior-auth" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Prior Auth</a>
  <a href="/analytics" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Analytics</a>
  <a href="/rules/admin" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Skills</a>
  <a href="/walkthrough" style="color:#20c997;text-decoration:none;font-size:0.88rem;font-weight:600;">Walkthrough</a>
  <a href="/demo" style="color:#ffc107;text-decoration:none;font-size:0.88rem;font-weight:600;">Demo Launcher</a>
  <label style="margin-left:auto;display:flex;align-items:center;gap:6px;color:#adb5bd;font-size:0.8rem;">
    Acting as
    <select id="actingUserSelect" style="background:#12404f;color:#fff;border:1px solid #1d5a6d;border-radius:4px;padding:4px 8px;font-size:0.82rem;max-width:230px;">
      <option value="">Loading…</option>
    </select>
  </label>
</nav>
<script>
(function() {
  const path = location.pathname;
  const navLinks = document.querySelectorAll('nav a');
  navLinks.forEach((link) => {
    const href = link.getAttribute('href');
    if ((path === href) || (path.startsWith(href + '/') && href !== '/')) {
      link.style.fontWeight = 'bold';
      link.style.color = '#fff';
      link.style.textDecoration = 'underline';
    }
  });
})();

// Acting-user selector (PRD-17).
//
// Populated client-side on purpose: injectNav() is a pure string function shared
// by every view, so fetching here keeps all 21 call sites unchanged.
//
// The actingUserId cookie is NOT a credential — this dropdown is the sanctioned
// way to act as someone else. Attribution, never authorization.
(function() {
  const select = document.getElementById('actingUserSelect');
  if (!select) return;

  function currentCookieUserId() {
    const match = document.cookie.match(/(?:^|;\\s*)actingUserId=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  fetch('/api/users')
    .then((r) => r.json())
    .then((data) => {
      const users = (data && data.users) || [];
      if (!users.length) {
        select.innerHTML = '<option value="">No users seeded</option>';
        select.disabled = true;
        select.title = 'Run: npm run seed — to seed the staff roster.';
        return;
      }
      // Mirrors the server fallback: cookie value when it names a known active
      // user, otherwise the first active user by id.
      const cookieId = currentCookieUserId();
      const known = users.some((u) => String(u.id) === cookieId);
      const selectedId = known ? cookieId : String(users[0].id);
      select.innerHTML = users
        .map(function (u) {
          const label = u.displayName + ' · ' + u.jobRole;
          return '<option value="' + u.id + '"' +
            (String(u.id) === selectedId ? ' selected' : '') + '>' +
            label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
            '</option>';
        })
        .join('');
    })
    .catch(() => {
      select.innerHTML = '<option value="">Unavailable</option>';
      select.disabled = true;
    });

  select.addEventListener('change', function () {
    const userId = Number(select.value);
    if (!userId) return;
    fetch('/api/acting-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userId }),
    })
      .then((r) => r.json())
      .then((body) => {
        // Reload so page payloads that embed the acting user pick up the change.
        if (body && body.success) location.reload();
      })
      .catch(() => {});
  });
})();
</script>`;

function injectNav(html: string): string {
  return html.replace('<!--__NAV__-->', NAV_HTML);
}

// ── PRD-19 workspace route helpers ───────────────────────────────────────────

/** The `:id` path param as a positive integer, or null when it is not one. */
function parseWorkspaceId(req: Request): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The acting user as a workflow_events actor string, falling back to 'system'
 * on an install with no users seeded. `message` is trusted caller-side copy,
 * never user input.
 */
async function actingActor(req: Request): Promise<string> {
  const user = await tryGetActingUser(req);
  return user ? formatActor(user) : 'system';
}


/**
 * A standalone page for a guest who has hit something outside their scope, or
 * whose access has ended.
 *
 * Deliberately NOT wrapped in `injectNav()`. The internal nav links to the
 * dashboard, the workspace index and analytics — offering a guest a menu of
 * surfaces they cannot reach would be both confusing and a disclosure of what
 * exists. It also carries no patient detail: these pages are reachable with an
 * expired or revoked session, so they must be safe to show to somebody who is
 * no longer entitled to anything.
 */
function guestNoticePage(heading: string, message: string, hint?: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(heading)}</title>
<style>
  :root { --ink: #212529; --muted: #6c757d; --line: #dee2e6; --card: #fff; --bg: #f8f9fa; }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #e9ecef; --muted: #adb5bd; --line: #343a40; --card: #1b1e21; --bg: #121416; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
         background: var(--bg); color: var(--ink);
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
          padding: 28px; max-width: 460px; width: 100%; }
  h1 { font-size: 1.15rem; margin: 0 0 10px; }
  p { font-size: 0.9rem; line-height: 1.6; color: var(--muted); margin: 0 0 10px; }
  p:last-child { margin-bottom: 0; }
</style></head>
<body><div class="card">
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(message)}</p>
  ${hint ? `<p>${escapeHtml(hint)}</p>` : ''}
</div></body></html>`;
}

/** Shown when a guest session is used against an internal surface. */
function guestScopePage(): string {
  return guestNoticePage(
    'Not available',
    'Your access is scoped to a single referral, and this page is not part of it.',
    'Use the link from your invitation email to return to that referral.',
  );
}

/** Minimal HTML escaping for the notice pages, which interpolate no user data today. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A 404 body that matches the app's chrome instead of dumping a stack trace. */
function notFoundPage(message: string): string {
  return injectNav(
    `<meta charset="utf-8" /><title>Not found</title>
<style>
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
         background:#f0f2f5; color:#212529; }
  .box { max-width:620px; margin:64px auto; background:#fff; border:1px solid #dee2e6;
         border-radius:8px; padding:28px 32px; }
  h1 { font-size:1.2rem; margin:0 0 10px; }
  p { font-size:0.9rem; color:#6c757d; line-height:1.6; }
  code { background:#f0f2f4; padding:1px 5px; border-radius:3px; font-size:0.85rem; }
  a { color:#009aab; }
</style>
<!--__NAV__-->
<div class="box">
  <h1>Not found</h1>
  <p>${message}</p>
  <p><a href="/workspaces">&larr; All workspaces</a></p>
</div>`,
  );
}

/**
 * Resolves the clinician string to record for an action (PRD-17).
 *
 * Accepts either `userId` — what the pickers now send — or the legacy
 * free-text `clinicianId`, which keeps any older client and the direct service
 * callers working. A `userId` resolves through clinicianSlugFor(), so the four
 * seeded clinicians write exactly the historical slugs and analytics continuity
 * is preserved.
 *
 * Returns null when neither is usable, so the caller can 400.
 */
async function resolveClinicianId(body: {
  userId?: unknown;
  clinicianId?: unknown;
}): Promise<string | null> {
  const userId = Number(body.userId);
  if (Number.isInteger(userId) && userId > 0) {
    const user = (await listUsers()).find((u) => u.id === userId);
    return user ? clinicianSlugFor(user) : null;
  }
  if (typeof body.clinicianId === 'string' && body.clinicianId.trim()) {
    return body.clinicianId.trim();
  }
  return null;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

app.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const allReferrals = await db.select().from(referrals).orderBy(desc(referrals.createdAt));

    // PRD-21 AC11/AC12: the dashboard lists referrals, not workspaces, so the
    // owner has to be attached. One listing query keyed by referral id — not a
    // per-row lookup, which is already the pattern's weak point below.
    const ownerByReferral = new Map(
      (await listWorkspaceRows()).map((w) => [
        w.referralId,
        { ownerUserId: w.ownerUserId, ownerDisplayName: w.ownerDisplayName, ownerInactive: w.ownerInactive },
      ]),
    );

    const items = await Promise.all(
      allReferrals.map(async (r) => {
        const [patient] = await db.select().from(patients).where(eq(patients.id, r.patientId));
        return {
          referral: r,
          patient: patient ?? { firstName: '', lastName: '', dateOfBirth: '' },
          owner: ownerByReferral.get(r.id) ?? null,
        };
      }),
    );
    const templatePath = path.join(__dirname, 'views', 'dashboard.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__DASHBOARD_DATA__*/',
      `window.__DASHBOARD_DATA__ = ${embedJson({
        items,
        departments: getDepartments(),
        // PRD-17: the per-row clinician pickers that replaced the free-text inputs.
        users: await listUsers(),
        actingUser: await tryGetActingUser(req),
      })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    next(err);
  }
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// ── Workspaces (PRD-18) ──────────────────────────────────────────────────────

/**
 * Brings every referral's workspace into line with its protocol state: creates
 * the missing ones, re-derives the stale ones. Idempotent; also available as
 * `npm run backfill:workspaces`.
 *
 * A maintenance endpoint for the demo, not part of the workspace UI (PRD-19).
 */
app.post('/api/workspaces/backfill', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await backfillWorkspaces();
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * PRD-19 — the flat workspace index.
 *
 * Unfiltered and unscoped on purpose. PRD-20 adds queue grouping, the tab
 * vocabulary and allQueuesAccess scoping, and may replace this page outright.
 */
app.get('/workspaces', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // PRD-21: ?owner=me | unassigned. `me` is resolved here, server-side, and
    // never reaches the query layer as a string — so a shared or bookmarked
    // link cannot be made to show somebody else's work.
    const ownerParam = typeof req.query.owner === 'string' ? req.query.owner : '';
    const actor = ownerParam === 'me' ? await tryGetActingUser(req) : null;

    const owner: OwnerFilter =
      ownerParam === 'unassigned'
        ? { kind: 'unassigned' }
        : ownerParam === 'me' && actor
          ? { kind: 'user', userId: actor.id }
          : { kind: 'any' };

    // `?owner=me` with nobody seeded would otherwise silently list everything,
    // which reads as "you own all of this". Say so instead.
    const ownerFilterUnavailable = ownerParam === 'me' && !actor;

    const rows = await listWorkspaceRows(owner);
    const templatePath = path.join(__dirname, 'views', 'workspaceIndex.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__WORKSPACE_ROWS__*/',
      `window.__WORKSPACE_ROWS__ = ${embedJson(rows)};\n` +
        `window.__WORKSPACE_INDEX__ = ${embedJson({
          ownerFilter: owner.kind === 'user' ? 'me' : owner.kind === 'unassigned' ? 'unassigned' : 'any',
          actingUserId: actor?.id ?? null,
          actingUserName: actor?.displayName ?? null,
          ownerFilterUnavailable,
        })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    next(err);
  }
});

/**
 * PRD-19 — the workspace shell for one referral.
 *
 * A non-numeric or unknown id is a 404 page, not a stack trace (AC4).
 */
app.get('/workspaces/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).send(notFoundPage('That workspace id is not a number.'));
      return;
    }

    const payload = await buildWorkspacePayload(workspaceId, await tryGetActingUser(req));
    if (!payload) {
      res.status(404).send(notFoundPage(`No workspace #${workspaceId}.`));
      return;
    }

    const templatePath = path.join(__dirname, 'views', 'workspaceDetail.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__WORKSPACE_DATA__*/',
      `window.__WORKSPACE_DATA__ = ${embedJson(payload)};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    next(err);
  }
});

/** The payload behind the page, for tests and for any later client. */
app.get('/api/workspaces/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    const payload = await buildWorkspacePayload(workspaceId, await tryGetActingUser(req));
    if (!payload) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/**
 * Sets the work status by hand. Marks the workspace manual, so the protocol
 * mapping stops moving it until resync.
 *
 * NOTE there is deliberately no endpoint here that writes `referrals.state`
 * (AC8) — the 360X status changes only through protocol actions.
 */
app.post(
  '/api/workspaces/:id/work-status',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      if (workspaceId === null) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }

      const body = (req.body ?? {}) as { workStatus?: unknown; reason?: unknown };
      const requested = typeof body.workStatus === 'string' ? body.workStatus : '';
      if (!isValidWorkStatus(requested)) {
        res.status(400).json({ error: `Not a work status: ${requested || '(missing)'}` });
        return;
      }

      const workspace = await getWorkspace(workspaceId);
      if (!workspace) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
      if (workspace.archivedAt !== null) {
        res.status(409).json({ error: 'This workspace is archived and is read-only.' });
        return;
      }

      const actor = await actingActor(req);
      const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;

      // `requested` is already narrowed to WorkStatus by the isValidWorkStatus guard.
      const updated = await setWorkStatus(workspaceId, requested, actor, reason);
      res.json({ success: true, workStatus: updated.workStatus });
    } catch (err) {
      // A disallowed transition is the caller asking for something the machine
      // forbids, not a server fault — 409 with what IS reachable from here.
      if (err instanceof InvalidWorkStatusTransitionError) {
        const workspaceId = parseWorkspaceId(req);
        const workspace = workspaceId === null ? null : await getWorkspace(workspaceId);
        res.status(409).json({
          error: err.message,
          allowedWorkStatuses: workspace ? allowedTransitions(workspace.workStatus) : [],
        });
        return;
      }
      if (err instanceof WorkspaceNotFoundError) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
      next(err);
    }
  },
);

/**
 * Clears the manual hold and re-applies the protocol mapping (PRD-18's escape
 * hatch). Without this a single override would freeze the work status for the
 * life of the workspace — the UI could reach a state it cannot leave.
 */
app.post('/api/workspaces/:id/resync', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    const updated = await resyncWorkStatus(workspaceId, await actingActor(req));
    res.json({ success: true, workStatus: updated.workStatus });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    next(err);
  }
});

/**
 * PRD-21 — the one endpoint behind claim, assign, reassign and release.
 *
 * The body must carry EXACTLY ONE of `ownerUserId`, `self` or `release`. The
 * PRD's first draft encoded release as `"ownerUserId": null`, which made an
 * empty body indistinguishable from a release — a request that forgot its
 * payload would have silently unassigned the workspace. Hence the explicit
 * three-way discrimination and a 400 for anything else.
 */
app.post('/api/workspaces/:id/owner', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const body = (req.body ?? {}) as {
      ownerUserId?: unknown;
      self?: unknown;
      release?: unknown;
      reason?: unknown;
    };

    const wantsAssign = typeof body.ownerUserId === 'number';
    const wantsClaim = body.self === true;
    const wantsRelease = body.release === true;
    const chosen = [wantsAssign, wantsClaim, wantsRelease].filter(Boolean).length;

    if (chosen !== 1) {
      res.status(400).json({
        error:
          'Send exactly one of ownerUserId (number), self: true, or release: true.',
        received: Object.keys(body),
      });
      return;
    }

    // Ownership is attribution. With nobody to attribute to there is nothing
    // meaningful to record, so this refuses rather than writing `user:undefined`.
    const actor = await tryGetActingUser(req);
    if (!actor) {
      res.status(401).json({
        error: 'No acting user. Seed users before assigning ownership.',
      });
      return;
    }

    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;

    const result = wantsClaim
      ? await claimOwnership(workspaceId, actor)
      : wantsRelease
        ? await releaseOwnership(workspaceId, actor, reason)
        : await assignOwner(workspaceId, body.ownerUserId as number, actor, reason);

    res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof OwnershipConflictError) {
      res.status(409).json({
        error: err.message,
        currentOwnerUserId: err.currentOwnerUserId,
        currentOwnerDisplayName: err.currentOwnerDisplayName,
      });
      return;
    }
    if (err instanceof WorkspaceArchivedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof ReleaseReasonRequiredError) {
      res.status(422).json({ error: err.message });
      return;
    }
    if (err instanceof OwnerNotFoundError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof AssignmentWorkspaceNotFoundError) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    next(err);
  }
});

/**
 * Everything the acting user owns.
 *
 * No user id in the path or query on purpose — it is resolved server-side from
 * the acting user, so a bookmarked or shared link can never show somebody
 * else's work.
 */
app.get('/api/my-work', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = await tryGetActingUser(req);
    if (!actor) {
      res.status(401).json({ error: 'No acting user. Seed users first.' });
      return;
    }
    res.json({ actingUserId: actor.id, items: await getMyWork(actor.id) });
  } catch (err) {
    next(err);
  }
});

// ── Parties & Participants (PRD-24) ──────────────────────────────────────────

/**
 * Maps a PRD-24 service error to its status code, returning true when it
 * handled one. Shared by all six routes below: five `instanceof` chains copied
 * into five handlers is how one of them quietly ends up short a case, and a
 * missed case here is a 500 on a perfectly ordinary refusal.
 */
function sendPartyError(err: unknown, res: Response): boolean {
  if (err instanceof PartyNotFoundError || err instanceof ParticipantWorkspaceNotFoundError) {
    res.status(404).json({ error: err.message });
    return true;
  }
  // 409 rather than 400: the request was well-formed, the current state refused
  // it. A client that retries after fixing the state will succeed.
  if (err instanceof NoDirectAddressError || err instanceof AddressAlreadyClaimedError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof CannotRemoveOwnerError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof ParticipantUserNotFoundError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

/**
 * Seeds parties for workspaces that already exist. Idempotent, and re-derives
 * rather than skipping — see backfillParties() for why that distinction is the
 * whole point of this endpoint. Also `npm run backfill:parties`.
 */
app.post('/api/workspaces/backfill-parties', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, ...(await backfillParties()) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/workspaces/:id/parties', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.json({ parties: await getParties(workspaceId) });
  } catch (err) {
    next(err);
  }
});

/**
 * Edits a party's name, canonical intake address or contact.
 *
 * Note it does NOT take protocolMode: that has its own endpoint because it
 * carries its own refusal (a mode other than local-only needs an address) and
 * its own audit event. Folding them together would make one request able to
 * fail for two unrelated reasons.
 */
app.patch(
  '/api/workspaces/:id/parties/:partyId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      const partyId = Number(req.params.partyId);
      if (workspaceId === null || !Number.isInteger(partyId) || partyId <= 0) {
        res.status(404).json({ error: 'Party not found' });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: { orgName?: string; directAddress?: string; contactName?: string } = {};
      if (typeof body.orgName === 'string') patch.orgName = body.orgName;
      if (typeof body.directAddress === 'string') patch.directAddress = body.directAddress;
      if (typeof body.contactName === 'string') patch.contactName = body.contactName;

      if (Object.keys(patch).length === 0) {
        res.status(400).json({
          error: 'Send at least one of orgName, directAddress or contactName as a string.',
          received: Object.keys(body),
        });
        return;
      }

      const party = await updateParty(partyId, patch, await actingActor(req));
      res.json({ success: true, party });
    } catch (err) {
      if (!sendPartyError(err, res)) next(err);
    }
  },
);

app.post(
  '/api/workspaces/:id/parties/:partyId/protocol-mode',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      const partyId = Number(req.params.partyId);
      if (workspaceId === null || !Number.isInteger(partyId) || partyId <= 0) {
        res.status(404).json({ error: 'Party not found' });
        return;
      }

      const body = (req.body ?? {}) as { protocolMode?: unknown };
      const requested = body.protocolMode;
      if (typeof requested !== 'string' || !isProtocolMode(requested)) {
        res.status(400).json({
          error: 'protocolMode must be one of native-360x, workspace-mediated, local-only.',
          received: requested,
        });
        return;
      }

      const party = await setProtocolMode(partyId, requested, await actingActor(req));
      res.json({ success: true, party });
    } catch (err) {
      if (!sendPartyError(err, res)) next(err);
    }
  },
);

app.get(
  '/api/workspaces/:id/participants',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      if (workspaceId === null) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
      res.json({ participants: await getParticipants(workspaceId) });
    } catch (err) {
      if (!sendPartyError(err, res)) next(err);
    }
  },
);

/** Idempotent on userId: an existing participant has their role updated. */
app.post(
  '/api/workspaces/:id/participants',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      if (workspaceId === null) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }

      const body = (req.body ?? {}) as { userId?: unknown; role?: unknown };
      if (typeof body.userId !== 'number' || !Number.isInteger(body.userId)) {
        res.status(400).json({ error: 'userId must be an integer.', received: body.userId });
        return;
      }
      if (typeof body.role !== 'string' || !isParticipantRole(body.role)) {
        res.status(400).json({
          error: 'role must be one of Manager, Collaborator, Viewer.',
          received: body.role,
        });
        return;
      }

      const actor = await tryGetActingUser(req);
      if (!actor) {
        res.status(401).json({ error: 'No acting user. Seed users before adding participants.' });
        return;
      }

      const participant = await addParticipant(workspaceId, body.userId, body.role, actor);
      res.json({ success: true, participant });
    } catch (err) {
      if (!sendPartyError(err, res)) next(err);
    }
  },
);

app.delete(
  '/api/workspaces/:id/participants/:userId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      const userId = Number(req.params.userId);
      if (workspaceId === null || !Number.isInteger(userId) || userId <= 0) {
        res.status(404).json({ error: 'Participant not found' });
        return;
      }

      const actor = await tryGetActingUser(req);
      if (!actor) {
        res.status(401).json({ error: 'No acting user. Seed users first.' });
        return;
      }

      await removeParticipant(workspaceId, userId, actor);
      res.json({ success: true });
    } catch (err) {
      if (!sendPartyError(err, res)) next(err);
    }
  },
);

// ── Protocol assertions (PRD-29) ─────────────────────────────────────────────

/**
 * The party a LICENSED internal user acts for.
 *
 * Always the RECEIVING party: that is our organization on this workspace. A
 * coordinator here cannot assert on the referring organization's behalf, and
 * resolving this server-side rather than accepting a partyId is what makes that
 * true — a request body could otherwise claim to be the other side.
 */
async function internalPartyId(workspaceId: number): Promise<number | null> {
  const parties = await getParties(workspaceId);
  return parties.find((p) => p.partyRole === 'receiving')?.id ?? null;
}

/** Maps a gateway rejection to a status code. Shared so no route omits a case. */
function sendAssertionError(err: unknown, res: Response): boolean {
  if (err instanceof AssertionNotPermittedError) {
    // 403: the request was well-formed and the caller is simply not allowed.
    res.status(403).json({ error: err.message });
    return true;
  }
  if (err instanceof AssertionNotAvailableError) {
    // 409: allowed in principle, refused by the current protocol state.
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof MissingAssertionContextError) {
    res.status(400).json({ error: err.message, missing: err.missing });
    return true;
  }
  if (err instanceof InvalidStateTransitionError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (
    err instanceof AssertionWorkspaceNotFoundError ||
    err instanceof AssertionPartyNotOnWorkspaceError
  ) {
    res.status(404).json({ error: err.message });
    return true;
  }
  return false;
}

app.get(
  '/api/workspaces/:id/assertions/available',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      if (workspaceId === null) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
      res.json(await assertionsAvailableFor(workspaceId, await internalPartyId(workspaceId)));
    } catch (err) {
      if (!sendAssertionError(err, res)) next(err);
    }
  },
);

app.get('/api/workspaces/:id/assertions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.json({ assertions: await getAssertions(workspaceId) });
  } catch (err) {
    if (!sendAssertionError(err, res)) next(err);
  }
});

app.post('/api/workspaces/:id/assertions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const body = (req.body ?? {}) as {
      assertionType?: unknown;
      assertionKey?: unknown;
      context?: unknown;
    };
    if (typeof body.assertionType !== 'string' || !isAssertionType(body.assertionType)) {
      res.status(400).json({ error: 'assertionType is not a known assertion.', received: body.assertionType });
      return;
    }

    const actor = await tryGetActingUser(req);
    if (!actor) {
      res.status(401).json({ error: 'No acting user. Seed users before asserting.' });
      return;
    }

    const partyId = await internalPartyId(workspaceId);
    if (partyId === null) {
      res.status(409).json({
        error: 'This workspace has no receiving party. Run `npm run backfill:parties`.',
      });
      return;
    }

    // A caller that supplies no key gets one, so a retry without a key is not
    // silently non-idempotent — but a client that wants retry safety across a
    // dropped connection has to supply its own.
    const assertionKey =
      typeof body.assertionKey === 'string' && body.assertionKey.trim()
        ? body.assertionKey.trim()
        : randomUUID();

    const result = await submitAssertion({
      workspaceId,
      assertionKey,
      assertionType: body.assertionType,
      partyId,
      actor: formatActor(actor),
      context: (body.context ?? {}) as Record<string, unknown>,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    if (!sendAssertionError(err, res)) next(err);
  }
});

/** Transmit a previously local-only artifact. Explicit, never automatic (AC11). */
app.post(
  '/api/workspaces/:id/assertions/:assertionId/transmit',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assertionId = Number(req.params.assertionId);
      if (!Number.isInteger(assertionId) || assertionId <= 0) {
        res.status(404).json({ error: 'Assertion not found' });
        return;
      }
      res.json({ success: true, ...(await transmitPending(assertionId, await actingActor(req))) });
    } catch (err) {
      if (!sendAssertionError(err, res)) next(err);
    }
  },
);

/**
 * A GUEST making an assertion. The party comes from the SESSION, never the body
 * — that is the whole point of the guard.
 */
app.post('/api/guest/assertions', async (req: Request, res: Response) => {
  // Typed rather than inferred from the assignment below: an untyped `let` here
  // widens to `any`, and `any` flowing into submitAssertion's partyId is exactly
  // the thing the guard exists to prevent.
  let guest: GuestContext;
  try {
    guest = await requireGuest(req);
  } catch (err) {
    sendGuestDenied(err, req, res, true);
    return;
  }
  try {
    const body = (req.body ?? {}) as {
      assertionType?: unknown;
      assertionKey?: unknown;
      context?: unknown;
    };
    if (typeof body.assertionType !== 'string' || !isAssertionType(body.assertionType)) {
      res.status(400).json({ error: 'assertionType is not a known assertion.' });
      return;
    }

    const assertionKey =
      typeof body.assertionKey === 'string' && body.assertionKey.trim()
        ? body.assertionKey.trim()
        : randomUUID();

    const result = await submitAssertion({
      workspaceId: guest.workspaceId,
      assertionKey,
      assertionType: body.assertionType,
      partyId: guest.partyId,
      actor: formatGuestActor(guest),
      context: (body.context ?? {}) as Record<string, unknown>,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    if (!sendAssertionError(err, res)) {
      console.error('[Guest/Assertion]', err);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  }
});

// ── Guest participation (PRD-30) ─────────────────────────────────────────────

/**
 * Internal: invitation management. Every one of these resolves the workspace
 * from the path like any other internal route — these are staff-facing.
 */
app.get('/api/workspaces/:id/invitations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    // Status only. There is no token to return: only its hash was ever stored.
    res.json({ invitations: await listInvitations(workspaceId) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/workspaces/:id/invitations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const body = (req.body ?? {}) as { partyId?: unknown; recipientEmail?: unknown; expiresInHours?: unknown };
    if (typeof body.partyId !== 'number' || !Number.isInteger(body.partyId)) {
      res.status(400).json({ error: 'partyId must be an integer.', received: body.partyId });
      return;
    }
    // Shape-only check. Deliverability is SMTP's answer, not a regex's, and the
    // invitation survives a failed send by design.
    if (typeof body.recipientEmail !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.recipientEmail.trim())) {
      res.status(400).json({ error: 'recipientEmail must be an email address.', received: body.recipientEmail });
      return;
    }

    const actor = await tryGetActingUser(req);
    if (!actor) {
      res.status(401).json({ error: 'No acting user. Seed users before inviting.' });
      return;
    }

    const { invitation } = await createInvitation(
      workspaceId,
      body.partyId,
      body.recipientEmail.trim(),
      actor,
      typeof body.expiresInHours === 'number' ? body.expiresInHours : undefined,
    );

    // NOTE the absence of `inviteUrl`. The raw token goes to the invited
    // address and nowhere else — returning it here would put it in the
    // inviter's browser history, and from there into a screenshot.
    res.json({
      success: true,
      invitationId: invitation.id,
      expiresAt: invitation.expiresAt.toISOString(),
      emailDelivered: invitation.emailDelivered,
    });
  } catch (err) {
    if (err instanceof PartyNotOnWorkspaceError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

app.delete(
  '/api/workspaces/:id/invitations/:invitationId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invitationId = Number(req.params.invitationId);
      if (!Number.isInteger(invitationId) || invitationId <= 0) {
        res.status(404).json({ error: 'Invitation not found' });
        return;
      }
      const actor = await tryGetActingUser(req);
      if (!actor) {
        res.status(401).json({ error: 'No acting user. Seed users first.' });
        return;
      }
      await revokeInvitation(invitationId, actor);
      res.json({ success: true });
    } catch (err) {
      if (err instanceof InvitationNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
);

app.post(
  '/api/workspaces/:id/invitations/:invitationId/reissue',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invitationId = Number(req.params.invitationId);
      if (!Number.isInteger(invitationId) || invitationId <= 0) {
        res.status(404).json({ error: 'Invitation not found' });
        return;
      }
      const actor = await tryGetActingUser(req);
      if (!actor) {
        res.status(401).json({ error: 'No acting user. Seed users first.' });
        return;
      }
      const { invitation } = await reissueInvitation(invitationId, actor);
      res.json({
        success: true,
        invitationId: invitation.id,
        expiresAt: invitation.expiresAt.toISOString(),
        emailDelivered: invitation.emailDelivered,
      });
    } catch (err) {
      if (err instanceof InvitationNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  },
);

/** The guest workspace page. Takes NO id — the workspace comes from the session. */
app.get('/guest/workspace', async (req: Request, res: Response) => {
  try {
    const guest = await requireGuest(req);
    const payload = await buildGuestPayload(guest);
    if (!payload) {
      res.status(404).setHeader('Content-Type', 'text/html');
      res.send(guestNoticePage('Referral unavailable', 'This referral is no longer available.'));
      return;
    }
    const templatePath = path.join(__dirname, 'views', 'guestWorkspace.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    // No injectNav(): the internal nav links to surfaces a guest cannot reach.
    res.setHeader('Content-Type', 'text/html');
    res.send(template.replace('/*__GUEST_DATA__*/', `window.__GUEST__ = ${embedJson(payload)};`));
  } catch (err) {
    sendGuestDenied(err, req, res, false);
  }
});

app.get('/api/guest/workspace', async (req: Request, res: Response) => {
  try {
    const guest = await requireGuest(req);
    const payload = await buildGuestPayload(guest);
    if (!payload) {
      res.status(404).json({ error: 'This referral is no longer available.' });
      return;
    }
    res.json(payload);
  } catch (err) {
    sendGuestDenied(err, req, res, true);
  }
});

/**
 * Guest-facing: accept an invitation.
 *
 * The one route that takes a raw token. It sets the session cookie and redirects
 * so the token leaves the address bar immediately — a token sitting in browser
 * history, or in a Referer header on the next request, is a token leaked.
 *
 * REGISTERED AFTER `/guest/workspace` ON PURPOSE. Express matches in
 * registration order, so while this came first it also matched
 * `/guest/workspace` with `token = "workspace"`, failed the token shape check,
 * and rendered "this link is not valid" — the guest page was unreachable while
 * the guest API worked fine. The smoke check caught it; no unit test would
 * have, because route order is a property of neither handler.
 *
 * KEEP ANY FUTURE LITERAL `/guest/...` PATH ABOVE THIS HANDLER.
 */
app.get('/guest/:token', async (req: Request, res: Response) => {
  const raw = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  try {
    const accepted = await acceptInvitation(raw);

    // HttpOnly, unlike the acting-user cookie, which client script reads on
    // purpose. This one is a real credential, so script must not see it.
    // SameSite=Lax rather than Strict: Strict would withhold the cookie on a
    // top-level navigation from outside the site, signing a guest out of their
    // own bookmark. Lax still refuses cross-site POSTs.
    //
    // `Secure` is deliberately omitted because the demo runs over plain HTTP on
    // localhost and setting it would break the flow entirely. That is a
    // production gap recorded in PRD-30, on the same gate as the authentication
    // finding — not an oversight.
    const maxAge = Math.max(
      0,
      Math.floor((accepted.sessionExpiresAt.getTime() - Date.now()) / 1000),
    );
    res.setHeader(
      'Set-Cookie',
      `${GUEST_SESSION_COOKIE}=${accepted.sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    );
    res.redirect('/guest/workspace');
  } catch (err) {
    res.setHeader('Content-Type', 'text/html');
    if (err instanceof InvitationExpiredError) {
      res.status(410).send(
        guestNoticePage(
          'This invitation has expired',
          'Invitation links are time-limited, and this one has passed its expiry.',
          'Ask your contact at the referring organization to send a new invitation.',
        ),
      );
      return;
    }
    if (err instanceof InvitationRevokedError) {
      res.status(403).send(
        guestNoticePage(
          'This invitation has been withdrawn',
          'Access to this referral has been ended by the referring organization.',
          'If you think this is a mistake, contact them directly.',
        ),
      );
      return;
    }
    if (err instanceof InvitationAlreadyAcceptedError) {
      res.status(410).send(
        guestNoticePage(
          'This link has already been used',
          'Invitation links work once. If your session has since ended, the link cannot be reused.',
          'Ask your contact to re-issue the invitation.',
        ),
      );
      return;
    }
    // Unknown, malformed, or a probe. Same answer for all three, so nothing is
    // learned by guessing.
    res.status(404).send(
      guestNoticePage(
        'This link is not valid',
        'We could not match this invitation link to a referral.',
        'Check that you copied the whole link, or ask for a new invitation.',
      ),
    );
  }
});

/**
 * One place that turns a guard rejection into a response, and writes the
 * `guest_access_denied` event.
 *
 * Shared so a denial is audited identically however it was reached — a denial
 * recorded on one route and not another would make the audit trail lie by
 * omission.
 */
function sendGuestDenied(err: unknown, req: Request, res: Response, asJson: boolean): void {
  const known =
    err instanceof GuestSessionMissingError ||
    err instanceof GuestSessionExpiredError ||
    err instanceof GuestAccessRevokedError ||
    err instanceof GuestScopeMismatchError;

  if (!known) {
    console.error('[Guest]', err);
    res.status(500);
    if (asJson) res.json({ error: 'Something went wrong.' });
    else res.setHeader('Content-Type', 'text/html'), res.send(guestNoticePage('Something went wrong', 'Please try your invitation link again.'));
    return;
  }

  const status = err instanceof GuestSessionMissingError ? 401 : 403;
  const message = (err as Error).message;

  void emitEvent({
    eventType: 'workspace.guest_access_denied',
    entityType: 'referral',
    entityId: 0, // no workspace resolved — that IS the denial
    actor: 'guest:unresolved',
    metadata: { reason: (err as Error).name, path: req.path },
  }).catch((e: unknown) => console.error('[Guest]', e));

  res.status(status);
  if (asJson) {
    res.json({ error: message });
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.send(
      guestNoticePage(
        'Access ended',
        message,
        'Open the link from your invitation email again, or ask for a new invitation.',
      ),
    );
  }
}

/**
 * The C-CDA viewer as its own document, for the workspace page's iframe.
 *
 * Separate rather than inline because Sialia needs Bootstrap's CSS, and loading
 * Bootstrap into the workspace page would restyle the whole page. The iframe is
 * the CSS boundary.
 */
app.get('/referrals/:id/ccda-frame', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(raw, 10);
    if (!Number.isInteger(referralId) || referralId <= 0) {
      res.status(404).send('Not found');
      return;
    }

    const [referral] = await db
      .select({ id: referrals.id, rawCcdaXml: referrals.rawCcdaXml })
      .from(referrals)
      .where(eq(referrals.id, referralId));

    if (!referral || !referral.rawCcdaXml) {
      res.status(404).send('No C-CDA on file for this referral.');
      return;
    }

    const templatePath = path.join(__dirname, 'views', 'ccdaFrame.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    // No injectNav() — this renders inside an iframe, not as a page.
    res.setHeader('Content-Type', 'text/html');
    res.send(
      template.replace(
        '/*__CCDA_FRAME_DATA__*/',
        `window.__CCDA_FRAME__ = ${embedJson({ referralId })};`,
      ),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Referral-centric convenience link, so a caller does not need to know the
 * workspace id. Distinct from every existing /referrals/:id/* route.
 */
app.get(
  '/referrals/:referralId/workspace',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = Array.isArray(req.params.referralId)
        ? req.params.referralId[0]
        : req.params.referralId;
      const referralId = parseInt(raw, 10);
      if (isNaN(referralId)) {
        res.status(404).send(notFoundPage('That referral id is not a number.'));
        return;
      }
      const workspaceId = await workspaceIdForReferral(referralId);
      if (workspaceId === null) {
        res
          .status(404)
          .send(
            notFoundPage(
              `Referral #${referralId} has no workspace. If it predates PRD-18, run ` +
                `<code>npm run backfill:workspaces</code>.`,
            ),
          );
        return;
      }
      res.redirect(302, `/workspaces/${workspaceId}`);
    } catch (err) {
      next(err);
    }
  },
);

// ── Identity (PRD-17) ─────────────────────────────────────────────────────────

/**
 * The staff roster, ordered by id. The first entry is the acting-user default,
 * mirroring getDefaultActingUser(). Used by the nav selector and the clinician
 * pickers; later by the owner (PRD-21), participant (PRD-24) and mention
 * (PRD-22) pickers.
 */
app.get('/api/users', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ users: await listUsers() });
  } catch (err) {
    next(err);
  }
});

/**
 * Sets the acting user. Not authentication — see getActingUser() in
 * identityService.ts. Rejects an unknown or inactive user id so a stale client
 * cannot park the cookie on someone who no longer exists.
 */
app.post('/api/acting-user', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { userId?: unknown };
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ error: 'userId must be a positive integer' });
      return;
    }
    // One query covers both "unknown" and "inactive": listUsers() is active-only.
    const user = (await listUsers()).find((u) => u.id === userId);
    if (!user) {
      res.status(400).json({ error: `Unknown or inactive user: ${userId}` });
      return;
    }
    res.setHeader(
      'Set-Cookie',
      `${ACTING_USER_COOKIE}=${encodeURIComponent(String(userId))}; Path=/; SameSite=Lax; Max-Age=31536000`,
    );
    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
});

// Workflow Overview page
app.get('/overview', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const templatePath = path.join(__dirname, 'views', 'workflowOverview.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(template));
  } catch (err) {
    next(err);
  }
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

    // Fetch linked prior auth requests
    const paRequests = await db
      .select({
        id: priorAuthRequests.id,
        state: priorAuthRequests.state,
        insurerName: priorAuthRequests.insurerName,
        serviceCode: priorAuthRequests.serviceCode,
        createdAt: priorAuthRequests.createdAt,
      })
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.referralId, referralId))
      .orderBy(desc(priorAuthRequests.createdAt));

    const templatePath = path.join(__dirname, 'views', 'referralReview.html');
    const template = fs.readFileSync(templatePath, 'utf-8');

    const pageData = {
      referralId,
      patient: patient ?? { firstName: '', lastName: '', dateOfBirth: '' },
      referral,
      assessment: assessment ?? null,
      departments: getDepartments(),
      resources: getResources().map((r) => ({ id: r.id, name: r.name, department: r.department })),
      outboundMessages: messages,
      hasCcda: !!referral.rawCcdaXml,
      priorAuth: paRequests,
      // PRD-17: the clinician pickers that replaced the free-text inputs.
      users: await listUsers(),
      actingUser: await tryGetActingUser(req),
    };

    // Inject data as a JSON block the page script can read
    const jsonString = embedJson(pageData);
    console.log(`[ReferralReview] Referral #${referralId} hasCcda=${pageData.hasCcda}, priorAuth=${paRequests.length} records, JSON length=${jsonString.length}`);
    const html = template.replace(
      '/*__PAGE_DATA__*/',
      `window.__PAGE_DATA__ = ${jsonString};`,
    );

    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    next(err);
  }
});

// Get raw C-CDA XML for ccdaview integration
app.get('/referrals/:id/ccda.xml', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(404).send('Not found');
      return;
    }

    const [referral] = await db
      .select({ rawCcdaXml: referrals.rawCcdaXml })
      .from(referrals)
      .where(eq(referrals.id, referralId));

    if (!referral?.rawCcdaXml) {
      res.status(404).send('No CCDA document available');
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(referral.rawCcdaXml);
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

    const body = req.body as {
      decision?: string;
      clinicianId?: string;
      userId?: number;
      declineReason?: string;
    };
    const { decision, declineReason } = body;
    const clinicianId = await resolveClinicianId(body);

    if (!decision || !clinicianId) {
      res.status(400).json({ error: 'decision and one of userId / clinicianId are required' });
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

// ── PRD-13: Routing override API ─────────────────────────────────────────────

app.post('/api/referrals/:id/routing', async (req: Request, res: Response, next: NextFunction) => {
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

    const { department, equipment } = req.body as {
      department?: string;
      equipment?: string[];
    };

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (department !== undefined) {
      const validDepts = getDepartments();
      updates.routingDepartment = validDepts.includes(department) ? department : 'Unassigned';
    }

    if (equipment !== undefined) {
      const validIds = new Set(getResources().map((r) => r.id));
      const filtered = equipment.filter((id) => validIds.has(id));
      updates.routingEquipment = JSON.stringify(filtered);
    }

    await db.update(referrals).set(updates).where(eq(referrals.id, referralId));

    res.json({
      success: true,
      routingDepartment: updates.routingDepartment ?? referral.routingDepartment,
      routingEquipment: updates.routingEquipment ?? referral.routingEquipment,
    });
  } catch (err) {
    next(err);
  }
});

// ── Dashboard preview API ─────────────────────────────────────────────────────

app.get('/api/referrals/:id/preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    if (!referral) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const [patient] = await db.select().from(patients).where(eq(patients.id, referral.patientId));

    const paRows = await db
      .select()
      .from(priorAuthRequests)
      .where(eq(priorAuthRequests.referralId, referralId))
      .orderBy(desc(priorAuthRequests.createdAt))
      .limit(1);
    const priorAuth = paRows[0] ?? null;

    res.json({
      referral: {
        id: referral.id,
        state: referral.state,
        reasonForReferral: referral.reasonForReferral,
        referrerAddress: referral.referrerAddress,
        declineReason: referral.declineReason,
        createdAt: referral.createdAt,
        routingDepartment: referral.routingDepartment,
        aiAssessment: referral.aiAssessment,
        clinicalData: referral.clinicalData,
        appointmentDate: referral.appointmentDate,
        appointmentLocation: referral.appointmentLocation,
        scheduledProvider: referral.scheduledProvider,
      },
      patient: patient
        ? { firstName: patient.firstName, lastName: patient.lastName, dateOfBirth: patient.dateOfBirth }
        : { firstName: '', lastName: '', dateOfBirth: '' },
      priorAuth: priorAuth
        ? {
            id: priorAuth.id,
            state: priorAuth.state,
            insurerName: priorAuth.insurerName,
            serviceCode: priorAuth.serviceCode,
            serviceDisplay: priorAuth.serviceDisplay,
            createdAt: priorAuth.createdAt,
          }
        : null,
      resources: getResources(),
      recentMessages: (await db
        .select({
          id: referralMessages.id,
          direction: referralMessages.direction,
          messageType: referralMessages.messageType,
          summary: referralMessages.summary,
          createdAt: referralMessages.createdAt,
          ackStatus: referralMessages.ackStatus,
        })
        .from(referralMessages)
        .where(eq(referralMessages.referralId, referralId))
        .orderBy(desc(referralMessages.createdAt))
        .limit(3)).reverse(),
    });
  } catch (err) {
    next(err);
  }
});

// ── Message Thread API ────────────────────────────────────────────────────────

app.get('/api/referrals/:id/thread', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const messages = await db
      .select()
      .from(referralMessages)
      .where(eq(referralMessages.referralId, referralId))
      .orderBy(referralMessages.createdAt);

    res.json({
      thread: messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        messageType: m.messageType,
        subject: m.subject,
        summary: m.summary,
        senderAddress: m.senderAddress,
        recipientAddress: m.recipientAddress,
        createdAt: m.createdAt,
        ackStatus: m.ackStatus,
        relatedStateTransition: m.relatedStateTransition,
        hasContent: !!(m.contentBody || m.contentHl7 || m.contentXml),
        hasXml: !!m.contentXml,
        hasHl7: !!m.contentHl7,
      })),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/referrals/:id/thread/:messageId/content', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const messageId = parseInt(Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId, 10);
    if (isNaN(messageId)) {
      res.status(400).json({ error: 'Invalid message ID' });
      return;
    }

    const [message] = await db
      .select({
        contentBody: referralMessages.contentBody,
        contentHl7: referralMessages.contentHl7,
        contentXml: referralMessages.contentXml,
      })
      .from(referralMessages)
      .where(eq(referralMessages.id, messageId));

    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    res.json({
      contentBody: message.contentBody,
      contentHl7: message.contentHl7,
      contentXml: message.contentXml,
    });
  } catch (err) {
    next(err);
  }
});

// ── PRD-03: Scheduler routes ──────────────────────────────────────────────────

// Scheduler queue — lists all Accepted and No-Show referrals awaiting scheduling
app.get('/scheduler/queue', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await db
      .select()
      .from(referrals)
      .where(inArray(referrals.state, ['Accepted', 'No-Show']));

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
      `window.__QUEUE_DATA__ = ${embedJson(items)};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
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
      `window.__SCHEDULE_DATA__ = ${embedJson({
        referralId,
        patient: patient ?? { firstName: '', lastName: '', dateOfBirth: '' },
        referral,
        resources: getResources().map((r) => ({ id: r.id, name: r.name })),
      })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
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
      `window.__ENCOUNTER_DATA__ = ${embedJson({
        referralId,
        patient: patient ?? { firstName: '', lastName: '', dateOfBirth: '' },
        referral,
      })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
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

// ── PRD-11: No-Show & Consult routes ─────────────────────────────────────────

// Mark no-show — transitions Scheduled → No-Show, notifies referring physician
app.post('/referrals/:id/no-show', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    await markNoShow(referralId);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof NoShowNotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof InvalidStateTransitionError) {
      res.status(409).json({ error: err.message });
    } else {
      next(err);
    }
  }
});

// Enter Consult state — transitions Encounter → Consult, notifies referring provider
app.post('/referrals/:id/consult', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    await markConsult(referralId);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ConsultStateNotFoundError) {
      res.status(404).json({ error: err.message });
    } else if (err instanceof InvalidStateTransitionError) {
      res.status(409).json({ error: err.message });
    } else {
      next(err);
    }
  }
});

// Resolve consultation — transitions Consult → Closed
app.post('/referrals/:id/consult/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const clinicianId = await resolveClinicianId(
      req.body as { userId?: unknown; clinicianId?: unknown },
    );
    if (!clinicianId) {
      res.status(400).json({ error: 'one of userId / clinicianId is required' });
      return;
    }

    await resolveConsult(referralId, clinicianId);
    res.json({ success: true });
  } catch (err) {
    if (err instanceof ConsultStateNotFoundError) {
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
      `window.__CONSULT_DATA__ = ${embedJson({
        referralId,
        patient: patient ?? { firstName: '', lastName: '', dateOfBirth: '' },
        referral,
      })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
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

// ── PRD-08 / Consult Demo: FHIR medication lookup & medication save ───────────

// Fetch patient medications from FHIR by name + DOB stored in DB
app.get('/referrals/:id/fhir-medications', async (req: Request, res: Response, next: NextFunction) => {
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
    if (!patient) {
      res.json({ fhirPatientId: null, medications: [] });
      return;
    }

    const { searchPatient, getMedications } = await import('./modules/prd08/fhirClient');
    const match = await searchPatient(patient.firstName, patient.lastName, patient.dateOfBirth);
    if (!match) {
      res.json({ fhirPatientId: null, medications: [] });
      return;
    }

    const medications = await getMedications(match.id);
    res.json({ fhirPatientId: match.id, medications });
  } catch (err) {
    next(err);
  }
});

// Save medications (from FHIR or manual entry) to referral clinicalData
app.post('/referrals/:id/medications', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const referralId = parseInt(idParam, 10);
    if (isNaN(referralId)) {
      res.status(400).json({ error: 'Invalid referral ID' });
      return;
    }

    const { medications, source } = req.body as {
      medications?: string[];
      source?: 'fhir' | 'manual';
    };

    if (!medications || !Array.isArray(medications) || medications.length === 0) {
      res.status(400).json({ error: 'medications must be a non-empty array of strings' });
      return;
    }
    if (source !== 'fhir' && source !== 'manual') {
      res.status(400).json({ error: 'source must be "fhir" or "manual"' });
      return;
    }

    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    if (!referral) {
      res.status(404).json({ error: 'Referral not found' });
      return;
    }

    let clinicalData: Record<string, unknown> = {};
    if (referral.clinicalData) {
      try {
        clinicalData = JSON.parse(referral.clinicalData) as Record<string, unknown>;
      } catch {
        // leave empty
      }
    }

    // Store as EnrichedClinicalItem-shaped objects (consistent with PRD-08 schema)
    clinicalData.medications = medications.map((name) => ({ name, source }));

    await db
      .update(referrals)
      .set({ clinicalData: JSON.stringify(clinicalData), updatedAt: new Date() })
      .where(eq(referrals.id, referralId));

    res.json({ success: true });
  } catch (err) {
    next(err);
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
      `window.__HISTORY_DATA__ = ${embedJson({ messages })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
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
      `window.__RULES_DATA__ = ${embedJson({ skills: skillStats })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
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
    res.send(injectNav(template));
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
      `window.__EDIT_DATA__ = ${embedJson({ skill, body, assets, references })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
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
      `window.__HISTORY_DATA__ = ${embedJson({ skillName: nameParam, executions })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
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

    // PRD-18: keep the work status in step after an override. Like the
    // pendingInfoChecker escalation, this route writes `state` directly rather
    // than through transition() — that bypass is PRD-25's to fix.
    if (referral && referral.state !== 'Acknowledged') {
      await proposeForReferral(referralId, ReferralState.ACKNOWLEDGED);
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

// ── Demo Launcher routes ─────────────────────────────────────────────────────

app.get('/demo', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const templatePath = path.join(__dirname, 'views', 'demoLauncher.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(template));
  } catch (err) {
    next(err);
  }
});

app.post('/demo/launch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { scenario } = req.body as { scenario?: string };
    const validScenarios = ['full-workflow', 'incomplete-info', 'fhir-enriched', 'payer-rejection', 'no-show', 'consult', 'prior-auth'] as const;
    type Scenario = typeof validScenarios[number];
    if (!scenario || !validScenarios.includes(scenario as Scenario)) {
      res.status(400).json({ error: `scenario must be one of: ${validScenarios.join(', ')}` });
      return;
    }
    const { launchFullWorkflow, launchIncompleteInfo, launchFhirEnriched, launchPayerRejection, launchNoShow, launchConsult } =
      await import('./demoScenarios');
    const { launchPriorAuth } = await import('./modules/prd12/mockPayerDemo');
    const scenarioFns: Record<Scenario, () => Promise<number>> = {
      'full-workflow':   launchFullWorkflow,
      'incomplete-info': launchIncompleteInfo,
      'fhir-enriched':   launchFhirEnriched,
      'payer-rejection': launchPayerRejection,
      'no-show':         launchNoShow,
      'consult':         launchConsult,
      'prior-auth':      launchPriorAuth,
    };
    const referralId = await scenarioFns[scenario as Scenario]();
    res.json({ referralId });
  } catch (err) {
    next(err);
  }
});

app.get('/demo/fixture/:scenario', (req: Request, res: Response) => {
  const VALID_SCENARIOS = ['full-workflow', 'incomplete-info', 'fhir-enriched', 'payer-rejection', 'no-show', 'consult', 'prior-auth'];
  const scenario = Array.isArray(req.params.scenario) ? req.params.scenario[0] : req.params.scenario;
  if (!VALID_SCENARIOS.includes(scenario)) { res.status(404).end(); return; }
  const fixturePath = path.join(__dirname, '..', 'tests', 'fixtures', `demo-${scenario}.xml`);
  try {
    const xml = fs.readFileSync(fixturePath, 'utf-8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(xml);
  } catch {
    res.status(404).end();
  }
});

app.get('/demo/events/:referralId', (req: Request, res: Response) => {
  const idParam = Array.isArray(req.params.referralId) ? req.params.referralId[0] : req.params.referralId;
  const referralId = parseInt(idParam, 10);
  if (isNaN(referralId)) { res.status(400).end(); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let lastState = '';
  const TERMINAL_STATES = ['Declined', 'Closed-Confirmed'];

  const intervalId = setInterval(async () => {
    try {
      const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
      if (!referral) return;
      if (referral.state !== lastState) {
        lastState = referral.state;
        res.write(`data: ${JSON.stringify({ state: referral.state, at: new Date().toISOString() })}\n\n`);
        if (TERMINAL_STATES.includes(referral.state)) {
          res.write(`event: done\ndata: ${JSON.stringify({ state: referral.state })}\n\n`);
          clearInterval(intervalId);
          res.end();
        }
      }
    } catch { /* ignore poll errors */ }
  }, 1500);

  req.on('close', () => clearInterval(intervalId));
});

// Generic error handler
// ── Claims Attachment Workflow Routes ────────────────────────────────────────

// Claims queue
app.get('/claims', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const requests = await db.select().from(attachmentRequests).orderBy(desc(attachmentRequests.createdAt));
    const items = await Promise.all(
      requests.map(async (ar) => {
        const [patient] = ar.patientId ? await db.select().from(patients).where(eq(patients.id, ar.patientId)) : [null];
        return {
          request: ar,
          patient: patient ?? { firstName: ar.subscriberName, lastName: '', dateOfBirth: ar.subscriberDob },
        };
      }),
    );
    const templatePath = path.join(__dirname, 'views', 'claimsQueue.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__CLAIMS_DATA__*/',
      `window.__CLAIMS_DATA__ = ${embedJson({ items })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    next(err);
  }
});

// Claims request detail and sign form
app.get('/claims/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const requestId = parseInt(idParam, 10);

    const [request] = await db.select().from(attachmentRequests).where(eq(attachmentRequests.id, requestId));
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const [patient] = request.patientId
      ? await db.select().from(patients).where(eq(patients.id, request.patientId))
      : [null];

    const responses = await db
      .select()
      .from(attachmentResponses)
      .where(eq(attachmentResponses.requestId, requestId));

    const templatePath = path.join(__dirname, 'views', 'claimsRequestDetail.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__CLAIMS_DETAIL__*/',
      `window.__CLAIMS_DETAIL__ = ${embedJson({
        request,
        patient: patient ?? { firstName: '', lastName: '', dateOfBirth: '' },
        responses,
      })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    next(err);
  }
});

// Sign request
app.post('/claims/:id/sign', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const requestId = parseInt(idParam, 10);
    const { providerName, providerNpi } = req.body;

    if (!providerName || !providerNpi) {
      return res.status(400).json({ error: 'Provider name and NPI required' });
    }

    await signRequest(requestId, providerName, providerNpi);

    res.json({ success: true, message: 'Request signed successfully' });
  } catch (err) {
    next(err);
  }
});

// Send response (275)
app.post('/claims/:id/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const requestId = parseInt(idParam, 10);

    const filePath = await sendResponse(requestId);

    res.json({ success: true, message: 'Response sent', filePath });
  } catch (err) {
    next(err);
  }
});

// ── PRD-12: Mock Payer — individual routes to avoid Express 5 $ routing issues ─

app.post(/^\/mock-payer\/Claim\/\$submit$/, handleMockSubmit);
app.post(/^\/mock-payer\/Claim\/\$inquiry$/, handleMockInquiry);
app.post('/mock-payer/Subscription', handleMockSubscription);

// ─��� PRD-12: Prior Authorization routes ───────────────────────────────────────

app.get('/prior-auth', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await listPriorAuthRequests();
    // Attach latest auth number for display
    const enriched = await Promise.all(
      items.map(async (item) => {
        const detail = await getPriorAuthDetail(item.request.id);
        const latestResp = detail.responses[0];
        return { ...item, latestAuthNumber: latestResp?.authNumber ?? undefined };
      }),
    );
    const templatePath = path.join(__dirname, 'views', 'priorAuthQueue.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__PA_QUEUE_DATA__*/',
      `window.__PA_QUEUE_DATA__ = ${embedJson({ items: enriched })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    next(err);
  }
});

app.get('/prior-auth/new', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const referralIdParam = req.query.referralId as string | undefined;
    let formData: Record<string, unknown> = {};

    if (referralIdParam) {
      const referralId = parseInt(referralIdParam, 10);
      const data = await getReferralFormData(referralId);
      if (data) {
        formData = { patient: data.patient, referral: data.referral, diagnoses: data.diagnoses };
      }
    }

    const templatePath = path.join(__dirname, 'views', 'priorAuthForm.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__PA_FORM_DATA__*/',
      `window.__PA_FORM_DATA__ = ${embedJson(formData)};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    next(err);
  }
});

app.post('/prior-auth/submit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as {
      referralId?: unknown; patientId?: unknown; firstName?: unknown; lastName?: unknown;
      dateOfBirth?: unknown; insurerName?: unknown; insurerId?: unknown;
      subscriberId?: unknown; serviceCode?: unknown; serviceDisplay?: unknown;
      providerNpi?: unknown; providerName?: unknown; diagnoses?: unknown;
    };
    const { referralId, patientId, firstName, lastName, dateOfBirth, insurerName, insurerId, subscriberId, serviceCode, serviceDisplay, providerNpi, providerName, diagnoses } = body;

    if (!insurerName || !insurerId || !serviceCode || !providerNpi || !providerName) {
      return res.status(400).json({ error: 'Missing required fields: insurerName, insurerId, serviceCode, providerNpi, providerName' });
    }

    let resolvedPatientId: number;
    if (patientId) {
      resolvedPatientId = parseInt(String(patientId), 10);
    } else if (firstName && lastName && dateOfBirth) {
      const [existing] = await db.select().from(patients).where(
        eq(patients.firstName, String(firstName)),
      );
      if (existing && existing.lastName === String(lastName) && existing.dateOfBirth === String(dateOfBirth)) {
        resolvedPatientId = existing.id;
      } else {
        const inserted = await db.insert(patients).values({
          firstName: String(firstName),
          lastName: String(lastName),
          dateOfBirth: String(dateOfBirth),
        }).returning({ id: patients.id });
        resolvedPatientId = inserted[0].id;
      }
    } else {
      return res.status(400).json({ error: 'Provide either patientId or firstName + lastName + dateOfBirth' });
    }

    console.log(`[PA Submit] referralId=${String(referralId)}, patientId=${resolvedPatientId}`);
    const result = await submitPriorAuth({
      referralId: referralId ? parseInt(String(referralId), 10) : undefined,
      patientId: resolvedPatientId,
      insurerName: String(insurerName),
      insurerId: String(insurerId),
      subscriberId: subscriberId ? String(subscriberId) : undefined,
      serviceCode: String(serviceCode),
      serviceDisplay: serviceDisplay ? String(serviceDisplay) : undefined,
      providerNpi: String(providerNpi),
      providerName: String(providerName),
      diagnoses: diagnoses as Array<{ code: string; display: string }> | undefined,
    });

    res.json(result);
  } catch (err) {
    if (err instanceof InvalidPriorAuthStateTransitionError) {
      return res.status(409).json({ error: err.message });
    }
    next(err);
  }
});

app.get('/prior-auth/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const requestId = parseInt(idParam, 10);

    const detail = await getPriorAuthDetail(requestId);

    const templatePath = path.join(__dirname, 'views', 'priorAuthDetail.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__PA_DETAIL_DATA__*/',
      `window.__PA_DETAIL_DATA__ = ${embedJson(detail)};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    if (err instanceof PriorAuthNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

app.get('/prior-auth/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const requestId = parseInt(idParam, 10);
    const status = await getPriorAuthStatus(requestId);
    res.json(status);
  } catch (err) {
    if (err instanceof PriorAuthNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

app.post('/prior-auth/:id/inquire', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const requestId = parseInt(idParam, 10);
    const status = await inquirePriorAuth(requestId);
    res.json(status);
  } catch (err) {
    if (err instanceof PriorAuthNotFoundError) {
      return res.status(404).json({ error: err.message });
    }
    next(err);
  }
});

app.post('/prior-auth/webhook', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await handlePayerNotification(req.body as Record<string, unknown>);
    if (!result) {
      return res.status(404).json({ error: 'Could not match notification to a request' });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ── Demo Walkthrough helpers ─────────────────────────────────────────────────
// Load sample C-CDA fixture once at startup for walkthrough Path A
const WALKTHROUGH_CCDA_PATH = path.resolve(__dirname, '..', 'tests', 'fixtures', 'demo-full-workflow.xml');
const WALKTHROUGH_CCDA_XML: string | null = (() => {
  try { return fs.readFileSync(WALKTHROUGH_CCDA_PATH, 'utf-8'); } catch { return null; }
})();

async function walkthroughUpsertPatient(firstName: string, lastName: string, dob: string): Promise<number> {
  const [existing] = await db
    .select()
    .from(patients)
    .where(and(eq(patients.firstName, firstName), eq(patients.lastName, lastName)));
  if (existing) return existing.id;
  const [inserted] = await db
    .insert(patients)
    .values({ firstName, lastName, dateOfBirth: dob })
    .returning();
  return inserted.id;
}

async function walkthroughUpsertReferral(
  patientId: number,
  sourceMessageId: string,
  state: string,
  fields: Record<string, unknown>,
  now: Date,
): Promise<number> {
  const [existing] = await db
    .select()
    .from(referrals)
    .where(eq(referrals.sourceMessageId, sourceMessageId));
  if (existing) {
    const { rawCcdaXml: rawXml, clinicalData, appointmentDate, appointmentLocation, scheduledProvider, reasonForReferral } = fields as Record<string, string | undefined>;
    await db
      .update(referrals)
      .set({
        state, updatedAt: now,
        ...(reasonForReferral !== undefined && { reasonForReferral }),
        ...(clinicalData !== undefined && { clinicalData }),
        ...(rawXml !== undefined && { rawCcdaXml: rawXml }),
        ...(appointmentDate !== undefined && { appointmentDate }),
        ...(appointmentLocation !== undefined && { appointmentLocation }),
        ...(scheduledProvider !== undefined && { scheduledProvider }),
      })
      .where(eq(referrals.id, existing.id));
    return existing.id;
  }
  const [inserted] = await db
    .insert(referrals)
    .values({
      patientId,
      sourceMessageId,
      referrerAddress: 'referrer@hospital.direct',
      reasonForReferral: (fields.reasonForReferral as string | undefined) ?? 'Demo referral',
      state,
      createdAt: now,
      updatedAt: now,
      clinicalData: (fields.clinicalData as string | undefined) ?? null,
      rawCcdaXml: (fields.rawCcdaXml as string | undefined) ?? null,
      appointmentDate: (fields.appointmentDate as string | undefined) ?? null,
      appointmentLocation: (fields.appointmentLocation as string | undefined) ?? null,
      scheduledProvider: (fields.scheduledProvider as string | undefined) ?? null,
    })
    .returning();
  return inserted.id;
}

// ── Demo Walkthrough routes ──────────────────────────────────────────────────

app.get('/walkthrough', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const templatePath = path.join(__dirname, 'views', 'demoWalkthrough.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(template));
  } catch (err) {
    next(err);
  }
});

app.post('/walkthrough/seed', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();

    // Path A: PA + Full Happy Path — full clinical data for PA pre-population
    const patientAId = await walkthroughUpsertPatient('Walk-A', 'Patient', '1975-06-15');
    const referralAId = await walkthroughUpsertReferral(patientAId, 'walkthrough-path-a', 'Acknowledged', {
      reasonForReferral: 'Cardiology referral for chest pain evaluation. Patient reports intermittent chest discomfort with exertion.',
      clinicalData: JSON.stringify({
        problems: [
          { name: 'Chest pain', code: 'R07.9' },
          { name: 'Essential hypertension', code: 'I10' },
        ],
        medications: [],
        allergies: [],
        results: [],
      }),
      rawCcdaXml: WALKTHROUGH_CCDA_XML ?? undefined,
    }, now);

    // Path B/C: Standalone PA demo (patient only, no referral needed)
    const patientBCId = await walkthroughUpsertPatient('Walk-BC', 'Patient', '1982-09-22');

    // Path D: Referral to Decline
    const patientDId = await walkthroughUpsertPatient('Walk-D', 'Patient', '1968-03-10');
    const referralDId = await walkthroughUpsertReferral(patientDId, 'walkthrough-path-d', 'Acknowledged', {
      reasonForReferral: 'Orthopedic evaluation for right knee pain. Patient requests surgical consult.',
    }, now);

    // Path E: Pending-Information → Resolved
    const patientEId = await walkthroughUpsertPatient('Walk-E', 'Patient', '1990-11-05');
    const referralEId = await walkthroughUpsertReferral(patientEId, 'walkthrough-path-e', 'Pending-Information', {
      reasonForReferral: 'Gastroenterology referral — additional ICD-10 diagnosis codes requested.',
    }, now);

    // Path F: Scheduled with past appointment
    const patientFId = await walkthroughUpsertPatient('Walk-F', 'Patient', '1955-07-28');
    const pastDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const referralFId = await walkthroughUpsertReferral(patientFId, 'walkthrough-path-f', 'Scheduled', {
      reasonForReferral: 'Physical therapy referral for chronic lower back pain.',
      appointmentDate: pastDate.toISOString(),
      appointmentLocation: 'PT Center, Room 12',
      scheduledProvider: 'Dr. Martinez',
    }, now);

    // Path G: Claims attachment patient (277 injected separately)
    const patientGId = await walkthroughUpsertPatient('Walk-G', 'Patient', '1945-12-01');

    res.json({
      pathA:  { referralId: referralAId, patientId: patientAId },
      pathBC: { patientId: patientBCId },
      pathD:  { referralId: referralDId, patientId: patientDId },
      pathE:  { referralId: referralEId, patientId: patientEId },
      pathF:  { referralId: referralFId, patientId: patientFId },
      pathG:  { patientId: patientGId },
    });
  } catch (err) {
    next(err);
  }
});

app.get('/walkthrough/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const referralIdsParam = req.query.referralIds as string | undefined;
    const claimsIdsParam = req.query.claimsIds as string | undefined;
    const result: Record<string, string> = {};

    if (referralIdsParam) {
      const ids = referralIdsParam.split(',').map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
      for (const id of ids) {
        const [r] = await db.select().from(referrals).where(eq(referrals.id, id));
        if (r) result[`referral_${id}`] = r.state;
      }
    }

    if (claimsIdsParam) {
      const ids = claimsIdsParam.split(',').map((n) => parseInt(n, 10)).filter((n) => !isNaN(n));
      for (const id of ids) {
        const [r] = await db.select().from(attachmentRequests).where(eq(attachmentRequests.id, id));
        if (r) result[`claims_${id}`] = r.state;
      }
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/walkthrough/ack/:referralId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam = Array.isArray(req.params.referralId) ? req.params.referralId[0] : req.params.referralId;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid referral ID' }); return; }

    const [referral] = await db.select().from(referrals).where(eq(referrals.id, id));
    if (!referral) { res.status(404).json({ error: 'Referral not found' }); return; }

    const nextState = referralTransition(referral.state as ReferralState, ReferralState.CLOSED_CONFIRMED);
    await db
      .update(referrals)
      .set({ state: nextState, updatedAt: new Date() })
      .where(eq(referrals.id, id));

    res.json({ success: true, state: nextState });
  } catch (err) {
    if (err instanceof InvalidStateTransitionError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

app.post('/walkthrough/info-reply/:referralId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idParam2 = Array.isArray(req.params.referralId) ? req.params.referralId[0] : req.params.referralId;
    const id = parseInt(idParam2, 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid referral ID' }); return; }

    const [referral] = await db.select().from(referrals).where(eq(referrals.id, id));
    if (!referral) { res.status(404).json({ error: 'Referral not found' }); return; }

    const nextState = referralTransition(referral.state as ReferralState, ReferralState.ACKNOWLEDGED);
    await db
      .update(referrals)
      .set({ state: nextState, updatedAt: new Date() })
      .where(eq(referrals.id, id));

    res.json({ success: true, state: nextState });
  } catch (err) {
    if (err instanceof InvalidStateTransitionError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

app.post('/walkthrough/inject-277', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { patientId } = req.body as { patientId?: number };
    const now = new Date();
    const controlNumber = `WLK-${Date.now()}`;

    const [inserted] = await db
      .insert(attachmentRequests)
      .values({
        patientId: patientId ?? null,
        controlNumber,
        claimNumber: `CLM-WLK-001`,
        payerName: 'Aetna',
        payerIdentifier: '60054',
        subscriberName: 'Walk-G Patient',
        subscriberId: 'WLK-SUB-001',
        subscriberDob: '1945-12-01',
        requestedLoincCodes: JSON.stringify(['34117-2', '51847-2']),
        sourceFile: 'walkthrough-demo.edi',
        state: 'Received',
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    res.json({ success: true, claimsId: inserted.id });
  } catch (err) {
    next(err);
  }
});

// ── Analytics Dashboard (PRD-14 Phase 2) ─────────────────────────────────────

function parseAnalyticsFilters(query: Record<string, unknown>): AnalyticsFilters {
  const str = (k: string): string | undefined => {
    const v = query[k];
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  const daysRaw = query['days'];
  const days =
    daysRaw === '0' ? 0 : typeof daysRaw === 'string' ? parseInt(daysRaw, 10) || 90 : 90;
  return {
    department: str('department'),
    clinicianId: str('clinicianId'),
    state: str('state'),
    payer: str('payer'),
    skillName: str('skillName'),
    denialReason: str('denialReason'),
    days,
  };
}

app.get('/analytics', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const defaultFilters: AnalyticsFilters = { days: 90 };
    const eventCount = getEventCount();
    const filterOptions = getFilterOptions();

    const template = fs.readFileSync(path.join(__dirname, 'views', 'analytics.html'), 'utf-8');
    const html = template.replace(
      '/*__ANALYTICS_DATA__*/',
      `window.__ANALYTICS_DATA__ = ${embedJson({
        eventCount,
        filterOptions,
        kpis: getKpis(defaultFilters),
        stateCounts: getReferralStateCounts(defaultFilters),
        dailyIntake: getDailyIntake(defaultFilters),
        funnel: getReferralFunnel(defaultFilters),
        paOutcomes: getPriorAuthOutcomes(defaultFilters),
        denialReasons: getTopDenialReasons(defaultFilters),
        skillRates: getSkillMatchRates(defaultFilters),
        stateTimings: getAvgStateTimings(defaultFilters),
      })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    next(err);
  }
});

app.get('/analytics/data', (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = parseAnalyticsFilters(req.query as Record<string, unknown>);
    res.json({
      kpis: getKpis(filters),
      stateCounts: getReferralStateCounts(filters),
      dailyIntake: getDailyIntake(filters),
      funnel: getReferralFunnel(filters),
      paOutcomes: getPriorAuthOutcomes(filters),
      denialReasons: getTopDenialReasons(filters),
      skillRates: getSkillMatchRates(filters),
      stateTimings: getAvgStateTimings(filters),
    });
  } catch (err) {
    next(err);
  }
});

app.post('/analytics/agent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filters = parseAnalyticsFilters(req.body as Record<string, unknown>);
    const result = await runAnalyticsAgent({ filters });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Error handler
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
