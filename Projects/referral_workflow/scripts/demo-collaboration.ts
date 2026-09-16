/**
 * Seeds the collaboration surfaces the epic added: ownership, participants and
 * the conversation, plus a realistic read/unread split on the bell.
 *
 * WHY. Every one of these tables held ZERO rows after a full seed, so the panels
 * the epic exists to provide rendered empty on all 100 workspaces:
 *
 *   - `owner_user_id` was null everywhere, so PRD-21's claim and release, the
 *     owner panel and the `?owner=` index filters had nothing to show and every
 *     workspace read as unclaimed
 *   - `workspace_participants` was empty, so PRD-24's roster was always blank
 *   - `referral_comments` and `comment_mentions` were empty, so PRD-22's
 *     conversation, the share-confirmation flow and the mention acknowledgement
 *     were all unreachable from seeded data
 *   - `notifications` was empty, so the bell read zero for everybody
 *
 * IT GOES THROUGH THE REAL SERVICES, not raw inserts. `assignOwner()` emits its
 * audit event and its assignment notification; `postComment()` enforces the
 * share confirmation and writes the mention rows. So the seeded state is one the
 * application could actually have reached, and PRD-25's activity history has
 * real entries rather than rows that appeared from nowhere.
 *
 * WHAT IS DELIBERATELY NOT SEEDED: PRD-29 assertions. `submitAssertion()` sends
 * a Direct message and calls `proposeForReferral()`, which would advance
 * `referrals.state` and destroy the end states these scenarios are arranged to
 * produce. The assertion panel does not need history anyway --
 * `assertionsAvailableFor()` derives what a party may assert from the current
 * state and the seeded parties, so the panel is populated and the feature demos
 * live, by asserting something. Faking the history would have cost the accuracy
 * of every referral state in the seed.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../src/db';
import {
  notifications,
  referralComments,
  referralWorkspaces,
  referrals,
  users,
} from '../src/db/schema';
import { assignOwner } from '../src/modules/workspace/assignmentService';
import { postComment } from '../src/modules/workspace/commentService';
import { addParticipant, type ParticipantRole } from '../src/modules/workspace/participantService';
import { getUser, type ActingUser } from '../src/modules/workspace/identityService';

export interface CollaborationSeedResult {
  owners: number;
  participants: number;
  comments: number;
  mentions: number;
  notificationsRead: number;
  skipped: number;
}

/**
 * A tiny deterministic generator.
 *
 * `Math.random()` would make every re-seed a different demo, so a screenshot or
 * a walkthrough step naming "the Cardiology workspace Dana owns" would rot on
 * the next run. Seeded from a constant, this yields the same database every
 * time -- which is also what makes the whole seed idempotent to re-run.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32: short, dependency-free and good enough to spread choices.
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/**
 * Which clinician covers which department, matching the queue memberships.
 *
 * All FOUR seeded clinicians appear. An earlier version mapped Gastroenterology
 * to Dr. Rodriguez as well as Oncology, which left Dr. Patel owning nothing --
 * so switching the acting user to him showed an empty bell and an empty "my
 * work", which reads as the feature being broken rather than as him having no
 * caseload.
 */
const DEPARTMENT_CLINICIAN: Record<string, string> = {
  Cardiology: 'echen@specialist.example.org',
  Neurology: 'skim@specialist.example.org',
  Oncology: 'crodriguez@specialist.example.org',
  Gastroenterology: 'rpatel@specialist.example.org',
  Orthopedics: 'skim@specialist.example.org',
};

const COORDINATOR = 'druiz@specialist.example.org';
const SECOND_COORDINATOR = 'praman@specialist.example.org';
const SCHEDULER = 'sokafor@specialist.example.org';

/**
 * Comment text keyed by referral state, so a note reads like it belongs to the
 * situation. Generic filler would make the conversation panel look decorative.
 */
