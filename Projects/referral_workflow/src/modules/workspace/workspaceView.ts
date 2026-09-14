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

import { eq, desc } from 'drizzle-orm';
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
 * PRD-24 defines the real shape. Until then `parties` is always `[]`, so this
 * placeholder exists only to keep the payload type honest about the field.
 */
export type PartySummary = Record<string, never>;

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
  ownerDisplayName: string | null;
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
    parties: [],
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
      conversation: false,
      documents: false,
      activity: false,
      participants: false,
      owner: false,
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
 * Every workspace, newest activity first, for the flat index.
 *
 * Deliberately unfiltered and unscoped. PRD-20 adds queue grouping, the tab
 * vocabulary and `allQueuesAccess` scoping, and may replace this page outright
 * rather than extend it — this exists so the detail page is reachable.
 */
export async function listWorkspaceRows(): Promise<WorkspaceRowSummary[]> {
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
    .orderBy(desc(referralWorkspaces.updatedAt));

  // One lookup per distinct owner rather than per row. Phase 2 has no owners at
  // all, so this is usually a single empty map.
  const ownerIds = [
    ...new Set(rows.map((r) => r.ownerUserId).filter((id): id is number => id !== null)),
  ];
  const ownerNames = new Map<number, string>();
  for (const id of ownerIds) {
    const user = await getUser(id);
    if (user) ownerNames.set(id, user.displayName);
  }

  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    referralId: r.referralId,
    patientName: `${r.firstName} ${r.lastName}`.trim(),
    protocolState: r.protocolState as ReferralState,
    workStatus: r.workStatus as WorkStatus,
    workStatusIsManual: r.workStatusIsManual,
    ownerDisplayName: r.ownerUserId === null ? null : (ownerNames.get(r.ownerUserId) ?? null),
    routingDepartment: r.routingDepartment,
    priorityFlag: !!r.priorityFlag,
    archived: r.archivedAt !== null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}
