/**
 * PRD-19 — the workspace payload.
 *
 * Assembles everything `workspaceDetail.html` renders, and the row summaries the
 * flat index at `GET /workspaces` lists. Kept out of server.ts so the shape is
 * testable without standing up Express, and so each later PRD adds its slice
 * here rather than in a route handler.
 *
 * The payload deliberately carries nulls rather than omitting absent fields: for
 * all of Phase 2 a workspace normally has no owner, no queue and no next action,
 * and the page has to render that as an explicit empty state (AC2) rather than
 * discover a missing key at runtime.
 */

import { eq, desc, isNull } from 'drizzle-orm';
import { db } from '../../db';
import {
  referrals,
  patients,
  outboundMessages,
  priorAuthRequests,
  referralWorkspaces,
} from '../../db/schema';
import { ReferralState } from '../../state/referralStateMachine';
import { WorkStatus, allowedTransitions } from '../../state/workStatusMachine';
import { getWorkspace, getWorkspaceByReferralId } from './workspaceService';
import { ActingUser, getUser } from './identityService';
import { Party, PartyRole, ProtocolMode, getParties } from './partyService';
import { Participant, ParticipantRole, getParticipants } from './participantService';
import { getDepartments, getResources } from '../prd03/resourceCalendar';
import { ExtendedReferralData } from '../prd01/cdaParser';
import { RoutingAssessment } from '../prd02/claudeService';

/**
 * Defined here rather than imported: PRD-19's draft named `PriorAuthSummary` as
 * though it already existed. It does not — this is the view model over
 * `prior_auth_requests`, matching the columns the review page already selects.
 */
export interface PriorAuthSummary {
  id: number;
  state: string;
  insurerName: string;
  serviceCode: string;
  createdAt: string;
}

/**
 * One organization on the referral, as the page renders it (PRD-24).
 *
 * `addresses` is every address seen from this party, which is usually more than
 * one: an organization provisions org intake, departmental and per-clinician
 * addresses, often all at once. `directAddress` is the single canonical intake
 * address — the one PRD-29 replies to — not the whole picture.
 */
export interface PartySummary {
  id: number;
  orgName: string;
  orgNameVerified: boolean;
  directAddress: string | null;
  partyRole: PartyRole;
  protocolMode: ProtocolMode;
  /** Null => the mode is assumed rather than proven by a real exchange. */
  capabilityVerifiedAt: string | null;
  contactName: string | null;
  addresses: { address: string; addressKind: string | null }[];
}

/** One internal person on the referral beyond the owner (PRD-24). */
export interface ParticipantSummary {
  userId: number;
  displayName: string;
  jobRole: string;
  role: ParticipantRole;
  addedAt: string;
  addedByDisplayName: string | null;
  inactive: boolean;
  isOwner: boolean;
}

export interface OutboundMessageSummary {
  id: number;
  messageType: string;
  status: string;
  sentAt: string;
  acknowledgedAt: string | null;
}

export interface WorkspacePayload {
  workspace: {
    id: number;
    referralId: number;
    workStatus: WorkStatus;
    /** From the machine, for the header control — never hand-maintained here. */
    allowedWorkStatuses: WorkStatus[];
    /** Drives the resync control: true means a person is holding the status. */
    workStatusIsManual: boolean;
    workStatusSetBy: string | null;
    workStatusSetAt: string | null;
    ownerUserId: number | null;
    ownerDisplayName: string | null;
    /** True when the owner has since been deactivated (PRD-21 AC7a). */
    ownerInactive: boolean;
    queueId: number | null;
    /** Always null until PRD-20 adds the queues table — there is nothing to join. */
    queueName: string | null;
    nextAction: string | null;
    nextActionDueAt: string | null;
    externalReferralId: string | null;
    exceptionReason: string | null;
    archivedAt: string | null;
  };
  referral: {
    id: number;
    state: ReferralState;
    reasonForReferral: string | null;
    declineReason: string | null;
    referrerAddress: string;
    routingDepartment: string;
    routingEquipment: string[];
    priorityFlag: boolean;
    clinicianId: string | null;
    appointmentDate: string | null;
    appointmentLocation: string | null;
    scheduledProvider: string | null;
    createdAt: string;
    hasCcda: boolean;
  };
  patient: { firstName: string; lastName: string; dateOfBirth: string };
  parties: PartySummary[];
  participants: ParticipantSummary[];
  clinicalData: ExtendedReferralData | null;
  assessment: RoutingAssessment | null;
  priorAuth: PriorAuthSummary[];
  outboundMessages: OutboundMessageSummary[];
  actingUser: ActingUser | null;
  departments: string[];
  resources: { id: string; name: string; department: string }[];
  /**
   * Which reserved panels have real content. Each later PRD flips its own flag
   * on; the shell renders a labelled "coming in PRD-NN" state for the rest, so
   * the layout is the real layout from day one (AC13).
   */
  slots: {
    conversation: boolean;
    documents: boolean;
    activity: boolean;
    participants: boolean;
    owner: boolean;
  };
}

