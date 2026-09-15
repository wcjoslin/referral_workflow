/**
 * Unit tests for commentService.ts (PRD-22)
 *
 * The internal/shared boundary is the thing worth testing, so these are written
 * the way PRD-30's were:
 *
 *   - THE GUEST SHAPE IS CHECKED AGAINST AN ALLOW-LIST of keys rather than a
 *     list of forbidden fields, so adding an internal field and copying it
 *     through fails here even though nobody anticipated that field.
 *   - THE DATABASE CONSTRAINTS ARE TESTED DIRECTLY, not only through the
 *     service. The author union and the one-current-revision rule are enforced
 *     by the schema, and a test that only goes through the service would pass
 *     against DDL that had lost them.
 *   - THE SHARE LOCK IS TESTED IN BOTH DIRECTIONS. A comment nobody outside can
 *     have seen must stay downgradeable, or the rule is just an obstacle.
 */

jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct', orgName: 'Specialist Care Group' },
    database: { url: ':memory:' },
    workspace: {
      publicBaseUrl: 'http://test.invalid',
      guestInvitationExpiryHours: 336,
      guestSessionExpiryHours: 24,
      senderIdentityMode: 'organization',
    },
  },
}));

jest.mock('../../../src/modules/messaging/mailer', () => ({
  sendMail: jest.fn().mockResolvedValue(false),
  buildTransport: jest.fn(),
}));

jest.mock('../../../src/db', () => {
  const Database = require('better-sqlite3');
  const { drizzle } = require('drizzle-orm/better-sqlite3');
  const schema = require('../../../src/db/schema');

  const sqlite = new Database(':memory:');
  sqlite.exec(require('../../helpers/testSchema').TEST_SCHEMA_DDL);
  return { db: drizzle(sqlite, { schema }), sqlite };
});

import { and, eq } from 'drizzle-orm';
import { db } from '../../../src/db';
import {
  commentMentions,
  commentRevisions,
  partyAddresses,
  patients,
  referralComments,
  referralWorkspaces,
  referrals,
  users,
  workflowEvents,
  workspaceGuests,
  workspaceInvitations,
  workspaceParticipants,
  workspaceParties,
} from '../../../src/db/schema';
import { ReferralState } from '../../../src/state/referralStateMachine';
import { WorkStatus } from '../../../src/state/workStatusMachine';
import { ActingUser } from '../../../src/modules/workspace/identityService';
import { GuestContext } from '../../../src/modules/workspace/guestAccess';
import {
  CommentDeletedError,
  CommentEmptyError,
  CommentNotAuthorError,
  CommentNotFoundError,
  CommentRevisionConflictError,
  CommentTooLongError,
  CommentWorkspaceNotFoundError,
  GUEST_COMMENT_KEYS,
  GuestVisibilityError,
  MAX_COMMENT_LENGTH,
  MentionTargetError,
  ShareNotConfirmedError,
  SharedMentionError,
  VisibilityDowngradeError,
  acknowledgeMentions,
  deleteComment,
  editComment,
  getCommentHistory,
  hasUnacknowledgedMention,
  isCommentVisibility,
  listComments,
  listSharedComments,
  mentionTargets,
  openMentionCount,
  postComment,
} from '../../../src/modules/workspace/commentService';

let seq = 0;
let dana: ActingUser;
let priya: ActingUser;

const acting = (id: number, displayName: string): ActingUser => ({
  id,
  displayName,
  email: `${displayName.toLowerCase().replace(/\W/g, '')}-${id}@example.test`,
  directAddress: null,
  jobRole: 'coordinator',
  legacyClinicianId: null,
  allQueuesAccess: false,
  active: true,
});

async function insertUser(displayName: string, active = true): Promise<ActingUser> {
  const [row] = await db
    .insert(users)
    .values({
      displayName,
      email: `${displayName.toLowerCase().replace(/\W/g, '')}-${++seq}@example.test`,
      jobRole: 'coordinator',
      allQueuesAccess: false,
      active,
      createdAt: new Date(),
    })
    .returning();
  return acting(row.id, displayName);
}

beforeEach(async () => {
  await db.delete(commentMentions);
  await db.delete(commentRevisions);
  await db.delete(referralComments);
  await db.delete(workspaceGuests);
  await db.delete(workspaceInvitations);
  await db.delete(workspaceParticipants);
  await db.delete(partyAddresses);
  await db.delete(workspaceParties);
  await db.delete(workflowEvents);
  await db.delete(referralWorkspaces);
  await db.delete(referrals);
  await db.delete(users);
  await db.delete(patients);

  dana = await insertUser('Dana Ruiz');
  priya = await insertUser('Priya Raman');
});

interface Fixture {
  workspaceId: number;
  referralId: number;
  receivingPartyId: number;
  initiatingPartyId: number;
}

