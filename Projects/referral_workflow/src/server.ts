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
  QueueFilters,
  QueueNotFoundError,
  QueueNotVisibleError,
  SavedFilterNotFoundError,
  addQueueMember,
  deleteSavedFilter,
  getQueueRows,
  listQueueMembers,
  listQueues,
  listSavedFilters,
  moveWorkspace,
  parseFilters,
  removeQueueMember,
  saveFilter,
} from './modules/workspace/queueService';
import {
  NextActionTooLongError,
  NextActionWorkspaceNotFoundError,
  OverrideReasonRequiredError,
  clearOverrides,
  listOverdue,
  overrideDueDate,
  overrideNextAction,
} from './modules/workspace/nextActionService';
import {
  AlreadyAssociatedError,
  ExceptionAlreadyResolvedError,
  ExceptionNotFoundError,
  ExceptionWorkspaceNotFoundError,
  WrongExceptionTypeError,
  candidatesFor,
  convertAutoDeclined,
  getException,
  isExceptionResolution,
  isExceptionType,
  listExceptions,
  reassociate,
  resolveException,
} from './modules/workspace/exceptionService';
import {
  MessageNotProcessedError,
  listProcessed,
  replayMessage,
} from './modules/workspace/correlationService';
import {
  GuestIneligibleTypeError,
  getUnreadCount,
  isNotificationType,
  listNotifications,
  listPreferences,
  markAllRead,
  markRead,
  setPreference,
} from './modules/workspace/notificationService';
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
  CommentDeletedError,
  CommentEmptyError,
  CommentNotAuthorError,
  CommentNotFoundError,
  CommentRevisionConflictError,
  CommentTooLongError,
  CommentVisibility,
  CommentWorkspaceNotFoundError,
  GuestVisibilityError,
  MentionTargetError,
  ShareNotConfirmedError,
  SharedMentionError,
  VisibilityDowngradeError,
  acknowledgeMentions,
  deleteComment,
  editComment,
  getCommentHistory,
  isCommentVisibility,
  listComments,
  mentionTargets,
  openMentionCount,
  postComment,
} from './modules/workspace/commentService';
import {
  DocumentAccessDeniedError,
  DocumentContentUnavailableError,
  DocumentNotFoundError,
  DocumentWorkspaceNotFoundError,
  GuestUploadVisibilityError,
  UploadEmptyError,
  UploadTooLargeError,
  UploadTypeNotAllowedError,
  assertGuestMayRead,
  getAccessLog,
  getDocument,
  listDocuments,
  listSharedDocuments,
  recordAccess,
  resolveContent,
  uploadDocument,
} from './modules/workspace/documentService';
import {
  ActivityWorkspaceNotFoundError,
  getActivityFeed,
  getGuestActivityFeed,
} from './modules/workspace/activityService';
import { ACTIVITY_KINDS, ActivityKind, ReferralEvents } from './modules/workspace/eventCatalog';
import { NotReopenableError, reopenReferral } from './modules/workspace/dispositionOverride';
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
 * It does NOT stop an unauthenticated stranger, and it is not meant to.
 *
 * PRD-20 was originally going to own the real boundary. It does not: that work
 * was deferred out of the epic by an explicit decision and is tracked as PRD-31.
 * PRD-20 ships queue scoping as a server-side least-privilege DEFAULT — the
 * predicate is real and a caller cannot widen its own scope — but it scopes
 * against this same forgeable identity, so it is not an access control either.
 * Deploying guest access to a publicly reachable host is gated on PRD-31.
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
  <a href="/queues" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Queues</a>
  <a href="/exceptions" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Exceptions</a>
  <a href="/workspaces" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Workspaces</a>
  <a href="/overview" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Overview</a>
  <a href="/claims" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Claims</a>
  <a href="/prior-auth" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Prior Auth</a>
  <a href="/analytics" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Analytics</a>
  <a href="/rules/admin" style="color:#adb5bd;text-decoration:none;font-size:0.88rem;">Skills</a>
  <a href="/walkthrough" style="color:#20c997;text-decoration:none;font-size:0.88rem;font-weight:600;">Walkthrough</a>
  <a href="/demo" style="color:#ffc107;text-decoration:none;font-size:0.88rem;font-weight:600;">Demo Launcher</a>
  <div id="notifBell" style="margin-left:auto;position:relative;">
    <button id="notifBtn" title="Notifications"
      style="background:#12404f;border:1px solid #1d5a6d;border-radius:6px;color:#fff;cursor:pointer;
             padding:4px 10px;font-size:0.9rem;line-height:1.3;position:relative;">
      &#128276;<span id="notifCount"
        style="display:none;position:absolute;top:-6px;right:-6px;background:#dc3545;color:#fff;
               border-radius:20px;font-size:0.62rem;font-weight:700;padding:1px 5px;min-width:16px;
               text-align:center;"></span>
    </button>
    <div id="notifPanel"
      style="display:none;position:absolute;right:0;top:34px;width:380px;max-height:460px;overflow:auto;
             background:#fff;color:#212529;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,0.3);
             z-index:200;text-align:left;"></div>
  </div>
  <label style="display:flex;align-items:center;gap:6px;color:#adb5bd;font-size:0.8rem;">
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

/**
 * The notification bell, polled rather than pushed.
 *
 * Polling on an interval, not a WebSocket — the PRD's constraint, and a missed
 * poll is explicitly acceptable. 20 seconds is frequent enough that a bell feels
 * live and infrequent enough to be invisible on a demo box.
 *
 * OPENING THE PANEL MARKS NOTHING READ (AC11). Reading is an explicit act:
 * clicking one, or "mark all read". A bell that empties itself the moment you
 * glance at it has lost the only thing it was for.
 */
