/**
 * Unit tests for participantService.ts (PRD-24)
 *
 * The properties worth holding onto:
 *
 *   - ONE ROW PER PERSON. Adding, re-roling and re-adding after removal all
 *     land on the same row. The unique index deliberately leaves `removed_at`
 *     out, so a second insert would fail outright rather than quietly
 *     duplicating — which means the revive path is load-bearing, not a nicety.
 *   - THE OWNER STAYS. They are a Manager by definition and cannot be removed,
 *     because the accountable person must not be missing from the list of
 *     people involved.
 *   - A no-op emits nothing, the same position PRD-21 takes.
 */

jest.mock('../../../src/config', () => ({
  config: {
    smtp: { host: 'smtp.test', port: 587, user: 'user', password: 'pass' },
    receiving: { directAddress: 'receiving@specialist.direct', orgName: 'Specialist Care Group' },
    database: { url: ':memory:' },
  },
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
  patients,
  referralWorkspaces,
  referrals,
  users,
  workflowEvents,
  workspaceParticipants,
} from '../../../src/db/schema';
import { ReferralState } from '../../../src/state/referralStateMachine';
import { WorkStatus } from '../../../src/state/workStatusMachine';
import { ActingUser } from '../../../src/modules/workspace/identityService';
import {
  CannotRemoveOwnerError,
  ParticipantUserNotFoundError,
  WorkspaceNotFoundError,
  addParticipant,
  getParticipants,
  removeParticipant,
  resolveNotificationRecipients,
  syncOwnerParticipant,
} from '../../../src/modules/workspace/participantService';

let patientId: number;
let seq = 0;

const acting = (id: number): ActingUser => ({
  id,
  displayName: `User ${id}`,
  email: `u${id}@example.test`,
  directAddress: null,
  jobRole: 'coordinator',
  legacyClinicianId: null,
  allQueuesAccess: false,
  active: true,
});

beforeAll(async () => {
  const [patient] = await db
    .insert(patients)
    .values({ firstName: 'Ada', lastName: 'Lovelace', dateOfBirth: '1815-12-10' })
    .returning();
  patientId = patient.id;
});

beforeEach(async () => {
  await db.delete(workspaceParticipants);
  await db.delete(workflowEvents);
  await db.delete(referralWorkspaces);
  await db.delete(referrals);
  await db.delete(users);
});

async function insertUser(displayName: string, active = true): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      displayName,
      email: `${displayName.toLowerCase().replace(/\W+/g, '.')}-${++seq}@example.test`,
      jobRole: 'coordinator',
      allQueuesAccess: false,
      active,
      createdAt: new Date(),
    })
    .returning();
  return row.id;
}