async function makeWorkspace(state: ReferralState = ReferralState.SCHEDULED): Promise<Fixture> {
  const [patient] = await db
    .insert(patients)
    .values({ firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1815-12-10' })
    .returning();

  const [referral] = await db
    .insert(referrals)
    .values({
      patientId: patient.id,
      sourceMessageId: `cmt-${++seq}-${Date.now()}`,
      referrerAddress: 'referrals@lakeside.direct',
      reasonForReferral: 'Chest pain',
      state,
      routingDepartment: 'Cardiology',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const [workspace] = await db
    .insert(referralWorkspaces)
    .values({
      referralId: referral.id,
      workStatus: WorkStatus.WAITING_EXTERNAL,
      workStatusIsManual: false,
      ownerUserId: dana.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const [receiving] = await db
    .insert(workspaceParties)
    .values({
      workspaceId: workspace.id,
      partyRole: 'receiving',
      orgName: 'Specialist Care Group',
      orgNameVerified: true,
      directAddress: 'receiving@specialist.direct',
      protocolMode: 'workspace-mediated',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const [initiating] = await db
    .insert(workspaceParties)
    .values({
      workspaceId: workspace.id,
      partyRole: 'initiating',
      orgName: 'Lakeside Primary Care',
      orgNameVerified: false,
      directAddress: 'referrals@lakeside.direct',
      protocolMode: 'workspace-mediated',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  return {
    workspaceId: workspace.id,
    referralId: referral.id,
    receivingPartyId: receiving.id,
    initiatingPartyId: initiating.id,
  };
}

/** A guest row plus the GuestContext the service takes, without minting a token. */
async function makeGuest(
  fx: Fixture,
  opts: { displayName?: string; lastSeenAt?: Date | null; revoked?: boolean } = {},
): Promise<GuestContext> {
  const [invitation] = await db
    .insert(workspaceInvitations)
    .values({
      workspaceId: fx.workspaceId,
      partyId: fx.initiatingPartyId,
      recipientEmail: `guest-${++seq}@lakeside.test`,
      tokenHash: `hash-${seq}`,
      invitedByUserId: dana.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: opts.revoked ? new Date() : null,
      emailDelivered: false,
      createdAt: new Date(),
    })
    .returning();

  const [guest] = await db
    .insert(workspaceGuests)
    .values({
      invitationId: invitation.id,
      workspaceId: fx.workspaceId,
      partyId: fx.initiatingPartyId,
      displayName: opts.displayName ?? 'Dr. Ruth Okoro',
      sessionTokenHash: `session-${seq}`,
      sessionExpiresAt: new Date(Date.now() + 86_400_000),
      lastSeenAt: opts.lastSeenAt ?? null,
      createdAt: new Date(),
    })
    .returning();

  return {
    guestId: guest.id,
    invitationId: invitation.id,
    workspaceId: fx.workspaceId,
    partyId: fx.initiatingPartyId,
    partyRole: 'initiating',
    partyOrgName: 'Lakeside Primary Care',
    protocolMode: 'workspace-mediated',
    displayName: guest.displayName,
    expiresAt: guest.sessionExpiresAt as Date,
  };
}

async function eventTypes(): Promise<string[]> {
  const rows = await db.select({ t: workflowEvents.eventType }).from(workflowEvents);
  return rows.map((r) => r.t);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('commentService (PRD-22)', () => {
  describe('isCommentVisibility()', () => {
    it('accepts the two real values and nothing else', () => {
      expect(isCommentVisibility('Internal')).toBe(true);
      expect(isCommentVisibility('Shared')).toBe(true);
      expect(isCommentVisibility('shared')).toBe(false);
      expect(isCommentVisibility('Public')).toBe(false);
      expect(isCommentVisibility('')).toBe(false);
    });
  });

  // ── Posting ───────────────────────────────────────────────────────────────

  describe('postComment()', () => {
    it('defaults to Internal when visibility is omitted', async () => {
      const fx = await makeWorkspace();
      const comment = await postComment({
        workspaceId: fx.workspaceId,
        body: 'Referring office faxing imaging Tuesday',
        author: { kind: 'user', user: dana },
      });
      expect(comment.visibility).toBe('Internal');
      expect(comment.body).toBe('Referring office faxing imaging Tuesday');
      expect(comment.authorKind).toBe('user');
      expect(comment.authorUserId).toBe(dana.id);
      expect(comment.authorDisplayName).toBe('Dana Ruiz');
      expect(comment.revisionCount).toBe(1);
      expect(comment.editedAt).toBeNull();
      expect(comment.deleted).toBe(false);
    });

    it('trims the body and rejects one that is empty or only whitespace', async () => {
      const fx = await makeWorkspace();
      const comment = await postComment({
        workspaceId: fx.workspaceId,
        body: '   padded   ',
        author: { kind: 'user', user: dana },
      });
      expect(comment.body).toBe('padded');

      for (const body of ['', '   ', '\n\t ']) {
        await expect(
          postComment({ workspaceId: fx.workspaceId, body, author: { kind: 'user', user: dana } }),
        ).rejects.toThrow(CommentEmptyError);
      }
    });

    it('rejects a body over the cap and accepts one exactly at it', async () => {
      const fx = await makeWorkspace();
      const atCap = 'x'.repeat(MAX_COMMENT_LENGTH);
      await expect(
        postComment({
          workspaceId: fx.workspaceId,
          body: atCap,
          author: { kind: 'user', user: dana },
        }),
      ).resolves.toMatchObject({ visibility: 'Internal' });

      await expect(
        postComment({
          workspaceId: fx.workspaceId,
          body: `${atCap}y`,
          author: { kind: 'user', user: dana },
        }),
      ).rejects.toThrow(CommentTooLongError);
    });

    it('refuses a Shared comment without the confirmation', async () => {
      const fx = await makeWorkspace();
      await expect(
        postComment({
          workspaceId: fx.workspaceId,
          body: 'Can you confirm the echo report is included?',
          visibility: 'Shared',
          author: { kind: 'user', user: dana },
        }),
      ).rejects.toThrow(ShareNotConfirmedError);

      // And nothing was written on the way to refusing.
      await expect(listComments(fx.workspaceId)).resolves.toEqual([]);
    });

    it('accepts a Shared comment with the confirmation', async () => {
      const fx = await makeWorkspace();
      const comment = await postComment({
        workspaceId: fx.workspaceId,
        body: 'Can you confirm the echo report is included?',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });
      expect(comment.visibility).toBe('Shared');
      expect(await eventTypes()).toContain('workspace.comment_shared');
    });

    it('forces a guest comment to Shared', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      const comment = await postComment({
        workspaceId: fx.workspaceId,
        body: 'Has the patient been told about the appointment?',
        author: { kind: 'guest', guest },
      });
      expect(comment.visibility).toBe('Shared');
      expect(comment.authorKind).toBe('guest');
      expect(comment.authorUserId).toBeNull();
      expect(comment.authorDisplayName).toBe('Dr. Ruth Okoro');
      expect(comment.authorPartyOrgName).toBe('Lakeside Primary Care');
    });

    it('refuses a guest-supplied visibility rather than coercing it', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      await expect(
        postComment({
          workspaceId: fx.workspaceId,
          body: 'a note I want kept private',
          visibility: 'Internal',
          author: { kind: 'guest', guest },
        }),
      ).rejects.toThrow(GuestVisibilityError);
    });

    it('records the party a guest comment was made for, in the event', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'question',
        author: { kind: 'guest', guest },
      });
      const [event] = await db
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.eventType, 'workspace.comment_added'));
      expect(event.actor).toBe(`guest:${guest.guestId}`);
      expect(event.entityId).toBe(fx.referralId);
      const metadata = JSON.parse(event.metadata as string) as Record<string, unknown>;
      expect(metadata.partyId).toBe(fx.initiatingPartyId);
      expect(metadata.authorKind).toBe('guest');
      expect(metadata.workspaceId).toBe(fx.workspaceId);
    });

    it('refuses an unknown workspace', async () => {
      await expect(
        postComment({ workspaceId: 9999, body: 'hi', author: { kind: 'user', user: dana } }),
      ).rejects.toThrow(CommentWorkspaceNotFoundError);
    });
  });

  // ── Mentions at post time ─────────────────────────────────────────────────

  describe('mention validation', () => {
    it('refuses internal user mentions on a shared comment', async () => {
      const fx = await makeWorkspace();
      await expect(
        postComment({
          workspaceId: fx.workspaceId,
          body: '@Priya can you believe this referral',
          visibility: 'Shared',
          confirmShared: true,
          author: { kind: 'user', user: dana },
          mentions: { users: [priya.id] },
        }),
      ).rejects.toThrow(SharedMentionError);
    });

    it('allows party mentions on a shared comment', async () => {
      const fx = await makeWorkspace();
      const comment = await postComment({
        workspaceId: fx.workspaceId,
        body: 'For Lakeside: please send the echo report.',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
        mentions: { parties: [fx.initiatingPartyId] },
      });
      expect(comment.mentions).toEqual([
        {
          kind: 'party',
          id: fx.initiatingPartyId,
          displayName: 'Lakeside Primary Care',
          acknowledgedAt: null,
        },
      ]);
    });

    it('refuses an unknown user, a deactivated user and a party from another referral', async () => {
      const fx = await makeWorkspace();
      const other = await makeWorkspace();
      const retired = await insertUser('Sam Okafor', false);

      for (const mentions of [
        { users: [99999] },
        { users: [retired.id] },
        { parties: [other.initiatingPartyId] },
      ]) {
        await expect(
          postComment({
            workspaceId: fx.workspaceId,
            body: 'note',
            author: { kind: 'user', user: dana },
            mentions,
          }),
        ).rejects.toThrow(MentionTargetError);
      }
    });

    it('emits one mention event per target, carrying the identity', async () => {
      const fx = await makeWorkspace();
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'Priya, please look at this',
        author: { kind: 'user', user: dana },
        mentions: { users: [priya.id] },
      });
      const rows = await db
        .select()
        .from(workflowEvents)
        .where(eq(workflowEvents.eventType, 'workspace.comment_mention'));
      expect(rows).toHaveLength(1);
      const metadata = JSON.parse(rows[0].metadata as string) as Record<string, unknown>;
      expect(metadata.mentionedKind).toBe('user');
      expect(metadata.mentionedUserId).toBe(priya.id);
    });

    it('de-duplicates a target mentioned twice in one comment', async () => {
      const fx = await makeWorkspace();
      const comment = await postComment({
        workspaceId: fx.workspaceId,
        body: 'Priya Priya',
        author: { kind: 'user', user: dana },
        mentions: { users: [priya.id, priya.id] },
      });
      expect(comment.mentions).toHaveLength(1);
    });
  });

  // ── The database constraints ──────────────────────────────────────────────

  describe('schema enforcement', () => {
    it('refuses a comment with both authors set, and with neither', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);

      await expect(
        db.insert(referralComments).values({
          workspaceId: fx.workspaceId,
          authorUserId: dana.id,
          authorGuestId: guest.guestId,
          createdAt: new Date(),
        }),
      ).rejects.toThrow(/CHECK constraint failed/);

      await expect(
        db.insert(referralComments).values({
          workspaceId: fx.workspaceId,
          authorUserId: null,
          authorGuestId: null,
          createdAt: new Date(),
        }),
      ).rejects.toThrow(/CHECK constraint failed/);
    });

    it('refuses a second current revision for the same comment', async () => {
      const fx = await makeWorkspace();
      const comment = await postComment({
        workspaceId: fx.workspaceId,
        body: 'first',
        author: { kind: 'user', user: dana },
      });

      await expect(
        db.insert(commentRevisions).values({
          commentId: comment.id,
          revisionNumber: 2,
          body: 'a second live revision',
          visibility: 'Internal',
          createdAt: new Date(),
          createdByActor: `user:${dana.id}`,
          supersededAt: null,
        }),
      ).rejects.toThrow(/UNIQUE constraint failed/);
    });

    it('refuses a mention with both targets set, and with neither', async () => {
      const fx = await makeWorkspace();
      const comment = await postComment({
        workspaceId: fx.workspaceId,
        body: 'note',
        author: { kind: 'user', user: dana },
      });
      const [revision] = await db
        .select()
        .from(commentRevisions)
        .where(eq(commentRevisions.commentId, comment.id));

      for (const target of [
        { mentionedUserId: priya.id, mentionedPartyId: fx.initiatingPartyId },
        { mentionedUserId: null, mentionedPartyId: null },
      ]) {
        await expect(
          db.insert(commentMentions).values({
            commentId: comment.id,
            revisionId: revision.id,
            workspaceId: fx.workspaceId,
            createdAt: new Date(),
            ...target,
          }),
        ).rejects.toThrow(/CHECK constraint failed/);
      }
    });
  });

  // ── Reading the internal thread ───────────────────────────────────────────

  describe('listComments()', () => {
    it('returns the thread in the order it happened', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'one',
        author: { kind: 'user', user: dana },
      });
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'two',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'three',
        author: { kind: 'guest', guest },
      });

      const thread = await listComments(fx.workspaceId);
      expect(thread.map((c) => c.body)).toEqual(['one', 'two', 'three']);
      expect(thread.map((c) => c.visibility)).toEqual(['Internal', 'Shared', 'Shared']);
    });

    it('still attributes a comment whose author was later deactivated', async () => {
      const fx = await makeWorkspace();
      const leaving = await insertUser('Alex Whitfield');
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'handing this over',
        author: { kind: 'user', user: leaving },
      });
      await db.update(users).set({ active: false }).where(eq(users.id, leaving.id));

      const [comment] = await listComments(fx.workspaceId);
      expect(comment.authorDisplayName).toBe('Alex Whitfield');
      expect(comment.authorInactive).toBe(true);
      expect(comment.body).toBe('handing this over');
    });

    it('still attributes a guest whose invitation was later revoked', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'asked before access ended',
        author: { kind: 'guest', guest },
      });
      await db
        .update(workspaceInvitations)
        .set({ revokedAt: new Date() })
        .where(eq(workspaceInvitations.id, guest.invitationId));

      const [comment] = await listComments(fx.workspaceId);
      expect(comment.authorDisplayName).toBe('Dr. Ruth Okoro');
      expect(comment.authorInactive).toBe(true);
      expect(comment.body).toBe('asked before access ended');
    });

    it('names a guest by their organization when they supplied no name', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx, { displayName: undefined });
      await db
        .update(workspaceGuests)
        .set({ displayName: null })
        .where(eq(workspaceGuests.id, guest.guestId));
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'anonymous question',
        author: { kind: 'guest', guest },
      });

      const [comment] = await listComments(fx.workspaceId);
      expect(comment.authorDisplayName).toBe('Guest at Lakeside Primary Care');
    });

    it('refuses an unknown workspace rather than returning an empty thread', async () => {
      await expect(listComments(9999)).rejects.toThrow(CommentWorkspaceNotFoundError);
    });

    it('scopes the revision history to the workspace it was asked for', async () => {
      const fx = await makeWorkspace();
      const other = await makeWorkspace();
      const posted = await postComment({
        workspaceId: other.workspaceId,
        body: 'belongs to another referral',
        author: { kind: 'user', user: dana },
      });
      await expect(getCommentHistory(fx.workspaceId, posted.id)).rejects.toThrow(
        CommentNotFoundError,
      );
      await expect(getCommentHistory(other.workspaceId, posted.id)).resolves.toHaveLength(1);
    });
  });

  // ── Editing ───────────────────────────────────────────────────────────────

  describe('editComment()', () => {
    it('appends a revision and leaves the previous text retrievable', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'faxing imaging Tuesday',
        author: { kind: 'user', user: dana },
      });

      const edited = await editComment({
        workspaceId: fx.workspaceId,
        commentId: posted.id,
        body: 'faxing imaging Wednesday',
        visibility: 'Internal',
        user: dana,
      });

      expect(edited.body).toBe('faxing imaging Wednesday');
      expect(edited.revisionCount).toBe(2);
      expect(edited.editedAt).not.toBeNull();

      const history = await getCommentHistory(fx.workspaceId, posted.id);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        revisionNumber: 1,
        body: 'faxing imaging Tuesday',
        visibility: 'Internal',
      });
      expect(history[0].supersededAt).not.toBeNull();
      expect(history[1]).toMatchObject({ revisionNumber: 2, body: 'faxing imaging Wednesday' });
      expect(history[1].supersededAt).toBeNull();
    });

    it('records visibility per revision, so an upgrade does not rewrite the past', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'ask them about the echo',
        author: { kind: 'user', user: dana },
      });

      await editComment({
        workspaceId: fx.workspaceId,
        commentId: posted.id,
        body: 'Could you send the echo report?',
        visibility: 'Shared',
        confirmShared: true,
        user: dana,
      });

      const history = await getCommentHistory(fx.workspaceId, posted.id);
      expect(history.map((r) => r.visibility)).toEqual(['Internal', 'Shared']);
      expect(await eventTypes()).toContain('workspace.comment_shared');
    });

    it('needs the confirmation to go Internal to Shared', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'internal thought',
        author: { kind: 'user', user: dana },
      });
      await expect(
        editComment({
          workspaceId: fx.workspaceId,
          commentId: posted.id,
          body: 'internal thought',
          visibility: 'Shared',
          user: dana,
        }),
      ).rejects.toThrow(ShareNotConfirmedError);
    });

    it('does NOT re-ask for confirmation when editing a comment that is already shared', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'typo hree',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });
      // Re-confirming every edit would train people to click through the
      // confirmation, which costs more safety than it buys.
      const edited = await editComment({
        workspaceId: fx.workspaceId,
        commentId: posted.id,
        body: 'typo here',
        visibility: 'Shared',
        user: dana,
      });
      expect(edited.body).toBe('typo here');
    });

    it('lets only the author change the wording', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'mine',
        author: { kind: 'user', user: dana },
      });
      await expect(
        editComment({
          workspaceId: fx.workspaceId,
          commentId: posted.id,
          body: 'not yours to change',
          visibility: 'Internal',
          user: priya,
        }),
      ).rejects.toThrow(CommentNotAuthorError);
    });

    it('lets nobody internal rewrite what a guest said', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'the patient asked me to say',
        author: { kind: 'guest', guest },
      });
      await expect(
        editComment({
          workspaceId: fx.workspaceId,
          commentId: posted.id,
          body: 'words put in their mouth',
          visibility: 'Shared',
          user: dana,
        }),
      ).rejects.toThrow(CommentNotAuthorError);
    });

    it('refuses to edit a tombstoned comment', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'gone',
        author: { kind: 'user', user: dana },
      });
      await deleteComment(fx.workspaceId, posted.id, `user:${dana.id}`);
      await expect(
        editComment({
          workspaceId: fx.workspaceId,
          commentId: posted.id,
          body: 'back again',
          visibility: 'Internal',
          user: dana,
        }),
      ).rejects.toThrow(CommentDeletedError);
    });

    it('refuses a comment id from another workspace', async () => {
      const fx = await makeWorkspace();
      const other = await makeWorkspace();
      const posted = await postComment({
        workspaceId: other.workspaceId,
        body: 'elsewhere',
        author: { kind: 'user', user: dana },
      });
      await expect(
        editComment({
          workspaceId: fx.workspaceId,
          commentId: posted.id,
          body: 'reaching across',
          visibility: 'Internal',
          user: dana,
        }),
      ).rejects.toThrow(CommentNotFoundError);
    });

    it('reports a conflict when a racing writer supersedes the revision it read', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'original',
        author: { kind: 'user', user: dana },
      });

      // editComment() reads the current revision, then supersedes it. Land a
      // competing writer in that gap: its UPDATE takes the row, so ours matches
      // nothing and the service must say so rather than inserting a second
      // revision that also claims to be current.
      //
      // Simulated rather than raced, because better-sqlite3 is synchronous and
      // there is no second thread to race against. The guard is real even so:
      // the enforcement underneath it is the partial unique index, which is
      // tested directly above.
      const realUpdate = db.update.bind(db);
      const spy = jest
        .spyOn(db, 'update')
        .mockImplementationOnce(((table: Parameters<typeof realUpdate>[0]) => {
          // Executed with .run() rather than awaited: this stands in the middle
          // of a synchronous call, and better-sqlite3 runs statements inline.
          realUpdate(commentRevisions)
            .set({ supersededAt: new Date() })
            .where(eq(commentRevisions.commentId, posted.id))
            .run();
          return realUpdate(table);
        }) as typeof db.update);

      try {
        await expect(
          editComment({
            workspaceId: fx.workspaceId,
            commentId: posted.id,
            body: 'my edit, based on text that just changed',
            visibility: 'Internal',
            user: dana,
          }),
        ).rejects.toThrow(CommentRevisionConflictError);
      } finally {
        spy.mockRestore();
      }

      // No second revision was written, and the original text is intact.
      const history = await getCommentHistory(fx.workspaceId, posted.id);
      expect(history).toHaveLength(1);
      expect(history[0].body).toBe('original');
    });
  });

  // ── The share lock ────────────────────────────────────────────────────────

  describe('the share lock', () => {
    it('allows a downgrade while no guest has been near the workspace', async () => {
      const fx = await makeWorkspace();
      await makeGuest(fx, { lastSeenAt: null });
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'shared too eagerly',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });
      expect(posted.shareLocked).toBe(false);

      const pulled = await editComment({
        workspaceId: fx.workspaceId,
        commentId: posted.id,
        body: 'shared too eagerly',
        visibility: 'Internal',
        user: dana,
      });
      expect(pulled.visibility).toBe('Internal');
    });

    it('allows a downgrade when the workspace has no guests at all', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'shared with nobody',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });
      // Shared with nobody has been disclosed to nobody, so pulling it back is
      // not a rewrite of history.
      expect(posted.shareLocked).toBe(false);
      await expect(
        editComment({
          workspaceId: fx.workspaceId,
          commentId: posted.id,
          body: 'shared with nobody',
          visibility: 'Internal',
          user: dana,
        }),
      ).resolves.toMatchObject({ visibility: 'Internal' });
    });

    it('refuses a downgrade once a guest has been active since the share, and records it', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'something I regret sharing',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });

      // The guest loads the page after the share.
      await makeGuest(fx, { lastSeenAt: new Date(Date.now() + 1000) });

      const [seen] = await listComments(fx.workspaceId);
      expect(seen.shareLocked).toBe(true);

      await expect(
        editComment({
          workspaceId: fx.workspaceId,
          commentId: posted.id,
          body: 'something I regret sharing',
          visibility: 'Internal',
          user: dana,
        }),
      ).rejects.toThrow(VisibilityDowngradeError);

      expect(await eventTypes()).toContain('workspace.comment_downgrade_refused');

      // And it is still shared: a refused downgrade changes nothing.
      const [after] = await listComments(fx.workspaceId);
      expect(after.visibility).toBe('Shared');
      expect(after.revisionCount).toBe(1);
    });

    it('locks when the guest was active in the SAME SECOND as the share', async () => {
      // The case the smoke check caught. `created_at` and `last_seen_at` are
      // both drizzle `mode: 'timestamp'`, which stores whole seconds, so a
      // guest loading the page milliseconds after a share reads an identical
      // value. Comparing with `>` let the downgrade through; ties must lock.
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'shared, then read immediately',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });

      const [revision] = await db
        .select()
        .from(commentRevisions)
        .where(eq(commentRevisions.commentId, posted.id));
      // Exactly the share's own stored timestamp, which is what a same-second
      // page load produces once both values have been truncated.
      await makeGuest(fx, { lastSeenAt: revision.createdAt });

      const [seen] = await listComments(fx.workspaceId);
      expect(seen.shareLocked).toBe(true);
      await expect(
        editComment({
          workspaceId: fx.workspaceId,
          commentId: posted.id,
          body: 'shared, then read immediately',
          visibility: 'Internal',
          user: dana,
        }),
      ).rejects.toThrow(VisibilityDowngradeError);
    });

    it('does not lock a comment against guest activity that predates the share', async () => {
      const fx = await makeWorkspace();
      await makeGuest(fx, { lastSeenAt: new Date(Date.now() - 60_000) });
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'shared after they left',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });
      expect(posted.shareLocked).toBe(false);
    });

    it('leaves an internal comment editable regardless of guest activity', async () => {
      const fx = await makeWorkspace();
      await makeGuest(fx, { lastSeenAt: new Date(Date.now() + 1000) });
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'never shared',
        author: { kind: 'user', user: dana },
      });
      expect(posted.shareLocked).toBe(false);
      await expect(
        editComment({
          workspaceId: fx.workspaceId,
          commentId: posted.id,
          body: 'still never shared',
          visibility: 'Internal',
          user: dana,
        }),
      ).resolves.toMatchObject({ body: 'still never shared' });
    });
  });

  // ── Tombstones ────────────────────────────────────────────────────────────

  describe('deleteComment()', () => {
    it('tombstones without removing the row, and stops returning the body', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'a wrong note',
        author: { kind: 'user', user: dana },
      });

      const gone = await deleteComment(fx.workspaceId, posted.id, `user:${dana.id}`);
      expect(gone.deleted).toBe(true);
      expect(gone.body).toBeNull();
      expect(gone.deletedByActor).toBe(`user:${dana.id}`);
      expect(gone.deletedAt).not.toBeNull();

      const rows = await db
        .select()
        .from(referralComments)
        .where(eq(referralComments.id, posted.id));
      expect(rows).toHaveLength(1);

      // The wording survives on the audit path, which is the whole point.
      const history = await getCommentHistory(fx.workspaceId, posted.id);
      expect(history[0].body).toBe('a wrong note');
    });

    it('lets any internal user take a comment down, including a guest comment', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      const mine = await postComment({
        workspaceId: fx.workspaceId,
        body: 'dana wrote this',
        author: { kind: 'user', user: dana },
      });
      const theirs = await postComment({
        workspaceId: fx.workspaceId,
        body: 'the guest wrote this',
        author: { kind: 'guest', guest },
      });

      await expect(
        deleteComment(fx.workspaceId, mine.id, `user:${priya.id}`),
      ).resolves.toMatchObject({ deleted: true, deletedByActor: `user:${priya.id}` });
      await expect(
        deleteComment(fx.workspaceId, theirs.id, `user:${priya.id}`),
      ).resolves.toMatchObject({ deleted: true });
    });

    it('is idempotent', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'twice',
        author: { kind: 'user', user: dana },
      });
      const first = await deleteComment(fx.workspaceId, posted.id, `user:${dana.id}`);
      const second = await deleteComment(fx.workspaceId, posted.id, `user:${priya.id}`);
      // The second call must not overwrite who actually removed it.
      expect(second.deletedByActor).toBe(first.deletedByActor);
      expect(second.deletedAt?.getTime()).toBe(first.deletedAt?.getTime());
    });

    it('refuses an unknown comment and one from another workspace', async () => {
      const fx = await makeWorkspace();
      const other = await makeWorkspace();
      const elsewhere = await postComment({
        workspaceId: other.workspaceId,
        body: 'elsewhere',
        author: { kind: 'user', user: dana },
      });
      await expect(deleteComment(fx.workspaceId, 9999, 'user:1')).rejects.toThrow(
        CommentNotFoundError,
      );
      await expect(deleteComment(fx.workspaceId, elsewhere.id, 'user:1')).rejects.toThrow(
        CommentNotFoundError,
      );
    });
  });

  // ── The guest view ────────────────────────────────────────────────────────

  describe('listSharedComments()', () => {
    it('returns only shared, non-tombstoned comments', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);

      await postComment({
        workspaceId: fx.workspaceId,
        body: 'INTERNAL ONLY: payer is difficult',
        author: { kind: 'user', user: dana },
      });
      const shared = await postComment({
        workspaceId: fx.workspaceId,
        body: 'Could you send the echo report?',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });
      const removed = await postComment({
        workspaceId: fx.workspaceId,
        body: 'shared then retracted',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });
      await deleteComment(fx.workspaceId, removed.id, `user:${dana.id}`);
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'On its way.',
        author: { kind: 'guest', guest },
      });

      const visible = await listSharedComments(fx.workspaceId, guest.guestId);
      expect(visible.map((c) => c.body)).toEqual(['Could you send the echo report?', 'On its way.']);
      expect(visible.map((c) => c.id)).toContain(shared.id);
      expect(JSON.stringify(visible)).not.toContain('INTERNAL ONLY');
      expect(JSON.stringify(visible)).not.toContain('retracted');
    });

    it('carries exactly the allowed keys and no internal field', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'visible',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });

      const [visible] = await listSharedComments(fx.workspaceId, guest.guestId);
      // An allow-list, so a field somebody adds to the internal shape and
      // copies through fails here even though nobody listed it as forbidden.
      expect(Object.keys(visible).sort()).toEqual([...GUEST_COMMENT_KEYS].sort());
    });

    it('names the receiving organization behind an internally-authored comment', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'from us',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });
      const [visible] = await listSharedComments(fx.workspaceId, guest.guestId);
      expect(visible.authorOrgName).toBe('Specialist Care Group');
      expect(visible.authorDisplayName).toBe('Dana Ruiz');
      expect(visible.own).toBe(false);
    });

    it('marks a guest their own comments and not another guest’s', async () => {
      const fx = await makeWorkspace();
      const ruth = await makeGuest(fx, { displayName: 'Dr. Ruth Okoro' });
      const other = await makeGuest(fx, { displayName: 'Nurse Bell' });

      await postComment({
        workspaceId: fx.workspaceId,
        body: 'mine',
        author: { kind: 'guest', guest: ruth },
      });
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'theirs',
        author: { kind: 'guest', guest: other },
      });

      const seen = await listSharedComments(fx.workspaceId, ruth.guestId);
      expect(seen.map((c) => [c.body, c.own])).toEqual([
        ['mine', true],
        ['theirs', false],
      ]);
    });

    it('reports an edit without exposing what it used to say', async () => {
      const fx = await makeWorkspace();
      const guest = await makeGuest(fx);
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'SECRET FIRST DRAFT',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });
      await editComment({
        workspaceId: fx.workspaceId,
        commentId: posted.id,
        body: 'corrected text',
        visibility: 'Shared',
        user: dana,
      });

      const [visible] = await listSharedComments(fx.workspaceId, guest.guestId);
      expect(visible.edited).toBe(true);
      expect(visible.body).toBe('corrected text');
      expect(JSON.stringify(visible)).not.toContain('SECRET FIRST DRAFT');
    });

    it('does not leak comments from another workspace', async () => {
      const fx = await makeWorkspace();
      const other = await makeWorkspace();
      const guest = await makeGuest(fx);
      await postComment({
        workspaceId: other.workspaceId,
        body: 'a different patient entirely',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
      });
      await expect(listSharedComments(fx.workspaceId, guest.guestId)).resolves.toEqual([]);
    });
  });

  // ── Mentions as open items ────────────────────────────────────────────────

  describe('open mentions', () => {
    it('counts an unacknowledged user mention and clears it on acknowledgement', async () => {
      const fx = await makeWorkspace();
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'Priya, please look',
        author: { kind: 'user', user: dana },
        mentions: { users: [priya.id] },
      });

      await expect(hasUnacknowledgedMention(fx.workspaceId)).resolves.toBe(true);
      await expect(openMentionCount(fx.workspaceId, priya.id)).resolves.toBe(1);
      // Scoped per person: it is not Dana's mention to clear.
      await expect(openMentionCount(fx.workspaceId, dana.id)).resolves.toBe(0);

      await expect(
        acknowledgeMentions(fx.workspaceId, priya.id, `user:${priya.id}`),
      ).resolves.toBe(1);
      await expect(hasUnacknowledgedMention(fx.workspaceId)).resolves.toBe(false);
      await expect(openMentionCount(fx.workspaceId, priya.id)).resolves.toBe(0);
      expect(await eventTypes()).toContain('workspace.comment_mention_acknowledged');
    });

    it('acknowledges nothing, and emits nothing, when there is nothing open', async () => {
      const fx = await makeWorkspace();
      await expect(acknowledgeMentions(fx.workspaceId, priya.id, 'user:2')).resolves.toBe(0);
      expect(await eventTypes()).not.toContain('workspace.comment_mention_acknowledged');
    });

    it('never treats a party mention as an internal open item', async () => {
      const fx = await makeWorkspace();
      await postComment({
        workspaceId: fx.workspaceId,
        body: 'For Lakeside.',
        visibility: 'Shared',
        confirmShared: true,
        author: { kind: 'user', user: dana },
        mentions: { parties: [fx.initiatingPartyId] },
      });
      await expect(hasUnacknowledgedMention(fx.workspaceId)).resolves.toBe(false);
    });

    it('retracts a mention dropped by an edit', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'Priya, please look',
        author: { kind: 'user', user: dana },
        mentions: { users: [priya.id] },
      });
      await expect(hasUnacknowledgedMention(fx.workspaceId)).resolves.toBe(true);

      await editComment({
        workspaceId: fx.workspaceId,
        commentId: posted.id,
        body: 'never mind, sorted it myself',
        visibility: 'Internal',
        user: dana,
      });

      // No longer open, and not deleted either: the row is still there, attached
      // to the superseded revision.
      await expect(hasUnacknowledgedMention(fx.workspaceId)).resolves.toBe(false);
      const rows = await db
        .select()
        .from(commentMentions)
        .where(eq(commentMentions.commentId, posted.id));
      expect(rows).toHaveLength(1);
    });

    it('keeps a mention carried through an edit open', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'Priya, please look',
        author: { kind: 'user', user: dana },
        mentions: { users: [priya.id] },
      });
      await editComment({
        workspaceId: fx.workspaceId,
        commentId: posted.id,
        body: 'Priya, please look today',
        visibility: 'Internal',
        user: dana,
        mentions: { users: [priya.id] },
      });
      await expect(openMentionCount(fx.workspaceId, priya.id)).resolves.toBe(1);
    });

    it('closes an open mention when the comment is tombstoned', async () => {
      const fx = await makeWorkspace();
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: 'Priya, please look',
        author: { kind: 'user', user: dana },
        mentions: { users: [priya.id] },
      });
      await deleteComment(fx.workspaceId, posted.id, `user:${dana.id}`);
      await expect(hasUnacknowledgedMention(fx.workspaceId)).resolves.toBe(false);
    });

    it('does not see mentions on another workspace', async () => {
      const fx = await makeWorkspace();
      const other = await makeWorkspace();
      await postComment({
        workspaceId: other.workspaceId,
        body: 'Priya, over here',
        author: { kind: 'user', user: dana },
        mentions: { users: [priya.id] },
      });
      await expect(hasUnacknowledgedMention(fx.workspaceId)).resolves.toBe(false);
      await expect(hasUnacknowledgedMention(other.workspaceId)).resolves.toBe(true);
    });

    it('answers false for a nonsense workspace id rather than throwing', async () => {
      // Called from resolveProposedStatus() on every protocol transition; a
      // throw there would fail the transition itself.
      await expect(hasUnacknowledgedMention(0)).resolves.toBe(false);
      await expect(hasUnacknowledgedMention(-1)).resolves.toBe(false);
      await expect(hasUnacknowledgedMention(9999)).resolves.toBe(false);
    });
  });

  // ── Mention targets ──────────────────────────────────────────────────────

  describe('mentionTargets()', () => {
    it('offers the whole active roster, flagging who is already on the referral', async () => {
      const fx = await makeWorkspace();
      await db.insert(workspaceParticipants).values({
        workspaceId: fx.workspaceId,
        userId: priya.id,
        role: 'Collaborator',
        addedByUserId: dana.id,
        addedAt: new Date(),
      });
      await insertUser('Retired Rita', false);

      const targets = await mentionTargets(fx.workspaceId);
      const names = targets.users.map((u) => u.displayName);
      expect(names).toContain('Dana Ruiz');
      expect(names).toContain('Priya Raman');
      // The roster is not the participant list, but it is only live people.
      expect(names).not.toContain('Retired Rita');
      expect(targets.users.find((u) => u.id === priya.id)?.isParticipant).toBe(true);
    });

    it('reports which parties have a live invitation, for the share confirmation', async () => {
      const fx = await makeWorkspace();

      let targets = await mentionTargets(fx.workspaceId);
      expect(targets.parties.find((p) => p.id === fx.initiatingPartyId)?.hasLiveInvitation).toBe(
        false,
      );

      const guest = await makeGuest(fx);
      targets = await mentionTargets(fx.workspaceId);
      expect(targets.parties.find((p) => p.id === fx.initiatingPartyId)?.hasLiveInvitation).toBe(
        true,
      );

      await db
        .update(workspaceInvitations)
        .set({ revokedAt: new Date() })
        .where(eq(workspaceInvitations.id, guest.invitationId));
      targets = await mentionTargets(fx.workspaceId);
      expect(targets.parties.find((p) => p.id === fx.initiatingPartyId)?.hasLiveInvitation).toBe(
        false,
      );
    });
  });

  // ── Escaping is a render concern, but the stored bytes must be untouched ──

  describe('hostile input', () => {
    it('stores a script tag verbatim rather than sanitising it on the way in', async () => {
      const fx = await makeWorkspace();
      const hostile = '<script>alert("xss")</script> & "quotes"';
      const posted = await postComment({
        workspaceId: fx.workspaceId,
        body: hostile,
        author: { kind: 'user', user: dana },
      });
      // Escaping belongs to the render, in one place, and the smoke check is
      // what proves it happens. Mangling the text here would corrupt the record
      // and give a false sense that the render is safe.
      expect(posted.body).toBe(hostile);
    });
  });
});