const NAV_BELL_SCRIPT = `
(function () {
  var btn = document.getElementById('notifBtn');
  var panel = document.getElementById('notifPanel');
  var badge = document.getElementById('notifCount');
  if (!btn || !panel || !badge) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var latest = [];

  function paintBadge(n) {
    if (n > 0) { badge.style.display = ''; badge.textContent = n > 99 ? '99+' : String(n); }
    else { badge.style.display = 'none'; }
  }

  function paintPanel() {
    if (!latest.length) {
      panel.innerHTML = '<div style="padding:18px 16px;color:#6c757d;font-size:0.85rem;">' +
        'Nothing yet. Assignments, mentions, overdue actions and exceptions arrive here.</div>';
      return;
    }
    panel.innerHTML =
      '<div style="padding:8px 14px;border-bottom:1px solid #dee2e6;display:flex;align-items:center;">' +
        '<strong style="font-size:0.8rem;">Notifications</strong>' +
        '<button id="notifAll" style="margin-left:auto;font-size:0.74rem;border:1px solid #dee2e6;' +
          'background:#fff;border-radius:6px;padding:3px 8px;cursor:pointer;">Mark all read</button>' +
      '</div>' +
      latest.map(function (n) {
        return '<div style="padding:10px 14px;border-bottom:1px solid #f1f3f5;' +
            (n.read ? 'opacity:0.6;' : 'background:#f8fbfc;') + '">' +
          '<div style="display:flex;gap:8px;align-items:baseline;">' +
            '<span style="font-size:0.6rem;font-weight:700;text-transform:uppercase;' +
              'letter-spacing:0.04em;background:#e0e7ff;color:#3730a3;border-radius:20px;' +
              'padding:1px 7px;">' + esc(n.notificationType) + '</span>' +
            (n.collapsedCount > 1
              ? '<span style="font-size:0.66rem;color:#6c757d;">&times;' + n.collapsedCount + '</span>'
              : '') +
          '</div>' +
          '<div style="font-size:0.85rem;font-weight:600;margin:3px 0 2px;">' + esc(n.title) + '</div>' +
          '<div style="font-size:0.78rem;color:#495057;line-height:1.4;">' + esc(n.body) + '</div>' +
          '<div style="margin-top:5px;display:flex;gap:10px;font-size:0.74rem;">' +
            '<a href="' + esc(n.linkPath) + '">Open &rarr;</a>' +
            (n.read ? '' : '<a href="#" data-read="' + n.id + '">Mark read</a>') +
          '</div>' +
        '</div>';
      }).join('');

    var all = document.getElementById('notifAll');
    if (all) all.addEventListener('click', function () {
      fetch('/api/notifications/read-all', { method: 'POST' }).then(load);
    });
    panel.querySelectorAll('[data-read]').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        fetch('/api/notifications/' + a.getAttribute('data-read') + '/read', { method: 'POST' })
          .then(load);
      });
    });
  }

  function load() {
    return fetch('/api/notifications')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        latest = j.notifications || [];
        paintBadge(j.unreadCount || 0);
        if (panel.style.display !== 'none') paintPanel();
      })
      .catch(function () { /* a missed poll is acceptable */ });
  }

  btn.addEventListener('click', function () {
    var hidden = panel.style.display === 'none';
    panel.style.display = hidden ? '' : 'none';
    // Opening PAINTS; it does not mark anything read.
    if (hidden) paintPanel();
  });

  document.addEventListener('click', function (ev) {
    if (!document.getElementById('notifBell').contains(ev.target)) panel.style.display = 'none';
  });

  load();
  setInterval(load, 20000);
})();
`;

function injectNav(html: string): string {
  return html.replace('<!--__NAV__-->', `${NAV_HTML}\n<script>${NAV_BELL_SCRIPT}</script>`);
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

// ── PRD-27 notifications ─────────────────────────────────────────────────────

/**
 * The bell. Polled on an interval by the nav, rather than a WebSocket.
 *
 * `unreadOnly` defaults to FALSE: opening the list shows recent notifications
 * whether read or not, because AC11 requires that opening it does not mark
 * anything read — and a list that shows only unread ones would look like it
 * had, the moment you marked one.
 */
app.get('/api/notifications', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await tryGetActingUser(req);
    if (!user) {
      // Not an error: a database with no users seeded has no bell.
      res.json({ unreadCount: 0, notifications: [] });
      return;
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '30'), 10) || 30, 1), 100);
    res.json({
      unreadCount: await getUnreadCount(user.id),
      notifications: await listNotifications(user.id, {
        unreadOnly: req.query.unread === '1',
        limit,
      }),
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/notifications/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user' });
      return;
    }
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'notification id must be a positive integer' });
      return;
    }
    // Scoped to the recipient inside the service, so marking somebody else's
    // notification read is a 404 rather than a cross-user write.
    const changed = await markRead(id, user.id);
    if (!changed) {
      res.status(404).json({ error: 'no unread notification with that id for this user' });
      return;
    }
    res.json({ ok: true, unreadCount: await getUnreadCount(user.id) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/notifications/read-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user' });
      return;
    }
    res.json({ ok: true, marked: await markAllRead(user.id), unreadCount: 0 });
  } catch (err) {
    next(err);
  }
});

/** Per-type mute and email switches. Muting PREVENTS CREATION (AC12). */
app.get('/api/notification-preferences', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user' });
      return;
    }
    res.json({ preferences: await listPreferences(user.id) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/notification-preferences', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user' });
      return;
    }
    const body = (req.body ?? {}) as {
      notificationType?: unknown;
      muted?: unknown;
      emailEnabled?: unknown;
    };
    const type = typeof body.notificationType === 'string' ? body.notificationType : '';
    if (!isNotificationType(type)) {
      res.status(400).json({ error: 'notificationType is not one of the recognised values' });
      return;
    }
    const updated = await setPreference(user.id, type, {
      muted: typeof body.muted === 'boolean' ? body.muted : undefined,
      emailEnabled: typeof body.emailEnabled === 'boolean' ? body.emailEnabled : undefined,
    });
    res.json({ ok: true, notificationType: type, ...updated });
  } catch (err) {
    if (err instanceof GuestIneligibleTypeError) {
      res.status(422).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ── PRD-28 correlation and the exception queue ───────────────────────────────

/**
 * The exception queue.
 *
 * Scoped through queueService like everything else, with ONE deliberate
 * difference: orphans are always included. An exception with no workspace is
 * exactly the kind that used to vanish into a log line, and scoping it out of
 * every queue would recreate that — nobody would ever see it.
 */
app.get('/api/exceptions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user', message: 'No users are seeded. Run: npm run seed' });
      return;
    }
    const typeParam = typeof req.query.type === 'string' ? req.query.type : '';
    const { getVisibleQueueIds } = await import('./modules/workspace/queueService');
    const exceptions = await listExceptions({
      exceptionType: isExceptionType(typeParam) ? typeParam : undefined,
      // `?open=0` shows resolved ones too, for the audit trail.
      openOnly: req.query.open !== '0',
      queueIds: await getVisibleQueueIds(user),
    });
    res.json({ count: exceptions.length, exceptions });
  } catch (err) {
    next(err);
  }
});

