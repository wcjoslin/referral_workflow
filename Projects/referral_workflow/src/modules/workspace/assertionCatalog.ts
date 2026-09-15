/**
 * PRD-29 — the assertion catalog.
 *
 * An ASSERTION is a protocol statement a participant makes from inside the
 * workspace: "accept this referral", "here is the consult note". Each maps to
 * one artifact and at most one protocol transition.
 *
 * THIS FILE IS DATA, NOT LOGIC, and that is the point. The authoring surface,
 * the server-side authorization check and the guest payload all derive from this
 * one table, so what a participant is offered and what the gateway permits
 * cannot drift apart. A hand-written list in the UI would be a second source of
 * truth for an authorization decision.
 *
 * `fromStates` is deliberately explicit rather than derived from
 * `referralStateMachine`'s transition map. The machine says which transitions
 * are *legal*; this says which are *assertable from the workspace by a given
 * party role*, which is a strictly smaller set. Deriving one from the other
 * would silently grant a party every legal transition.
 */

import { ReferralState } from '../../state/referralStateMachine';
import { PartyRole } from './partyService';

export type AssertionType =
  | 'acknowledge'
  | 'accept'
  | 'decline'
  | 'needs-information'
  | 'supply-information'
  | 'scheduled'
  | 'no-show'
  | 'encounter'
  | 'interim-update'
  | 'final-outcome'
  | 'acknowledge-outcome'
  | 'cancel';

/** Which builder renders the artifact. `direct` => a plain Direct message. */
export type AssertionBuilder = 'rri' | 'siu' | 'ccda' | 'mdn' | 'ack' | 'direct';

export interface AssertionSpec {
  type: AssertionType;
  /** Plain language, shown to a guest who knows nothing about HL7. */
  label: string;
  /** One line on what actually happens, because "RRI" means nothing to a coordinator. */
  description: string;
  permittedRoles: PartyRole[];
  fromStates: ReferralState[];
  /** null => no protocol transition (an interim update changes no state). */
  toState: ReferralState | null;
  builder: AssertionBuilder;
  /** Context keys the gateway requires before it will render anything. */
  requiredContext: string[];
}