/** One row of the flat index at `GET /workspaces`. */
export interface WorkspaceRowSummary {
  workspaceId: number;
  referralId: number;
  patientName: string;
  protocolState: ReferralState;
  workStatus: WorkStatus;
  workStatusIsManual: boolean;
  ownerUserId: number | null;
  ownerDisplayName: string | null;
  /** True when the owner has since been deactivated (AC7a). */
  ownerInactive: boolean;
  routingDepartment: string;
  priorityFlag: boolean;
  archived: boolean;
  updatedAt: string;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** Tolerates a malformed DB value rather than failing the whole page for it. */
function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Builds the payload for one workspace, or returns null when the id does not
 * resolve — the route turns that into a 404 (AC4) rather than a stack trace.
 *
 * `actingUser` is passed in rather than read here so this stays independent of
 * Express and therefore unit-testable.
 */
export async function buildWorkspacePayload(
  workspaceId: number,
  actingUser: ActingUser | null,
): Promise<WorkspacePayload | null> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) return null;

  const [referral] = await db
    .select()
    .from(referrals)
    .where(eq(referrals.id, workspace.referralId));

  // A workspace has a NOT NULL FK to referrals, so this is unreachable short of
  // manual database surgery. Treated as not-found rather than thrown: a missing
  // referral is not something a coordinator can act on.
  if (!referral) return null;

  const [patient] = await db.select().from(patients).where(eq(patients.id, referral.patientId));

  const owner = workspace.ownerUserId === null ? null : await getUser(workspace.ownerUserId);

  const paRequests = await db
    .select({
      id: priorAuthRequests.id,
      state: priorAuthRequests.state,
      insurerName: priorAuthRequests.insurerName,
      serviceCode: priorAuthRequests.serviceCode,
      createdAt: priorAuthRequests.createdAt,
    })
    .from(priorAuthRequests)
    .where(eq(priorAuthRequests.referralId, referral.id))
    .orderBy(desc(priorAuthRequests.createdAt));

  const messages = await db
    .select()
    .from(outboundMessages)
    .where(eq(outboundMessages.referralId, referral.id));

  // PRD-24. Both are fetched even for a workspace that has neither, so the
  // panel renders an explicit empty state rather than disappearing — a missing
  // parties list means the backfill has not run, which is worth seeing.
  const parties: Party[] = await getParties(workspace.id);
  const participants: Participant[] = await getParticipants(workspace.id);

  return {
    workspace: {
      id: workspace.id,
      referralId: workspace.referralId,
      workStatus: workspace.workStatus,
      allowedWorkStatuses: allowedTransitions(workspace.workStatus),
      workStatusIsManual: workspace.workStatusIsManual,
      workStatusSetBy: workspace.workStatusSetBy,
      workStatusSetAt: iso(workspace.workStatusSetAt),
      ownerUserId: workspace.ownerUserId,
      ownerDisplayName: owner?.displayName ?? null,
      ownerInactive: owner !== null && owner.active === false,
      queueId: workspace.queueId,
      queueName: null,
      nextAction: workspace.nextAction,
      nextActionDueAt: iso(workspace.nextActionDueAt),
      externalReferralId: workspace.externalReferralId,
      exceptionReason: workspace.exceptionReason,
      archivedAt: iso(workspace.archivedAt),
    },
    referral: {
      id: referral.id,
      state: referral.state as ReferralState,
      reasonForReferral: referral.reasonForReferral,
      declineReason: referral.declineReason,
      referrerAddress: referral.referrerAddress,
      routingDepartment: referral.routingDepartment,
      routingEquipment: parseJson<string[]>(referral.routingEquipment) ?? [],
      priorityFlag: !!referral.priorityFlag,
      clinicianId: referral.clinicianId,
      appointmentDate: referral.appointmentDate,
      appointmentLocation: referral.appointmentLocation,
      scheduledProvider: referral.scheduledProvider,
      createdAt: referral.createdAt.toISOString(),
      hasCcda: !!referral.rawCcdaXml,
    },
    patient: patient
      ? {
          firstName: patient.firstName,
          lastName: patient.lastName,
          dateOfBirth: patient.dateOfBirth,
        }
      : { firstName: '', lastName: '', dateOfBirth: '' },
    parties: parties.map((p) => ({
      id: p.id,
      orgName: p.orgName,
      orgNameVerified: p.orgNameVerified,
      directAddress: p.directAddress,
      partyRole: p.partyRole,
      protocolMode: p.protocolMode,
      capabilityVerifiedAt: iso(p.capabilityVerifiedAt),
      contactName: p.contactName,
      addresses: p.addresses.map((a) => ({ address: a.address, addressKind: a.addressKind })),
    })),
    participants: participants.map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      jobRole: p.jobRole,
      role: p.role,
      addedAt: p.addedAt.toISOString(),
      addedByDisplayName: p.addedByDisplayName,
      inactive: p.inactive,
      isOwner: p.isOwner,
    })),
    clinicalData: parseJson<ExtendedReferralData>(referral.clinicalData),
    assessment: parseJson<RoutingAssessment>(referral.aiAssessment),
    priorAuth: paRequests.map((r) => ({
      id: r.id,
      state: r.state,
      insurerName: r.insurerName,
      serviceCode: r.serviceCode,
      createdAt: r.createdAt.toISOString(),
    })),
    outboundMessages: messages.map((m) => ({
      id: m.id,
      messageType: m.messageType,
      status: m.status,
      sentAt: m.sentAt.toISOString(),
      acknowledgedAt: iso(m.acknowledgedAt),
    })),
    actingUser,
    departments: getDepartments(),
    resources: getResources().map((r) => ({
      id: r.id,
      name: r.name,
      department: r.department,
    })),
    slots: {
      activity: false,
      // PRD-21, PRD-24, PRD-22 and PRD-23 filled these. The shell stops
      // rendering their placeholders. Only PRD-25's activity feed is left.
      documents: true,
      conversation: true,
      participants: true,
      owner: true,
    },
  };
}