app.get('/api/exceptions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'exception id must be a positive integer' });
      return;
    }
    const exception = await getException(id);
    if (!exception) {
      res.status(404).json({ error: `No exception #${id}` });
      return;
    }
    res.json({ exception });
  } catch (err) {
    next(err);
  }
});

/** Ranked candidates for reassociation, each carrying its reasons (AC11). */
app.get('/api/exceptions/:id/candidates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'exception id must be a positive integer' });
      return;
    }
    try {
      res.json({ candidates: await candidatesFor(id) });
    } catch (err) {
      if (err instanceof ExceptionNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** AC12/AC13 — attach an orphan to a workspace, fully audited. A note is required. */
app.post('/api/exceptions/:id/reassociate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'exception id must be a positive integer' });
      return;
    }
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user' });
      return;
    }
    const body = (req.body ?? {}) as { workspaceId?: unknown; note?: unknown };
    const workspaceId = typeof body.workspaceId === 'number' ? body.workspaceId : Number(body.workspaceId);
    if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
      res.status(400).json({ error: 'workspaceId must be a positive integer' });
      return;
    }
    // AC13 wants the reason recorded, so it is required rather than optional:
    // attaching a clinical document to a patient's record on a hunch, with no
    // note, is the thing the audit exists to prevent.
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (!note) {
      res.status(422).json({ error: 'a note explaining the reassociation is required' });
      return;
    }

    try {
      res.json({ ok: true, exception: await reassociate(id, workspaceId, user, note) });
    } catch (err) {
      if (err instanceof ExceptionNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof ExceptionWorkspaceNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof ExceptionAlreadyResolvedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof AlreadyAssociatedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

app.post('/api/exceptions/:id/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'exception id must be a positive integer' });
      return;
    }
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user' });
      return;
    }
    const body = (req.body ?? {}) as { resolution?: unknown; note?: unknown };
    const resolution = typeof body.resolution === 'string' ? body.resolution : '';
    if (!isExceptionResolution(resolution)) {
      res.status(400).json({ error: 'resolution is not one of the recognised values' });
      return;
    }
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;

    try {
      res.json({ ok: true, exception: await resolveException(id, resolution, user, note) });
    } catch (err) {
      if (err instanceof ExceptionNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof ExceptionAlreadyResolvedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** AC17 — an auto-declined referral becomes a real one when the decline was wrong. */
app.post('/api/exceptions/:id/convert', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'exception id must be a positive integer' });
      return;
    }
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user' });
      return;
    }
    const body = (req.body ?? {}) as { note?: unknown };
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (!note) {
      res.status(422).json({ error: 'a note explaining why the decline was wrong is required' });
      return;
    }

    try {
      res.json({ ok: true, ...(await convertAutoDeclined(id, user, note)) });
    } catch (err) {
      if (err instanceof ExceptionNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof WrongExceptionTypeError) {
        res.status(422).json({ error: err.message });
        return;
      }
      if (err instanceof ExceptionAlreadyResolvedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** The operator's view of inbound processing — what was seen and what happened. */
app.get('/api/processed-messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user' });
      return;
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1), 500);
    res.json({ messages: await listProcessed(limit) });
  } catch (err) {
    next(err);
  }
});

/**
 * AC4 — deliberate operator replay.
 *
 * Clears the idempotency record so the next inbox sweep reprocesses. Cannot
 * create a duplicate referral: `referrals.source_message_id` is still unique, so
 * a message that succeeded the first time is refused at insert.
 */