export const ASSERTION_CATALOG: Record<AssertionType, AssertionSpec> = {
  acknowledge: {
    type: 'acknowledge',
    label: 'Confirm receipt',
    description: 'Tells the referring organization the referral arrived and is being looked at.',
    permittedRoles: ['receiving'],
    fromStates: [ReferralState.RECEIVED],
    toState: ReferralState.ACKNOWLEDGED,
    builder: 'mdn',
    requiredContext: [],
  },

  accept: {
    type: 'accept',
    label: 'Accept this referral',
    description: 'Takes the referral on. The referring organization receives a formal acceptance.',
    permittedRoles: ['receiving'],
    fromStates: [ReferralState.ACKNOWLEDGED],
    toState: ReferralState.ACCEPTED,
    builder: 'rri',
    requiredContext: [],
  },

  decline: {
    type: 'decline',
    label: 'Decline this referral',
    description: 'Returns the referral with a reason. The reason is sent, so write it for them.',
    permittedRoles: ['receiving'],
    fromStates: [ReferralState.ACKNOWLEDGED],
    toState: ReferralState.DECLINED,
    // A decline reason is REQUIRED, not optional: a decline with no reason
    // forces the referring organization to telephone, which is the exact
    // failure this epic exists to remove.
    builder: 'rri',
    requiredContext: ['reason'],
  },

  'needs-information': {
    type: 'needs-information',
    label: 'Ask for more information',
    description: 'Puts the referral on hold and tells the other side what is missing.',
    permittedRoles: ['receiving'],
    fromStates: [ReferralState.ACKNOWLEDGED],
    toState: ReferralState.PENDING_INFORMATION,
    builder: 'rri',
    requiredContext: ['reason'],
  },

  'supply-information': {
    type: 'supply-information',
    label: 'Supply the requested information',
    description: 'Answers an information request and returns the referral for a decision.',
    // The INITIATING party supplies information — they are the ones who were
    // asked. The receiving party cannot answer its own question.
    permittedRoles: ['initiating'],
    fromStates: [ReferralState.PENDING_INFORMATION],
    toState: ReferralState.ACKNOWLEDGED,
    builder: 'direct',
    requiredContext: ['note'],
  },

  scheduled: {
    type: 'scheduled',
    label: 'Confirm an appointment',
    description: 'Sends the appointment date, time and location as a scheduling notification.',
    permittedRoles: ['receiving'],
    fromStates: [ReferralState.ACCEPTED],
    toState: ReferralState.SCHEDULED,
    builder: 'siu',
    requiredContext: ['appointmentDate', 'location'],
  },

  'no-show': {
    type: 'no-show',
    label: 'Report a missed appointment',
    description: 'Tells the referring organization the patient did not attend.',
    permittedRoles: ['receiving'],
    fromStates: [ReferralState.SCHEDULED],
    toState: ReferralState.NO_SHOW,
    // No structured artifact exists for this and none is invented: markNoShow()
    // already sends plain text, so `direct` is the honest builder.
    builder: 'direct',
    requiredContext: [],
  },

  encounter: {
    type: 'encounter',
    label: 'Record that the patient was seen',
    description: 'Marks the appointment as attended and notifies the other side.',
    permittedRoles: ['receiving'],
    fromStates: [ReferralState.SCHEDULED],
    toState: ReferralState.ENCOUNTER,
    builder: 'direct',
    requiredContext: [],
  },

  'interim-update': {
    type: 'interim-update',
    label: 'Send an update',
    description: 'Sends a note without changing where the referral stands.',
    permittedRoles: ['receiving', 'initiating'],
    // Available from every state where the referral is still live. Not from a
    // terminal state: there is nothing to update about a finished referral.
    fromStates: [
      ReferralState.ACKNOWLEDGED,
      ReferralState.ACCEPTED,
      ReferralState.PENDING_INFORMATION,
      ReferralState.SCHEDULED,
      ReferralState.ENCOUNTER,
      ReferralState.CONSULT,
      ReferralState.NO_SHOW,
      ReferralState.CLOSED,
    ],
    toState: null,
    builder: 'direct',
    requiredContext: ['note'],
  },

  'final-outcome': {
    type: 'final-outcome',
    label: 'Return the consult note',
    description: 'Packages the outcome as a clinical document and closes the loop.',
    permittedRoles: ['receiving'],
    fromStates: [ReferralState.ENCOUNTER, ReferralState.CONSULT],
    toState: ReferralState.CLOSED,
    builder: 'ccda',
    // The C-CDA needs real sections. Rendering a consult note with an empty
    // assessment would produce a conformant document that says nothing.
    requiredContext: ['assessment'],
  },

  'acknowledge-outcome': {
    type: 'acknowledge-outcome',
    label: 'Confirm you received the outcome',
    description: 'Acknowledges the consult note. This is what closes the loop for good.',
    // The INITIATING party confirms — they asked for the referral, so they are
    // the ones who close it.
    permittedRoles: ['initiating'],
    fromStates: [ReferralState.CLOSED],
    toState: ReferralState.CLOSED_CONFIRMED,
    builder: 'ack',
    requiredContext: [],
  },

  cancel: {
    type: 'cancel',
    label: 'Withdraw this referral',
    description: 'Withdraws the referral. Only the referring organization can do this.',
    permittedRoles: ['initiating'],
    // NARROWER THAN THE PRD SPECIFIED, because the state machine says so.
    //
    // PRD-29's assertion table gives `cancel` as "any non-terminal → Declined".
    // Checked against referralStateMachine: only Acknowledged → Declined and
    // Pending-Information → Declined are legal. Received → Declined,
    // Accepted → Declined and Scheduled → Declined all throw.
    //
    // The gateway does not get to widen the machine to suit this catalog —
    // PRD-29 names transition() as the single guard, and changing the protocol
    // model from here would be reaching into PRD-01/02 exactly as delegating to
    // their services would have. So the catalog narrows instead.
    //
    // RECORDED AS A GAP, not papered over: withdrawing an already-scheduled
    // referral is a real thing that happens, and today there is no legal
    // transition for it. That belongs to the state machine's own PRD. A test
    // asserts every catalog transition is legal, so this cannot silently drift.
    fromStates: [ReferralState.ACKNOWLEDGED, ReferralState.PENDING_INFORMATION],
    toState: ReferralState.DECLINED,
    builder: 'direct',
    requiredContext: ['reason'],
  },
};

export const ASSERTION_TYPES: readonly AssertionType[] = Object.keys(
  ASSERTION_CATALOG,
) as AssertionType[];

export function isAssertionType(value: string): value is AssertionType {
  return Object.prototype.hasOwnProperty.call(ASSERTION_CATALOG, value);
}

/**
 * What this party role may assert from this protocol state, right now.
 *
 * Drives the authoring surface AND is re-checked server-side by the gateway,
 * from this same function — so the UI cannot offer something the gateway would
 * refuse, and a hand-crafted request cannot reach something the UI would not
 * have offered.
 *
 * `other` party roles get nothing: an observer such as a payer contact is on
 * the workspace to see it, not to move the protocol.
 */
export function availableAssertions(
  protocolState: ReferralState,
  partyRole: PartyRole,
): AssertionSpec[] {
  return ASSERTION_TYPES.map((t) => ASSERTION_CATALOG[t]).filter(
    (spec) =>
      spec.permittedRoles.includes(partyRole) && spec.fromStates.includes(protocolState),
  );
}

/** True when this role may make this assertion from this state. */
export function isAssertionAvailable(
  type: AssertionType,
  protocolState: ReferralState,
  partyRole: PartyRole,
): boolean {
  const spec = ASSERTION_CATALOG[type];
  return spec.permittedRoles.includes(partyRole) && spec.fromStates.includes(protocolState);
}

/** Context keys the spec requires that the supplied context does not provide. */
export function missingContext(
  type: AssertionType,
  context: Record<string, unknown> | undefined,
): string[] {
  const spec = ASSERTION_CATALOG[type];
  return spec.requiredContext.filter((key) => {
    const value = context?.[key];
    // A present-but-blank field is missing. A decline whose reason is three
    // spaces is a decline with no reason.
    return value === undefined || value === null || String(value).trim() === '';
  });
}