const COMMENTS_BY_STATE: Record<string, readonly string[]> = {
  Acknowledged: [
    'Records look complete. Putting this in front of the covering clinician today.',
    'Chased the referring office for the medication list — nothing outstanding otherwise.',
  ],
  'Pending-Information': [
    'Left a voicemail with the referring office about the missing imaging report.',
    'Second request sent. If nothing lands by Friday this will time out.',
  ],
  Accepted: [
    'Accepted — needs a slot in the next fortnight, patient works nights so mornings only.',
    'Insurance verified. Ready to book.',
  ],
  Scheduled: [
    'Patient confirmed by phone and knows to bring the prior films.',
    'Booked. Reminder call scheduled for the day before.',
  ],
  'No-Show': [
    'Patient did not attend and has not called back. Trying the alternate number next.',
    'Second no-show. Flagging for the referring office before we rebook again.',
  ],
  Encounter: [
    'Seen in clinic. Waiting on the dictated note before this can close.',
    'Encounter complete — consult note is with the clinician for sign-off.',
  ],
  Closed: [
    'Consult note went out. Waiting on their acknowledgement to close the loop.',
    'No acknowledgement yet; will re-send if it is still quiet tomorrow.',
  ],
  'Closed-Confirmed': [
    'Loop closed and acknowledged. Nothing outstanding on our side.',
    'Closed out. Referring office confirmed receipt of the note.',
  ],
  Declined: [
    'Declined and the referring office has been told why, with a suggested alternative.',
    'Declined — outside what this service covers. Redirected rather than left hanging.',
  ],
};

/** Notes that name somebody, so the mention path has real content. */
const MENTION_COMMENTS: readonly string[] = [
  'Can you take a look before this goes any further?',
  'Flagging for a second opinion on whether we are the right service here.',
  'Your name is on the original referral — is this the patient you meant?',
];

/** A shared note is written FOR the other organisation to read. */
const SHARED_COMMENTS: readonly string[] = [
  'We have everything we need and the patient has been contacted directly.',
  'Could you confirm which of the two imaging studies you want us to act on?',
  'Appointment offered. We will send the consult note once the patient has been seen.',
];

const pick = <T>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