app.post('/api/messages/:messageId/replay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user' });
      return;
    }
    const messageId = decodeURIComponent(String(req.params.messageId));
    try {
      await replayMessage(messageId, user);
      res.json({ ok: true, messageId });
    } catch (err) {
      if (err instanceof MessageNotProcessedError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** The exception queue page. */
app.get('/exceptions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await tryGetActingUser(req);
    if (!user) {
      res
        .status(409)
        .send(notFoundPage('No users are seeded, so no exception queue can be scoped. Run: npm run seed'));
      return;
    }
    const { getVisibleQueueIds } = await import('./modules/workspace/queueService');
    const scope = await getVisibleQueueIds(user);
    const exceptions = await listExceptions({ queueIds: scope });

    const templatePath = path.join(__dirname, 'views', 'exceptionQueue.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__EXCEPTION_QUEUE__*/',
      `window.__EXCEPTION_QUEUE__ = ${embedJson({
        exceptions,
        resolved: await listExceptions({ openOnly: false, queueIds: scope }),
        processed: await listProcessed(50),
        actingUser: { id: user.id, displayName: user.displayName },
      })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    next(err);
  }
});

// ── PRD-26 next action and due dates ─────────────────────────────────────────

/** AC7 — a due date a person chose, with a reason. 422 without one. */
app.post('/api/workspaces/:id/due-date', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(400).json({ error: 'workspace id must be a positive integer' });
      return;
    }
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user', message: 'No users are seeded. Run: npm run seed' });
      return;
    }

    const body = (req.body ?? {}) as { dueAt?: unknown; reason?: unknown };
    const dueAt = typeof body.dueAt === 'string' ? new Date(body.dueAt) : null;
    if (dueAt === null || Number.isNaN(dueAt.getTime())) {
      res.status(400).json({ error: 'dueAt must be an ISO 8601 timestamp' });
      return;
    }
    const reason = typeof body.reason === 'string' ? body.reason : '';

    try {
      res.json({ ok: true, nextAction: await overrideDueDate(workspaceId, dueAt, reason, user) });
    } catch (err) {
      // 422 rather than 400: the request is well-formed, the reason is the
      // business requirement it fails (AC7).
      if (err instanceof OverrideReasonRequiredError) {
        res.status(422).json({ error: err.message });
        return;
      }
      if (err instanceof NextActionWorkspaceNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** AC4 — a coordinator's own instruction, which survives recomputation. */
app.post('/api/workspaces/:id/next-action', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(400).json({ error: 'workspace id must be a positive integer' });
      return;
    }
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user', message: 'No users are seeded. Run: npm run seed' });
      return;
    }

    const body = (req.body ?? {}) as { nextAction?: unknown; clear?: unknown };

    // `clear: true` restores the rule, so a coordinator who overrode by mistake
    // is not stuck with it until the state happens to move.
    if (body.clear === true) {
      try {
        res.json({ ok: true, nextAction: await clearOverrides(workspaceId, user) });
      } catch (err) {
        if (err instanceof NextActionWorkspaceNotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    if (typeof body.nextAction !== 'string') {
      res.status(400).json({ error: 'nextAction must be a string' });
      return;
    }

    try {
      res.json({
        ok: true,
        nextAction: await overrideNextAction(workspaceId, body.nextAction, user),
      });
    } catch (err) {
      if (err instanceof NextActionTooLongError) {
        res.status(422).json({ error: err.message });
        return;
      }
      if (err instanceof NextActionWorkspaceNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof Error && err.name === 'NextActionEmptyError') {
        res.status(422).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Everything overdue, SCOPED TO THE ACTING USER'S QUEUES.
 *
 * Scope is resolved by queueService — the one module that owns the predicate —
 * rather than reimplemented here, where it could drift from the queue view and
 * quietly widen. A user in no queue gets an empty list, not everything.
 */
app.get('/api/overdue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(409).json({ error: 'no-acting-user', message: 'No users are seeded. Run: npm run seed' });
      return;
    }
    const { getVisibleQueueIds } = await import('./modules/workspace/queueService');
    const scope = await getVisibleQueueIds(user);
    const items = await listOverdue(scope);
    res.json({ count: items.length, items });
  } catch (err) {
    next(err);
  }
});

// ── PRD-20 shared queues ─────────────────────────────────────────────────────

/**
 * Turns a query string into filters.
 *
 * Everything goes through `parseFilters()`, which is an allow-list — an
 * unrecognised value is dropped rather than passed down. Note what is NOT read
 * here: any notion of a queue. The queue is the slug in the path, resolved
 * server-side against the caller's scope, so there is no second and unscoped way
 * to choose one.
 */
function queueFiltersFrom(req: Request): QueueFilters {
  const q = req.query as Record<string, unknown>;
  return parseFilters({
    tab: q.tab,
    workStatus: q.workStatus,
    referralState: q.referralState,
    ownerUserId: q.owner,
    partyOrgName: q.org,
    department: q.department,
    dueBefore: q.dueBefore,
    dueAfter: q.dueAfter,
    overdueOnly: q.overdueOnly,
  } as Record<string, unknown>);
}

/**
 * Resolves the acting user for a queue surface, or answers the empty state.
 *
 * Queue surfaces cannot fall back to "show everything" when there is no user,
 * which is what an unresolved identity would otherwise mean. Returns null after
 * having already answered the request.
 */
async function requireQueueUser(
  req: Request,
  res: Response,
  asJson: boolean,
): Promise<Awaited<ReturnType<typeof tryGetActingUser>> | null> {
  const user = await tryGetActingUser(req);
  if (user) return user;
  if (asJson) {
    res.status(409).json({
      error: 'no-acting-user',
      message: 'No users are seeded. Run: npm run seed',
    });
  } else {
    res
      .status(409)
      .send(notFoundPage('No users are seeded, so no queue can be scoped. Run: npm run seed'));
  }
  return null;
}

/** The queue list, each queue with its per-tab counts, scoped to the caller. */
app.get('/queues', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await requireQueueUser(req, res, false);
    if (!user) return;

    const queues = await listQueues(user);
    const templatePath = path.join(__dirname, 'views', 'queueList.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__QUEUE_LIST__*/',
      `window.__QUEUE_LIST__ = ${embedJson({
        queues,
        actingUser: { id: user.id, displayName: user.displayName, allQueuesAccess: user.allQueuesAccess },
      })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    next(err);
  }
});

/**
 * One queue's view. 403 for a queue outside the caller's scope (AC4).
 *
 * `all` is a reserved slug meaning "every queue in MY scope" — for a user
 * without the grant that is still only their memberships, never everything.
 */
app.get('/queues/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await requireQueueUser(req, res, false);
    if (!user) return;

    const slug = String(req.params.slug);
    const filters = queueFiltersFrom(req);

    let data;
    try {
      data = await getQueueRows(user, slug, filters);
    } catch (err) {
      if (err instanceof QueueNotVisibleError) {
        res.status(403).send(notFoundPage('That queue is not available to you.'));
        return;
      }
      throw err;
    }

    const templatePath = path.join(__dirname, 'views', 'queueView.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    const html = template.replace(
      '/*__QUEUE_VIEW__*/',
      `window.__QUEUE_VIEW__ = ${embedJson({
        slug,
        queue: data.queue,
        counts: data.counts,
        rows: data.rows,
        filters: { ...filters, dueBefore: undefined, dueAfter: undefined },
        queues: await listQueues(user),
        departments: getDepartments(),
        users: (await listUsers()).map((u) => ({ id: u.id, displayName: u.displayName })),
        savedFilters: await listSavedFilters(user.id),
        actingUser: { id: user.id, displayName: user.displayName },
      })};`,
    );
    res.setHeader('Content-Type', 'text/html');
    res.send(injectNav(html));
  } catch (err) {
    next(err);
  }
});