async function makeWorkspace(ownerUserId: number | null = null): Promise<number> {
  const [referral] = await db
    .insert(referrals)
    .values({
      patientId,
      sourceMessageId: `participant-${++seq}-${Date.now()}`,
      referrerAddress: 'referrals@lakeside.direct',
      state: ReferralState.ACKNOWLEDGED,
      routingDepartment: 'Cardiology',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const [workspace] = await db
    .insert(referralWorkspaces)
    .values({
      referralId: referral.id,
      workStatus: WorkStatus.TRIAGE,
      workStatusIsManual: false,
      ownerUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  return workspace.id;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

const events = async (): Promise<string[]> =>
  (await db.select().from(workflowEvents)).map((e) => e.eventType);

const rowsFor = async (workspaceId: number, userId: number): Promise<number> =>
  (
    await db
      .select()
      .from(workspaceParticipants)
      .where(
        and(
          eq(workspaceParticipants.workspaceId, workspaceId),
          eq(workspaceParticipants.userId, userId),
        ),
      )
  ).length;

describe('addParticipant()', () => {
  it('adds somebody with the requested role and emits', async () => {
    const actor = await insertUser('Dana Ruiz');
    const target = await insertUser('Priya Raman');
    const workspaceId = await makeWorkspace();

    const participant = await addParticipant(workspaceId, target, 'Collaborator', acting(actor));
    await flush();

    expect(participant.displayName).toBe('Priya Raman');
    expect(participant.role).toBe('Collaborator');
    expect(await events()).toContain('workspace.participant_added');
  });

  it('records who added them', async () => {
    const actor = await insertUser('Dana Ruiz');
    const target = await insertUser('Priya Raman');
    const workspaceId = await makeWorkspace();

    await addParticipant(workspaceId, target, 'Viewer', acting(actor));

    const [participant] = await getParticipants(workspaceId);
    expect(participant.addedByDisplayName).toBe('Dana Ruiz');
  });

  it('updates the role of somebody already present instead of duplicating them', async () => {
    const actor = await insertUser('Dana Ruiz');
    const target = await insertUser('Priya Raman');
    const workspaceId = await makeWorkspace();

    await addParticipant(workspaceId, target, 'Viewer', acting(actor));
    const updated = await addParticipant(workspaceId, target, 'Manager', acting(actor));
    await flush();

    expect(updated.role).toBe('Manager');
    expect(await rowsFor(workspaceId, target)).toBe(1);
    expect(await events()).toContain('workspace.participant_role_changed');
  });

  it('emits nothing when the role is unchanged', async () => {
    const actor = await insertUser('Dana Ruiz');
    const target = await insertUser('Priya Raman');
    const workspaceId = await makeWorkspace();

    await addParticipant(workspaceId, target, 'Viewer', acting(actor));
    await flush();
    await db.delete(workflowEvents);

    await addParticipant(workspaceId, target, 'Viewer', acting(actor));
    await flush();

    // A feed full of "added the person who was already added" is worse than no
    // feed at all.
    expect(await events()).toEqual([]);
  });

  it('REVIVES a removed participant rather than inserting a second row', async () => {
    const actor = await insertUser('Dana Ruiz');
    const target = await insertUser('Priya Raman');
    const workspaceId = await makeWorkspace();

    await addParticipant(workspaceId, target, 'Viewer', acting(actor));
    await removeParticipant(workspaceId, target, acting(actor));
    await flush();
    await db.delete(workflowEvents);

    const revived = await addParticipant(workspaceId, target, 'Collaborator', acting(actor));
    await flush();

    // The unique index leaves removed_at out on purpose, so a second insert
    // would throw — this path is what makes re-adding work at all.
    expect(await rowsFor(workspaceId, target)).toBe(1);
    expect(revived.role).toBe('Collaborator');
    expect(await events()).toContain('workspace.participant_added');
  });

  it('refuses an unknown user', async () => {
    const actor = await insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace();

    await expect(addParticipant(workspaceId, 99999, 'Viewer', acting(actor))).rejects.toThrow(
      ParticipantUserNotFoundError,
    );
  });

  it('refuses an inactive user', async () => {
    const actor = await insertUser('Dana Ruiz');
    const gone = await insertUser('Departed Person', false);
    const workspaceId = await makeWorkspace();

    // Same rule PRD-21 applies to assignment: involving somebody who has left
    // is not a thing to allow on purpose.
    await expect(addParticipant(workspaceId, gone, 'Viewer', acting(actor))).rejects.toThrow(
      ParticipantUserNotFoundError,
    );
  });

  it('throws for a workspace that does not exist', async () => {
    const actor = await insertUser('Dana Ruiz');
    const target = await insertUser('Priya Raman');

    await expect(addParticipant(99999, target, 'Viewer', acting(actor))).rejects.toThrow(
      WorkspaceNotFoundError,
    );
  });
});

describe('getParticipants()', () => {
  it('still lists somebody deactivated after being added, marked inactive', async () => {
    const actor = await insertUser('Dana Ruiz');
    const target = await insertUser('Priya Raman');
    const workspaceId = await makeWorkspace();

    await addParticipant(workspaceId, target, 'Collaborator', acting(actor));
    await db.update(users).set({ active: false }).where(eq(users.id, target));

    const [participant] = await getParticipants(workspaceId);
    // They really were involved, so removing them from the record would be a
    // lie. A greyed-out name is honest; an absent one is not.
    expect(participant.displayName).toBe('Priya Raman');
    expect(participant.inactive).toBe(true);
  });

  it('marks the owner', async () => {
    const owner = await insertUser('Dana Ruiz');
    const other = await insertUser('Priya Raman');
    const workspaceId = await makeWorkspace(owner);

    await addParticipant(workspaceId, owner, 'Manager', acting(owner));
    await addParticipant(workspaceId, other, 'Viewer', acting(owner));

    const participants = await getParticipants(workspaceId);
    expect(participants.find((p) => p.userId === owner)!.isOwner).toBe(true);
    expect(participants.find((p) => p.userId === other)!.isOwner).toBe(false);
  });

  it('orders Managers, then Collaborators, then Viewers', async () => {
    const actor = await insertUser('Dana Ruiz');
    const viewer = await insertUser('Viewer Person');
    const manager = await insertUser('Manager Person');
    const collaborator = await insertUser('Collaborator Person');
    const workspaceId = await makeWorkspace();

    await addParticipant(workspaceId, viewer, 'Viewer', acting(actor));
    await addParticipant(workspaceId, manager, 'Manager', acting(actor));
    await addParticipant(workspaceId, collaborator, 'Collaborator', acting(actor));

    expect((await getParticipants(workspaceId)).map((p) => p.role)).toEqual([
      'Manager',
      'Collaborator',
      'Viewer',
    ]);
  });

  it('excludes removed participants', async () => {
    const actor = await insertUser('Dana Ruiz');
    const target = await insertUser('Priya Raman');
    const workspaceId = await makeWorkspace();

    await addParticipant(workspaceId, target, 'Viewer', acting(actor));
    await removeParticipant(workspaceId, target, acting(actor));

    expect(await getParticipants(workspaceId)).toEqual([]);
  });
});

describe('removeParticipant()', () => {
  it('soft-removes rather than deleting, so nothing they authored is orphaned', async () => {
    const actor = await insertUser('Dana Ruiz');
    const target = await insertUser('Priya Raman');
    const workspaceId = await makeWorkspace();

    await addParticipant(workspaceId, target, 'Viewer', acting(actor));
    await removeParticipant(workspaceId, target, acting(actor));
    await flush();

    expect(await rowsFor(workspaceId, target)).toBe(1);
    expect(await getParticipants(workspaceId)).toEqual([]);
    expect(await events()).toContain('workspace.participant_removed');
  });

  it('refuses the current owner', async () => {
    const owner = await insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace(owner);
    await addParticipant(workspaceId, owner, 'Manager', acting(owner));

    await expect(removeParticipant(workspaceId, owner, acting(owner))).rejects.toThrow(
      CannotRemoveOwnerError,
    );
    expect(await getParticipants(workspaceId)).toHaveLength(1);
  });

  it('is a no-op for somebody who is not a participant', async () => {
    const actor = await insertUser('Dana Ruiz');
    const stranger = await insertUser('Not Involved');
    const workspaceId = await makeWorkspace();

    await expect(removeParticipant(workspaceId, stranger, acting(actor))).resolves.toBeUndefined();
    await flush();
    expect(await events()).toEqual([]);
  });
});

describe('syncOwnerParticipant()', () => {
  it('puts the owner on the roster as a Manager', async () => {
    const owner = await insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace(owner);

    await syncOwnerParticipant(workspaceId, owner, acting(owner));

    const [participant] = await getParticipants(workspaceId);
    expect(participant.userId).toBe(owner);
    expect(participant.role).toBe('Manager');
    expect(participant.isOwner).toBe(true);
  });

  it('does not throw for an owner deactivated after assignment', async () => {
    // PRD-21 AC7a: such a person stays the owner. This must not blow up trying
    // to add them, so it has nothing to do instead.
    const owner = await insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace(owner);
    await db.update(users).set({ active: false }).where(eq(users.id, owner));

    await expect(syncOwnerParticipant(workspaceId, owner, acting(owner))).resolves.toBeUndefined();
  });

  it('leaves a previous owner on the roster when ownership moves', async () => {
    const first = await insertUser('Dana Ruiz');
    const second = await insertUser('Priya Raman');
    const workspaceId = await makeWorkspace(first);

    await syncOwnerParticipant(workspaceId, first, acting(first));
    await db.update(referralWorkspaces).set({ ownerUserId: second }).where(eq(referralWorkspaces.id, workspaceId));
    await syncOwnerParticipant(workspaceId, second, acting(second));

    // The previous owner really was involved; dropping them would lose that.
    const participants = await getParticipants(workspaceId);
    expect(participants.map((p) => p.userId).sort()).toEqual([first, second].sort());
    expect(participants.find((p) => p.userId === second)!.isOwner).toBe(true);
    expect(participants.find((p) => p.userId === first)!.isOwner).toBe(false);
  });
});

describe('resolveNotificationRecipients()', () => {
  it('includes the owner and every role, Viewers among them', async () => {
    const owner = await insertUser('Dana Ruiz');
    const viewer = await insertUser('Viewer Person');
    const collaborator = await insertUser('Collaborator Person');
    const workspaceId = await makeWorkspace(owner);

    await addParticipant(workspaceId, viewer, 'Viewer', acting(owner));
    await addParticipant(workspaceId, collaborator, 'Collaborator', acting(owner));

    // A Viewer was added because somebody wanted them to see it; silently
    // excluding them from notifications would defeat the point of adding them.
    expect(await resolveNotificationRecipients(workspaceId)).toEqual(
      [owner, viewer, collaborator].sort((a, b) => a - b),
    );
  });

  it('deduplicates the owner who is also a participant', async () => {
    const owner = await insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace(owner);
    await addParticipant(workspaceId, owner, 'Manager', acting(owner));

    expect(await resolveNotificationRecipients(workspaceId)).toEqual([owner]);
  });

  it('excludes removed participants', async () => {
    const owner = await insertUser('Dana Ruiz');
    const gone = await insertUser('Priya Raman');
    const workspaceId = await makeWorkspace(owner);

    await addParticipant(workspaceId, gone, 'Viewer', acting(owner));
    await removeParticipant(workspaceId, gone, acting(owner));

    expect(await resolveNotificationRecipients(workspaceId)).toEqual([owner]);
  });

  it('excludes a deactivated participant, who is still listed on the roster', async () => {
    const owner = await insertUser('Dana Ruiz');
    const target = await insertUser('Priya Raman');
    const workspaceId = await makeWorkspace(owner);

    await addParticipant(workspaceId, target, 'Collaborator', acting(owner));
    await db.update(users).set({ active: false }).where(eq(users.id, target));

    // Shown on the roster because they were involved; not mailed, because mail
    // to somebody who has left is waste.
    expect((await getParticipants(workspaceId)).map((p) => p.userId)).toContain(target);
    expect(await resolveNotificationRecipients(workspaceId)).toEqual([owner]);
  });

  it('returns just the owner on a workspace with no participants', async () => {
    const owner = await insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace(owner);

    expect(await resolveNotificationRecipients(workspaceId)).toEqual([owner]);
  });

  it('returns nothing for an unassigned workspace with nobody on it', async () => {
    const workspaceId = await makeWorkspace(null);
    expect(await resolveNotificationRecipients(workspaceId)).toEqual([]);
  });

  it('excludes parties entirely — they are notified through PRD-30, not here', async () => {
    const owner = await insertUser('Dana Ruiz');
    const workspaceId = await makeWorkspace(owner);

    // Asserted as a shape guarantee: the return is user ids only, so there is
    // nowhere for an external organization's address to appear even by accident.
    const recipients = await resolveNotificationRecipients(workspaceId);
    expect(recipients.every((r) => typeof r === 'number')).toBe(true);
    expect(recipients).toEqual([owner]);
  });
});