export async function seedCollaboration(): Promise<CollaborationSeedResult> {
  // A fixed, arbitrary seed. Its value means nothing; its constancy is the point.
  const rng = makeRng(0x360c011a);
  const result: CollaborationSeedResult = {
    owners: 0,
    participants: 0,
    comments: 0,
    mentions: 0,
    notificationsRead: 0,
    skipped: 0,
  };

  // ── People ─────────────────────────────────────────────────────────────────
  const roster = await db.select({ id: users.id, email: users.email }).from(users);
  const byEmail = new Map(roster.map((u) => [u.email, u.id]));

  const actingCache = new Map<number, ActingUser>();
  const acting = async (email: string): Promise<ActingUser | null> => {
    const id = byEmail.get(email);
    if (id === undefined) return null;
    const cached = actingCache.get(id);
    if (cached) return cached;
    const user = await getUser(id);
    if (user) actingCache.set(id, user);
    return user;
  };

  const coordinator = await acting(COORDINATOR);
  if (!coordinator) {
    // No roster means no attributable actor, and inventing one would put a
    // person who does not exist into the audit trail.
    return { ...result, skipped: 1 };
  }

  // ── Workspaces ─────────────────────────────────────────────────────────────
  const workspaces = await db
    .select({
      id: referralWorkspaces.id,
      referralId: referralWorkspaces.referralId,
      ownerUserId: referralWorkspaces.ownerUserId,
      state: referrals.state,
      department: referrals.routingDepartment,
    })
    .from(referralWorkspaces)
    .innerJoin(referrals, eq(referrals.id, referralWorkspaces.referralId))
    .where(isNull(referralWorkspaces.archivedAt))
    .orderBy(referralWorkspaces.id);

  for (const [position, ws] of workspaces.entries()) {
    // ── Ownership ────────────────────────────────────────────────────────────
    //
    // Seven in ten. The rest stay unowned on purpose: "unclaimed" is the state
    // PRD-21's claim button and the index's unclaimed filter exist for, and a
    // fully-assigned board demonstrates neither.
    //
    // WHY POSITION AND NOT A RANDOM ROLL. The structural composition of the
    // demo -- how many are owned, how many carry a shared note -- is decided by
    // ordinal position, so the counts are exact and stated. A random roll got
    // this wrong in a way worth recording: the owner branch consumes a value
    // from the generator only when the department has no mapped clinician, so
    // the stream shifted phase partway through and the 8% band for shared
    // comments produced 2 of them instead of 8. Randomness now chooses only
    // WHICH text and WHICH person, where nothing depends on the proportion.
    if (ws.ownerUserId === null && position % 10 < 7) {
      // Two of those seven go to a coordinator or the scheduler rather than the
      // department clinician. Coordinators do triage and hold work, and without
      // this they owned nothing, participated in little and their notification
      // bells read zero -- for the persona the demo is mostly told through.
      const nonClinician = position % 10 === 5 || position % 10 === 6;
      const mapped = ws.department ? DEPARTMENT_CLINICIAN[ws.department] : undefined;
      const ownerEmail = nonClinician || !mapped ? pick(rng, [COORDINATOR, SECOND_COORDINATOR, SCHEDULER]) : mapped;
      const ownerId = byEmail.get(ownerEmail);

      if (ownerId !== undefined) {
        try {
          // Assigned BY a coordinator rather than self-claimed, so the activity
          // history shows a real actor acting on someone else's behalf -- and
          // `notifyAssignment()` has somebody other than the actor to notify.
          const assigner = ownerId === coordinator.id ? (await acting(SECOND_COORDINATOR)) ?? coordinator : coordinator;
          await assignOwner(ws.id, ownerId, assigner, 'initial triage assignment');
          result.owners += 1;
        } catch {
          result.skipped += 1;
        }
      }
    }

    // ── Participants ─────────────────────────────────────────────────────────
    //
    // One in four gets an EXPLICIT participant. Note that the total will be
    // higher: `assignOwner()` calls `syncOwnerParticipant()`, so every owner is
    // also a participant. That is the service's behaviour, not double-counting.
    if (position % 4 === 1) {
      const role: ParticipantRole = position % 12 === 1 ? 'Viewer' : 'Collaborator';
      const participantEmail = pick(rng, [SECOND_COORDINATOR, SCHEDULER, COORDINATOR]);
      const participantId = byEmail.get(participantEmail);
      if (participantId !== undefined) {
        try {
          await addParticipant(ws.id, participantId, role, coordinator);
          result.participants += 1;
        } catch {
          result.skipped += 1;
        }
      }
    }

    // ── Conversation ─────────────────────────────────────────────────────────
    //
    // Skipped when the workspace already has comments, which is what makes a
    // re-seed a no-op here rather than doubling every thread.
    const [existingComment] = await db
      .select({ id: referralComments.id })
      .from(referralComments)
      .where(eq(referralComments.workspaceId, ws.id))
      .limit(1);
    if (existingComment) continue;

    const author = (await acting(pick(rng, [COORDINATOR, SECOND_COORDINATOR]))) ?? coordinator;

    // First rule that matches wins.
    const wantsShared = position % 7 === 3;
    const wantsMention = !wantsShared && position % 8 === 5;
    const wantsInternal = !wantsShared && !wantsMention && position % 3 === 0;

    if (wantsShared) {
      // A shared note, which requires the explicit confirmation PRD-22 demands
      // before anything crosses to the other organisation.
      try {
        await postComment({
          workspaceId: ws.id,
          body: pick(rng, SHARED_COMMENTS),
          visibility: 'Shared',
          confirmShared: true,
          author: { kind: 'user', user: author },
        });
        result.comments += 1;
      } catch {
        result.skipped += 1;
      }
    } else if (wantsMention) {
      // A mention, left UNACKNOWLEDGED. That is the interesting state: it is one
      // of the two sources `hasOpenInternalItems()` reads, so it is what makes a
      // closure propose `Follow-up-Required` instead of `Resolved`.
      const mentionedEmail =
        (ws.department ? DEPARTMENT_CLINICIAN[ws.department] : undefined) ?? SECOND_COORDINATOR;
      const mentionedId = byEmail.get(mentionedEmail);
      if (mentionedId !== undefined && mentionedId !== author.id) {
        try {
          await postComment({
            workspaceId: ws.id,
            body: pick(rng, MENTION_COMMENTS),
            author: { kind: 'user', user: author },
            mentions: { users: [mentionedId] },
          });
          result.comments += 1;
          result.mentions += 1;
        } catch {
          result.skipped += 1;
        }
      }
    } else if (wantsInternal) {
      const pool = COMMENTS_BY_STATE[ws.state] ?? COMMENTS_BY_STATE.Acknowledged;
      try {
        await postComment({ workspaceId: ws.id, body: pick(rng, pool), author: { kind: 'user', user: author } });
        result.comments += 1;
      } catch {
        result.skipped += 1;
      }
    }
  }

  // ── The bell ───────────────────────────────────────────────────────────────
  //
  // Everything above generated unread notifications. Leaving all of them unread
  // makes the badge a count of the seed rather than a count of somebody's day,
  // so about half are marked read -- and the read ones are the OLDEST, which is
  // how a real inbox drains.
  const unread = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(isNull(notifications.readAt))
    .orderBy(notifications.id);

  const toRead = unread.slice(0, Math.floor(unread.length * 0.5));
  if (toRead.length > 0) {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          isNull(notifications.readAt),
          sql`${notifications.id} <= ${toRead[toRead.length - 1].id}`,
        ),
      );
    result.notificationsRead = toRead.length;
  }

  return result;
}