/** The rows behind the queue view, for the client-side filter round trip. */
app.get('/api/queues/:slug/rows', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await requireQueueUser(req, res, true);
    if (!user) return;

    const slug = String(req.params.slug);
    try {
      const data = await getQueueRows(user, slug, queueFiltersFrom(req));
      res.json({
        queue: data.queue ? { slug: data.queue.slug, name: data.queue.name } : null,
        counts: data.counts,
        rows: data.rows,
      });
    } catch (err) {
      if (err instanceof QueueNotVisibleError) {
        // 403 and NO data — deliberately identical for a queue that exists but
        // is out of scope and one that does not exist, so the response cannot be
        // used to enumerate queues.
        res.status(403).json({ error: 'queue-not-visible' });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** Queue membership. */
app.get('/api/queues/:slug/members', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await requireQueueUser(req, res, true);
    if (!user) return;
    const { resolveVisibleQueue } = await import('./modules/workspace/queueService');
    try {
      const queue = await resolveVisibleQueue(user, String(req.params.slug));
      res.json({ queue: { slug: queue.slug, name: queue.name }, members: await listQueueMembers(queue.id) });
    } catch (err) {
      if (err instanceof QueueNotVisibleError) {
        res.status(403).json({ error: 'queue-not-visible' });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

app.post('/api/queues/:slug/members', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await requireQueueUser(req, res, true);
    if (!user) return;

    const body = (req.body ?? {}) as { userId?: unknown; accessLevel?: unknown };
    const userId = typeof body.userId === 'number' ? body.userId : Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ error: 'userId must be a positive integer' });
      return;
    }
    const accessLevel = body.accessLevel === 'manager' ? 'manager' : 'member';

    const { resolveVisibleQueue } = await import('./modules/workspace/queueService');
    try {
      const queue = await resolveVisibleQueue(user, String(req.params.slug));
      await addQueueMember(queue.id, userId, user, accessLevel);
      res.json({ ok: true, members: await listQueueMembers(queue.id) });
    } catch (err) {
      if (err instanceof QueueNotVisibleError) {
        res.status(403).json({ error: 'queue-not-visible' });
        return;
      }
      if (err instanceof QueueNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

app.delete('/api/queues/:slug/members/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await requireQueueUser(req, res, true);
    if (!user) return;
    const userId = parseInt(String(req.params.userId), 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ error: 'userId must be a positive integer' });
      return;
    }
    const { resolveVisibleQueue } = await import('./modules/workspace/queueService');
    try {
      const queue = await resolveVisibleQueue(user, String(req.params.slug));
      await removeQueueMember(queue.id, userId, user);
      res.json({ ok: true, members: await listQueueMembers(queue.id) });
    } catch (err) {
      if (err instanceof QueueNotVisibleError) {
        res.status(403).json({ error: 'queue-not-visible' });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** Manual re-queue of one workspace (AC17). */
app.post('/api/workspaces/:id/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(400).json({ error: 'workspace id must be a positive integer' });
      return;
    }
    const user = await requireQueueUser(req, res, true);
    if (!user) return;

    const body = (req.body ?? {}) as { queueId?: unknown; reason?: unknown };
    const queueId = typeof body.queueId === 'number' ? body.queueId : Number(body.queueId);
    if (!Number.isInteger(queueId) || queueId <= 0) {
      res.status(400).json({ error: 'queueId must be a positive integer' });
      return;
    }
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : undefined;

    try {
      await moveWorkspace(workspaceId, queueId, user, reason);
      res.json({ ok: true, workspaceId, queueId });
    } catch (err) {
      if (err instanceof QueueNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

/** Per-user saved filter sets (AC12). */
app.get('/api/saved-filters', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await requireQueueUser(req, res, true);
    if (!user) return;
    res.json({ savedFilters: await listSavedFilters(user.id) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/saved-filters', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await requireQueueUser(req, res, true);
    if (!user) return;
    const body = (req.body ?? {}) as { name?: unknown; filters?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    // The stored set goes through the same allow-list as a query string, so a
    // saved filter is not a privileged path into the filter object.
    const filters = parseFilters((body.filters ?? {}) as Record<string, unknown>);
    const saved = await saveFilter(user.id, name, filters);
    res.json({ ok: true, savedFilter: saved });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/saved-filters/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await requireQueueUser(req, res, true);
    if (!user) return;
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }
    try {
      // Scoped to the owner inside the service, so this is a miss rather than a
      // cross-user delete.
      await deleteSavedFilter(user.id, id);
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof SavedFilterNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
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

// ── Referral conversation (PRD-22) ───────────────────────────────────────────

function sendCommentError(err: unknown, res: Response): boolean {
  if (err instanceof CommentWorkspaceNotFoundError || err instanceof CommentNotFoundError) {
    res.status(404).json({ error: err.message });
    return true;
  }
  if (
    err instanceof CommentEmptyError ||
    err instanceof CommentTooLongError ||
    err instanceof MentionTargetError ||
    err instanceof GuestVisibilityError
  ) {
    res.status(400).json({ error: err.message });
    return true;
  }
  // 422 rather than 400: the body is well-formed and the values are valid, but
  // the request is refused on a deliberateness rule.
  if (err instanceof ShareNotConfirmedError || err instanceof SharedMentionError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  if (err instanceof CommentNotAuthorError) {
    res.status(403).json({ error: err.message });
    return true;
  }
  // 409: well-formed, permitted in principle, refused by the comment's current
  // state. A retry after reloading may succeed — except for the downgrade,
  // which never will, and whose message says so.
  if (
    err instanceof VisibilityDowngradeError ||
    err instanceof CommentDeletedError ||
    err instanceof CommentRevisionConflictError
  ) {
    res.status(409).json({ error: err.message });
    return true;
  }
  return false;
}

/** The mention id lists, read defensively — a client sends whatever it likes. */
function parseMentions(raw: unknown): { users?: number[]; parties?: number[] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const body = raw as { users?: unknown; parties?: unknown };
  const ids = (value: unknown): number[] | undefined =>
    Array.isArray(value) ? value.map(Number).filter((n) => Number.isInteger(n) && n > 0) : undefined;
  return { users: ids(body.users), parties: ids(body.parties) };
}

function parseVisibility(raw: unknown): CommentVisibility | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !isCommentVisibility(raw)) return undefined;
  return raw;
}

function parseCommentId(req: Request): number | null {
  const raw = Array.isArray(req.params.commentId) ? req.params.commentId[0] : req.params.commentId;
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

app.get('/api/workspaces/:id/comments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    const user = await tryGetActingUser(req);
    res.json({
      comments: await listComments(workspaceId),
      // Scoped to the acting user: "mentions waiting for me", not a global count.
      openMentions: user ? await openMentionCount(workspaceId, user.id) : 0,
    });
  } catch (err) {
    if (!sendCommentError(err, res)) next(err);
  }
});

app.post('/api/workspaces/:id/comments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    const body = (req.body ?? {}) as {
      body?: unknown;
      visibility?: unknown;
      confirmShared?: unknown;
      mentions?: unknown;
    };

    // A supplied visibility that is not one of the two is refused rather than
    // defaulted: silently treating "shared" as Internal would be confusing, and
    // treating it as Shared would be dangerous.
    if (body.visibility !== undefined && parseVisibility(body.visibility) === undefined) {
      res.status(400).json({ error: 'visibility must be "Internal" or "Shared".' });
      return;
    }

    const user = await tryGetActingUser(req);
    if (!user) {
      res.status(401).json({ error: 'No acting user. Seed users before commenting.' });
      return;
    }

    const comment = await postComment({
      workspaceId,
      body: typeof body.body === 'string' ? body.body : '',
      visibility: parseVisibility(body.visibility),
      confirmShared: body.confirmShared === true,
      author: { kind: 'user', user },
      mentions: parseMentions(body.mentions),
    });
    res.json({ success: true, comment });
  } catch (err) {
    if (!sendCommentError(err, res)) next(err);
  }
});

app.patch(
  '/api/workspaces/:id/comments/:commentId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      const commentId = parseCommentId(req);
      if (workspaceId === null || commentId === null) {
        res.status(404).json({ error: 'Comment not found' });
        return;
      }
      const body = (req.body ?? {}) as {
        body?: unknown;
        visibility?: unknown;
        confirmShared?: unknown;
        mentions?: unknown;
      };
      const visibility = parseVisibility(body.visibility);
      if (visibility === undefined) {
        res.status(400).json({ error: 'visibility must be "Internal" or "Shared".' });
        return;
      }

      const user = await tryGetActingUser(req);
      if (!user) {
        res.status(401).json({ error: 'No acting user. Seed users before commenting.' });
        return;
      }

      const comment = await editComment({
        workspaceId,
        commentId,
        body: typeof body.body === 'string' ? body.body : '',
        visibility,
        confirmShared: body.confirmShared === true,
        user,
        mentions: parseMentions(body.mentions),
      });
      res.json({ success: true, comment });
    } catch (err) {
      if (!sendCommentError(err, res)) next(err);
    }
  },
);

app.delete(
  '/api/workspaces/:id/comments/:commentId',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      const commentId = parseCommentId(req);
      if (workspaceId === null || commentId === null) {
        res.status(404).json({ error: 'Comment not found' });
        return;
      }
      // 200 with the tombstoned comment rather than 204, so the panel re-renders
      // from the response instead of reloading the whole thread.
      const comment = await deleteComment(workspaceId, commentId, await actingActor(req));
      res.json({ success: true, comment });
    } catch (err) {
      if (!sendCommentError(err, res)) next(err);
    }
  },
);

/**
 * THE AUDIT PATH. The only way to read a superseded or tombstoned revision, and
 * deliberately internal-only — there is no guest equivalent.
 */
app.get(
  '/api/workspaces/:id/comments/:commentId/history',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      const commentId = parseCommentId(req);
      if (workspaceId === null || commentId === null) {
        res.status(404).json({ error: 'Comment not found' });
        return;
      }
      res.json({ revisions: await getCommentHistory(workspaceId, commentId) });
    } catch (err) {
      if (!sendCommentError(err, res)) next(err);
    }
  },
);

/** Drives the mention picker AND the share confirmation's "who will read this". */
app.get(
  '/api/workspaces/:id/mention-targets',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      if (workspaceId === null) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
      res.json(await mentionTargets(workspaceId));
    } catch (err) {
      if (!sendCommentError(err, res)) next(err);
    }
  },
);