/**
 * Resolves a referral id to its workspace payload, for
 * `GET /referrals/:referralId/workspace`.
 */
export async function workspaceIdForReferral(referralId: number): Promise<number | null> {
  const workspace = await getWorkspaceByReferralId(referralId);
  return workspace?.id ?? null;
}

/**
 * How `listWorkspaceRows()` narrows by ownership (PRD-21).
 *
 * `'me'` is resolved by the caller into a user id before it gets here; the
 * literal never reaches the query. Keeping the string out of this layer means a
 * future caller cannot accidentally pass an attacker-supplied "me".
 */
export type OwnerFilter = { kind: 'any' } | { kind: 'unassigned' } | { kind: 'user'; userId: number };

/**
 * Every workspace, newest activity first, for the flat index.
 *
 * Deliberately unfiltered and unscoped. PRD-20 adds queue grouping, the tab
 * vocabulary and `allQueuesAccess` scoping, and may replace this page outright
 * rather than extend it — this exists so the detail page is reachable.
 */
export async function listWorkspaceRows(
  owner: OwnerFilter = { kind: 'any' },
): Promise<WorkspaceRowSummary[]> {
  // Filtered in SQL rather than in the browser: PRD-20 inherits this function
  // for the queue view, and a paged list cannot filter client-side.
  const ownerClause =
    owner.kind === 'unassigned'
      ? isNull(referralWorkspaces.ownerUserId)
      : owner.kind === 'user'
        ? eq(referralWorkspaces.ownerUserId, owner.userId)
        : undefined;

  const rows = await db
    .select({
      workspaceId: referralWorkspaces.id,
      referralId: referralWorkspaces.referralId,
      workStatus: referralWorkspaces.workStatus,
      workStatusIsManual: referralWorkspaces.workStatusIsManual,
      ownerUserId: referralWorkspaces.ownerUserId,
      archivedAt: referralWorkspaces.archivedAt,
      updatedAt: referralWorkspaces.updatedAt,
      protocolState: referrals.state,
      routingDepartment: referrals.routingDepartment,
      priorityFlag: referrals.priorityFlag,
      firstName: patients.firstName,
      lastName: patients.lastName,
    })
    .from(referralWorkspaces)
    .innerJoin(referrals, eq(referrals.id, referralWorkspaces.referralId))
    .innerJoin(patients, eq(patients.id, referrals.patientId))
    .where(ownerClause)
    .orderBy(desc(referralWorkspaces.updatedAt));

  // One lookup per distinct owner rather than per row. Phase 2 has no owners at
  // all, so this is usually a single empty map.
  const ownerIds = [
    ...new Set(rows.map((r) => r.ownerUserId).filter((id): id is number => id !== null)),
  ];
  // Name AND active flag: getUser() returns deactivated users on purpose, so a
  // workspace whose owner has left still shows who holds it rather than reading
  // as unassigned (AC7a).
  const owners = new Map<number, { displayName: string; active: boolean }>();
  for (const id of ownerIds) {
    const user = await getUser(id);
    if (user) owners.set(id, { displayName: user.displayName, active: user.active });
  }

  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    referralId: r.referralId,
    patientName: `${r.firstName} ${r.lastName}`.trim(),
    protocolState: r.protocolState as ReferralState,
    workStatus: r.workStatus as WorkStatus,
    workStatusIsManual: r.workStatusIsManual,
    ownerUserId: r.ownerUserId,
    ownerDisplayName:
      r.ownerUserId === null ? null : (owners.get(r.ownerUserId)?.displayName ?? null),
    ownerInactive: r.ownerUserId !== null && owners.get(r.ownerUserId)?.active === false,
    routingDepartment: r.routingDepartment,
    priorityFlag: !!r.priorityFlag,
    archived: r.archivedAt !== null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}
