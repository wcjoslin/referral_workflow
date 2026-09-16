/**
 * Guards the migration folder against two mistakes that pass CI and break a
 * real database.
 *
 * These tests run the REAL migrator against a REAL file database, unlike the
 * rest of the workspace suite which uses the hand-written DDL in
 * tests/helpers/testSchema.ts. That is the point: the hand-written DDL declares
 * no FOREIGN KEY clauses, so it cannot catch a foreign-key mistake by
 * construction.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const MIGRATIONS = join(__dirname, '../../../src/db/migrations');

describe('migration folder hygiene', () => {
  const sqlFiles = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));

  it('has migrations to check', () => {
    expect(sqlFiles.length).toBeGreaterThan(0);
  });

  /**
   * `PRAGMA foreign_keys=OFF` is a NO-OP inside a transaction, and drizzle's
   * migrator runs each migration in one. drizzle-kit emits it whenever it
   * recreates a table (the SQLite route for adding a constraint), which means
   * the generated migration keeps foreign keys ON through its `DROP TABLE` and
   * fails against any table that has children with rows.
   *
   * On an empty database there are no child rows, so it succeeds — the failure
   * only appears on a populated one. Use `defer_foreign_keys` instead, which
   * does take effect inside a transaction. 0019 is hand-edited for exactly
   * this reason and explains itself at the top of the file.
   */
  it.each(sqlFiles)('%s does not use the no-op PRAGMA foreign_keys=OFF', (file) => {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const offending = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .filter((line) => /PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(line));
    expect(offending).toEqual([]);
  });
});

describe('migrations against a populated database', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mig-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const openMigrated = (): Database.Database => {
    const sqlite = new Database(join(dir, 'test.db'));
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
    return sqlite;
  };

  it('applies cleanly to an empty database', () => {
    const sqlite = openMigrated();
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    sqlite.close();
  });

  it('leaves no __new_ scratch table behind', () => {
    const sqlite = openMigrated();
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.filter((t) => t.name.startsWith('__new_'))).toEqual([]);
    sqlite.close();
  });

  /**
   * The regression that motivated this file. A workspace with child rows in
   * every table that references it, migrated through the whole folder. If a
   * future migration recreates referral_workspaces with foreign keys enforced,
   * this fails where the empty-database test above passes.
   */
  it('preserves workspace and child rows through every migration', () => {
    const sqlite = openMigrated();
    const now = 1;
    sqlite
      .prepare("INSERT INTO patients (first_name,last_name,date_of_birth) VALUES ('A','B','1990-01-01')")
      .run();
    sqlite
      .prepare(
        'INSERT INTO referrals (patient_id,source_message_id,referrer_address,state,routing_department,created_at,updated_at)' +
          " VALUES (1,'m1','a@b.test','Received','Cardiology',?,?)",
      )
      .run(now, now);
    sqlite
      .prepare(
        "INSERT INTO users (display_name,email,job_role,all_queues_access,active,created_at) VALUES ('U','u@e.test','clinician',0,1,?)",
      )
      .run(now);
    sqlite
      .prepare(
        'INSERT INTO referral_workspaces (referral_id,work_status,work_status_is_manual,work_status_set_by,created_at,updated_at)' +
          " VALUES (1,'In-Progress',1,'user:1',?,?)",
      )
      .run(now, now);
    sqlite
      .prepare("INSERT INTO workspace_parties (workspace_id,party_role,created_at,updated_at) VALUES (1,'referring',?,?)")
      .run(now, now);

    const before = sqlite.prepare('SELECT * FROM referral_workspaces WHERE id = 1').get();
    expect(before).toMatchObject({ work_status: 'In-Progress', work_status_is_manual: 1 });
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(sqlite.pragma('integrity_check', { simple: true })).toBe('ok');
    sqlite.close();

    // Re-run the migrator over the populated file. Already-applied migrations
    // are skipped, so this asserts the folder is replayable, and any migration
    // added later runs against real child rows.
    const again = new Database(join(dir, 'test.db'));
    expect(() => migrate(drizzle(again), { migrationsFolder: MIGRATIONS })).not.toThrow();
    expect(again.prepare('SELECT * FROM referral_workspaces WHERE id = 1').get()).toEqual(before);
    expect(again.prepare('SELECT COUNT(*) c FROM workspace_parties').get()).toEqual({ c: 1 });
    expect(again.pragma('foreign_key_check')).toEqual([]);
    again.close();
  });

  it('enforces the real foreign key on referral_workspaces.queue_id (PRD-20)', () => {
    const sqlite = openMigrated();
    const fks = sqlite.pragma('foreign_key_list(referral_workspaces)') as Array<{
      from: string;
      table: string;
    }>;
    expect(fks.map((f) => `${f.from}->${f.table}`)).toContain('queue_id->queues');

    const now = 1;
    sqlite
      .prepare("INSERT INTO patients (first_name,last_name,date_of_birth) VALUES ('A','B','1990-01-01')")
      .run();
    sqlite
      .prepare(
        'INSERT INTO referrals (patient_id,source_message_id,referrer_address,state,routing_department,created_at,updated_at)' +
          " VALUES (1,'m1','a@b.test','Received','Cardiology',?,?)",
      )
      .run(now, now);
    sqlite
      .prepare(
        'INSERT INTO referral_workspaces (referral_id,work_status,work_status_is_manual,created_at,updated_at)' +
          " VALUES (1,'Triage',0,?,?)",
      )
      .run(now, now);

    expect(() => sqlite.prepare('UPDATE referral_workspaces SET queue_id = 9999 WHERE id = 1').run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );

    sqlite.prepare("INSERT INTO queues (name,slug,is_default,active,created_at) VALUES ('Q','q',0,1,?)").run(now);
    sqlite.prepare('UPDATE referral_workspaces SET queue_id = 1 WHERE id = 1').run();
    expect(sqlite.prepare('SELECT queue_id FROM referral_workspaces WHERE id = 1').get()).toEqual({ queue_id: 1 });
    sqlite.close();
  });

  it('keeps all five referral_workspaces indexes after the table recreation', () => {
    const sqlite = openMigrated();
    const names = (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='referral_workspaces'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'referral_workspaces_referral_id_unique',
        'idx_referral_workspaces_referral',
        'idx_referral_workspaces_owner',
        'idx_referral_workspaces_queue',
        'idx_referral_workspaces_due',
      ]),
    );
    sqlite.close();
  });

  it('keeps every child foreign key pointing at referral_workspaces', () => {
    const sqlite = openMigrated();
    const tables = (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    const children = tables.filter((t) =>
      (sqlite.pragma(`foreign_key_list(${t})`) as Array<{ table: string }>).some(
        (f) => f.table === 'referral_workspaces',
      ),
    );
    // Nine as of PRD-20. A table recreation that dropped these would silently
    // orphan the workspace children, so the count is pinned deliberately.
    expect(children.sort()).toEqual([
      'comment_mentions',
      'party_addresses',
      'referral_comments',
      'workspace_assertions',
      'workspace_documents',
      'workspace_guests',
      'workspace_invitations',
      'workspace_participants',
      'workspace_parties',
    ]);
    sqlite.close();
  });
});