app.post(
  '/api/workspaces/:id/mentions/ack',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      if (workspaceId === null) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
      const user = await tryGetActingUser(req);
      if (!user) {
        res.status(401).json({ error: 'No acting user.' });
        return;
      }
      res.json({
        acknowledged: await acknowledgeMentions(workspaceId, user.id, formatActor(user)),
      });
    } catch (err) {
      if (!sendCommentError(err, res)) next(err);
    }
  },
);

/**
 * A GUEST commenting. The workspace and the party come from the SESSION, never
 * the body, and the visibility is not accepted at all — a supplied value other
 * than `Shared` is refused rather than coerced, so a client bug surfaces.
 */
app.post('/api/guest/comments', async (req: Request, res: Response) => {
  let guest: GuestContext;
  try {
    guest = await requireGuest(req);
  } catch (err) {
    sendGuestDenied(err, req, res, true);
    return;
  }
  try {
    const body = (req.body ?? {}) as { body?: unknown; visibility?: unknown };

    // Refused, never coerced. Checked here against the literal rather than
    // through parseVisibility(), which returns undefined for an unrecognised
    // string — and undefined would then be read as "not supplied" and quietly
    // become Shared, which is the coercion this rule exists to prevent.
    if (body.visibility !== undefined && body.visibility !== 'Shared') {
      res.status(400).json({
        error: 'A comment posted from outside your organization is always shared.',
      });
      return;
    }

    const comment = await postComment({
      workspaceId: guest.workspaceId,
      body: typeof body.body === 'string' ? body.body : '',
      author: { kind: 'guest', guest },
    });
    // The guest gets back only what a guest may see, not the internal shape.
    res.json({
      success: true,
      comment: {
        id: comment.id,
        body: comment.body,
        authorDisplayName: comment.authorDisplayName,
        authorOrgName: comment.authorPartyOrgName ?? guest.partyOrgName,
        createdAt: comment.createdAt.toISOString(),
        edited: false,
        own: true,
      },
    });
  } catch (err) {
    if (!sendCommentError(err, res)) {
      console.error('[Guest/Comment]', err);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  }
});

// ── Document collection (PRD-23) ─────────────────────────────────────────────

function sendDocumentError(err: unknown, res: Response): boolean {
  if (err instanceof DocumentNotFoundError || err instanceof DocumentWorkspaceNotFoundError) {
    res.status(404).json({ error: err.message });
    return true;
  }
  if (err instanceof DocumentAccessDeniedError) {
    res.status(403).json({ error: err.message });
    return true;
  }
  // 410 rather than 404: the index entry is real and the content behind it has
  // gone. A reader should be told the document WAS here, not that it never was.
  if (err instanceof DocumentContentUnavailableError) {
    res.status(410).json({ error: err.message });
    return true;
  }
  if (err instanceof UploadTooLargeError) {
    res.status(413).json({ error: err.message });
    return true;
  }
  if (
    err instanceof UploadEmptyError ||
    err instanceof UploadTypeNotAllowedError ||
    err instanceof GuestUploadVisibilityError
  ) {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

/**
 * The upload body.
 *
 * `express.raw` rather than a multipart parser: no such dependency exists in
 * this project, it is mounted per route so the size cap touches nothing else,
 * and a Buffer is what lets the service detect the real type from magic bytes
 * instead of trusting the client's declared one.
 *
 * `type: () => true` accepts any content type on purpose — the declared type is
 * not the gate. The allow-list is applied to the BYTES, in the service.
 */
const rawUploadBody = express.raw({
  type: () => true,
  limit: config.workspace.maxUploadBytes,
});

/**
 * Wraps the raw parser so its own failure answers in this route's vocabulary.
 * Without this the body-parser's error skips the handler entirely and surfaces
 * from the global error handler as a generic 500.
 */
function uploadBody(req: Request, res: Response, next: NextFunction): void {
  rawUploadBody(req, res, (err?: unknown) => {
    if (!err) {
      next();
      return;
    }
    const status = (err as { status?: number }).status;
    if (status === 413) {
      res.status(413).json({
        error:
          'That file is larger than the upload limit of ' +
          `${Math.round(config.workspace.maxUploadBytes / 1024 / 1024)} MB.`,
      });
      return;
    }
    res.status(400).json({ error: 'Could not read that upload.' });
  });
}

/** Header values are latin-1, so the client percent-encodes the filename. */
function decodeHeader(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed percent sequence is the client's problem, not a 500. Fall back
    // to the literal so the upload still lands with a usable name.
    return raw;
  }
}

function parseDocumentId(req: Request): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** RFC 5987, so a non-ASCII filename survives Content-Disposition. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

app.get('/api/workspaces/:id/documents', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.json({ documents: await listDocuments(workspaceId) });
  } catch (err) {
    if (!sendDocumentError(err, res)) next(err);
  }
});

/**
 * One content endpoint for every indexed document. The guest cookie cannot
 * reach it — the middleware above refuses anything outside /guest and
 * /api/guest — so a guest uses /api/guest/documents/:id/content instead.
 */
app.get('/api/documents/:id/content', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const documentId = parseDocumentId(req);
    if (documentId === null) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    const download = req.query.download === '1';
    const user = await tryGetActingUser(req);

    // Existence first, so the access record has a document to hang off — its
    // foreign key is real.
    await getDocument(documentId);

    // THEN the record, BEFORE any attempt that can fail. The smoke check caught
    // this the other way round: resolving first meant a document whose content
    // had vanished answered 410 and left no evidence that anybody had tried to
    // read it, which is the one case an auditor most wants to see.
    await recordAccess(
      documentId,
      user ? { userId: user.id } : {},
      download ? 'download' : 'view',
    );

    const content = await resolveContent(documentId);

    res.setHeader('Content-Type', content.contentType);
    if (download) res.setHeader('Content-Disposition', contentDisposition(content.filename));
    res.send(content.body);
  } catch (err) {
    if (!sendDocumentError(err, res)) next(err);
  }
});

/**
 * The document-keyed viewer frame. The referral-keyed pair
 * (`/referrals/:id/ccda-frame` and `/referrals/:id/ccda.xml`) is untouched: the
 * review page depends on it, and breaking it for tidiness would be a regression
 * for no user benefit.
 */
app.get('/documents/:id/ccda-frame', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const documentId = parseDocumentId(req);
    if (documentId === null) {
      res.status(404).send('Not found');
      return;
    }
    const document = await getDocument(documentId);
    if (document.renderAs !== 'ccda') {
      res.status(404).send('That document is not a clinical document.');
      return;
    }

    const templatePath = path.join(__dirname, 'views', 'ccdaFrame.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.send(
      template.replace(
        '/*__CCDA_FRAME_DATA__*/',
        `window.__CCDA_FRAME__ = ${embedJson({ url: `/api/documents/${documentId}/content` })};`,
      ),
    );
  } catch (err) {
    if (!sendDocumentError(err, res)) next(err);
  }
});

app.post(
  '/api/workspaces/:id/documents',
  uploadBody,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = parseWorkspaceId(req);
      if (workspaceId === null) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
      const user = await tryGetActingUser(req);
      if (!user) {
        res.status(401).json({ error: 'No acting user. Seed users before uploading.' });
        return;
      }

      const declared = req.headers['x-document-visibility'];
      const visibilityHeader = Array.isArray(declared) ? declared[0] : declared;
      if (
        visibilityHeader !== undefined &&
        (typeof visibilityHeader !== 'string' || !isCommentVisibility(visibilityHeader))
      ) {
        res.status(400).json({ error: 'X-Document-Visibility must be "Internal" or "Shared".' });
        return;
      }

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const document = await uploadDocument({
        workspaceId,
        body,
        claimedContentType: req.headers['content-type'] ?? null,
        originalFilename: decodeHeader(req.headers['x-document-filename']),
        docType: decodeHeader(req.headers['x-document-type']) || undefined,
        visibility: visibilityHeader,
        uploader: { kind: 'user', user },
      });

      res.json({
        success: true,
        documentId: document.id,
        detectedContentType: document.contentType,
        // Always false. The field exists so the guarantee is in the response
        // rather than only in a comment: uploading never transmits, and sending
        // is a separate explicit assertion (PRD-29).
        transmitted: false,
        document,
      });
    } catch (err) {
      if (!sendDocumentError(err, res)) next(err);
    }
  },
);

app.get('/api/documents/:id/access-log', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const documentId = parseDocumentId(req);
    if (documentId === null) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    res.json({ access: await getAccessLog(documentId) });
  } catch (err) {
    if (!sendDocumentError(err, res)) next(err);
  }
});

app.post('/api/workspaces/documents/backfill', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { backfillDocuments } = await import('./modules/workspace/documentService');
    res.json({ success: true, ...(await backfillDocuments()) });
  } catch (err) {
    next(err);
  }
});

// ── Guest document access (PRD-23 × PRD-30) ──────────────────────────────────

app.get('/api/guest/documents', async (req: Request, res: Response) => {
  let guest: GuestContext;
  try {
    guest = await requireGuest(req);
  } catch (err) {
    sendGuestDenied(err, req, res, true);
    return;
  }
  try {
    res.json({ documents: await listSharedDocuments(guest.workspaceId, guest.guestId) });
  } catch (err) {
    if (!sendDocumentError(err, res)) {
      console.error('[Guest/Documents]', err);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  }
});

/**
 * A guest fetching content. `assertGuestMayRead()` applies BOTH gates —
 * visibility and scope — and records the refusal itself, so this route cannot
 * check one and forget the other.
 */
app.get('/api/guest/documents/:id/content', async (req: Request, res: Response) => {
  let guest: GuestContext;
  try {
    guest = await requireGuest(req);
  } catch (err) {
    sendGuestDenied(err, req, res, true);
    return;
  }
  try {
    const documentId = parseDocumentId(req);
    if (documentId === null) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    // Establishes existence and both gates, and records a refusal itself.
    await assertGuestMayRead(documentId, guest);

    const download = req.query.download === '1';
    // Before the attempt, for the same reason as the internal route.
    await recordAccess(documentId, { guestId: guest.guestId }, download ? 'download' : 'view');
    const content = await resolveContent(documentId);

    res.setHeader('Content-Type', content.contentType);
    if (download) res.setHeader('Content-Disposition', contentDisposition(content.filename));
    res.send(content.body);
  } catch (err) {
    if (!sendDocumentError(err, res)) {
      console.error('[Guest/Documents]', err);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  }
});

/** The guest's own viewer frame, allowed by the middleware because of its path. */
app.get('/guest/documents/:id/ccda-frame', async (req: Request, res: Response) => {
  let guest: GuestContext;
  try {
    guest = await requireGuest(req);
  } catch (err) {
    sendGuestDenied(err, req, res, false);
    return;
  }
  try {
    const documentId = parseDocumentId(req);
    if (documentId === null) {
      res.status(404).send('Not found');
      return;
    }
    const document = await assertGuestMayRead(documentId, guest);
    if (document.renderAs !== 'ccda') {
      res.status(404).send('That document is not a clinical document.');
      return;
    }

    const templatePath = path.join(__dirname, 'views', 'ccdaFrame.html');
    const template = fs.readFileSync(templatePath, 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.send(
      template.replace(
        '/*__CCDA_FRAME_DATA__*/',
        `window.__CCDA_FRAME__ = ${embedJson({
          url: `/api/guest/documents/${documentId}/content`,
        })};`,
      ),
    );
  } catch (err) {
    if (!sendDocumentError(err, res)) {
      console.error('[Guest/Documents]', err);
      res.status(500).send('Something went wrong.');
    }
  }
});

app.post('/api/guest/documents', uploadBody, async (req: Request, res: Response) => {
  let guest: GuestContext;
  try {
    guest = await requireGuest(req);
  } catch (err) {
    sendGuestDenied(err, req, res, true);
    return;
  }
  try {
    // Refused, never coerced, exactly as the guest comment route does.
    const declared = req.headers['x-document-visibility'];
    const visibilityHeader = Array.isArray(declared) ? declared[0] : declared;
    if (visibilityHeader !== undefined && visibilityHeader !== 'Shared') {
      res.status(400).json({
        error: 'A document uploaded from outside your organization is always shared.',
      });
      return;
    }

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const document = await uploadDocument({
      workspaceId: guest.workspaceId,
      body,
      claimedContentType: req.headers['content-type'] ?? null,
      originalFilename: decodeHeader(req.headers['x-document-filename']),
      docType: decodeHeader(req.headers['x-document-type']) || undefined,
      uploader: { kind: 'guest', guest },
    });

    res.json({
      success: true,
      documentId: document.id,
      detectedContentType: document.contentType,
      transmitted: false,
    });
  } catch (err) {
    if (!sendDocumentError(err, res)) {
      console.error('[Guest/Documents]', err);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  }
});

// ── Activity history (PRD-25) ───────────────────────────────────

function parseActivityKind(raw: unknown): ActivityKind | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !value) return undefined;
  return (ACTIVITY_KINDS as readonly string[]).includes(value)
    ? (value as ActivityKind)
    : undefined;
}

app.get('/api/workspaces/:id/activity', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = parseWorkspaceId(req);
    if (workspaceId === null) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    // An unrecognised ?kind is treated as no filter rather than as an error: a
    // stale bookmark should show the whole feed, not a 400.
    res.json(await getActivityFeed(workspaceId, parseActivityKind(req.query.kind)));
  } catch (err) {
    if (err instanceof ActivityWorkspaceNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    next(err);
  }
});

/**
 * The guest feed. Built from an allow-list of protocol milestones, not the
 * internal feed with entries removed — so an internal event type added by a
 * later PRD cannot surface here by default.
 */
app.get('/api/guest/activity', async (req: Request, res: Response) => {
  let guest: GuestContext;
  try {
    guest = await requireGuest(req);
  } catch (err) {
    sendGuestDenied(err, req, res, true);
    return;
  }
  try {
    res.json(await getGuestActivityFeed(guest));
  } catch (err) {
    console.error('[Guest/Activity]', err);
    res.status(500).json({ error: 'Something went wrong.' });
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

    // PRD-25: this route changed the department and recorded NOTHING, so a
    // coordinator rerouting a referral left no trace at all. Both the previous
    // and the new value are recorded — a change event with only the new value
    // cannot answer "what did somebody change it FROM", which is the question
    // an auditor actually asks.
    void emitEvent({
      eventType: ReferralEvents.ROUTING_CHANGED,
      entityType: 'referral',
      entityId: referralId,
      actor: await actingActor(req),
      metadata: {
        previousDepartment: referral.routingDepartment,
        department: updates.routingDepartment ?? referral.routingDepartment,
        previousEquipment: referral.routingEquipment,
        equipment: updates.routingEquipment ?? referral.routingEquipment,
      },
    }).catch((err) => console.error('[Routing]', err));

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

    // PRD-25 fixed the bypass this route used to carry. It wrote `state` twice
    // from string literals; now both reversals go through reopenReferral(),
    // which uses transition() for the legal one (Pending-Information) and is the
    // single audited exception for the illegal one (Declined is terminal).
    const [referral] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    const reopenable =
      referral &&
      (referral.state === ReferralState.DECLINED ||
        referral.state === ReferralState.PENDING_INFORMATION);

    if (reopenable) {
      await reopenReferral(referralId, await actingActor(req), reason);
      // PRD-18: keep the work status in step. Only after a reopen actually
      // happened — proposing for a referral that was already Acknowledged was
      // always a no-op the old condition happened to allow.
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
    // 409, not a 500: the request was well formed and the referral's current
    // state refused it. Reachable if the state changes between the read above
    // and the reopen.
    if (err instanceof NotReopenableError) {
      res.status(409).json({ error: err.message });
      return;
    }
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
