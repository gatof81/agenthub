/** Migration-runner gate (13 §4, 09 §4): scratch apply, version gap, abort-on-failure. */

import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  currentSchemaVersion,
  loadMigrations,
  migrate,
  MigrationError,
} from '../src/store/migrations.js';

const TABLES = [
  'projects',
  'conversations',
  'messages',
  'runs',
  'run_events',
  'usage_records',
  'sse_cursor',
  'run_summaries',
  'specialist_sessions',
  'tasks',
  'task_steps',
  'work_products',
  'meta',
];

function tableNames(db: InstanceType<typeof DatabaseCtor>): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe('migration runner (09 §4)', () => {
  it('applies the initial DDL from an empty database', () => {
    const db = new DatabaseCtor(':memory:');
    const version = migrate(db);
    expect(version).toBeGreaterThanOrEqual(1);
    for (const t of TABLES) expect(tableNames(db)).toContain(t);
    db.close();
  });

  it('is idempotent: re-running from the current version applies nothing', () => {
    const db = new DatabaseCtor(':memory:');
    migrate(db);
    const v1 = currentSchemaVersion(db);
    expect(migrate(db)).toBe(v1);
    db.close();
  });

  it('rolls forward across a schema-version gap', () => {
    const db = new DatabaseCtor(':memory:');
    const real = loadMigrations();
    migrate(db, real); // an "older" database at the current real version
    const gap = [
      ...real,
      { version: 900, name: '900_gap_a.sql', sql: 'CREATE TABLE gap_a (id TEXT PRIMARY KEY);' },
      { version: 901, name: '901_gap_b.sql', sql: 'CREATE TABLE gap_b (id TEXT PRIMARY KEY);' },
    ];
    expect(migrate(db, gap)).toBe(901);
    expect(tableNames(db)).toContain('gap_a');
    expect(tableNames(db)).toContain('gap_b');
    db.close();
  });

  it('003: a run queued before B5-04 keeps a NULL role — unrecorded, not "none"', () => {
    // The B5-01 lesson, as a test rather than a manual check: a migration must
    // be exercised against a populated PRIOR-ERA database, not only from empty.
    // Applying 003 to a fresh schema proves nothing about the rows it inherits.
    const db = new DatabaseCtor(':memory:');
    const real = loadMigrations();
    const era002 = real.filter((m) => m.version <= 2);
    expect(era002.length).toBeGreaterThan(0); // guard: never vacuously pass
    migrate(db, era002);

    db.exec(`
      INSERT INTO projects (id, name, default_agent_id, status, created_at, updated_at)
        VALUES ('proj_1', 'p', 'dev', 'ready', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
      INSERT INTO conversations (id, project_id, title, agent_id, status, created_at, updated_at)
        VALUES ('conv_1', 'proj_1', 't', 'dev', 'active', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
      INSERT INTO messages (id, conversation_id, role, content, run_id, created_at)
        VALUES ('msg_1', 'conv_1', 'user', 'legacy work', 'run_1', '2026-07-16T00:00:00.000Z');
      INSERT INTO runs (id, conversation_id, message_id, state, caps_snapshot, policy_snapshot, created_at)
        VALUES ('run_1', 'conv_1', 'msg_1', 'completed',
                '{"maxTurns":10,"budgetUsd":1,"timeoutMs":60000}', '["Read"]',
                '2026-07-16T00:00:00.000Z');
    `);

    expect(migrate(db, real)).toBe(8);

    // The legacy run survives, and its role reads NULL: nothing truthful could
    // be backfilled (agents.yaml is gitignored, SEC-10), so 003 records the gap
    // instead of inventing a value that would look like an audit record.
    const row = db.prepare(`SELECT * FROM runs WHERE id = 'run_1'`).get() as {
      instructions_snapshot: string | null;
      state: string;
    };
    expect(row.state).toBe('completed');
    expect(row.instructions_snapshot).toBeNull();
    db.close();
  });

  it('006 rebuilds conversations preserving data + FK integrity (N3b-2 production path)', () => {
    // Reproduces what SqliteHubStore does on a populated DB: migration 006
    // rebuilds `conversations` (to make project_id nullable), which DROPs a
    // table that messages/runs reference. The store runs migrations with
    // foreign_keys OFF and checks after — this test pins that path so the
    // rebuild can never silently orphan Diego's live rows.
    // better-sqlite3 enables FKs by default; migrate() toggles them off around
    // the rebuild and restores + checks after — this test relies on that path.
    const db = new DatabaseCtor(':memory:');
    const real = loadMigrations();
    migrate(db, real.filter((m) => m.version <= 5));
    db.exec(`
      INSERT INTO projects (id, name, default_agent_id, status, created_at, updated_at)
        VALUES ('p1', 'p', 'dev', 'ready', 't', 't');
      INSERT INTO conversations (id, project_id, title, agent_id, status, created_at, updated_at)
        VALUES ('c1', 'p1', 'title', 'dev', 'active', 't', 't');
      INSERT INTO messages (id, conversation_id, role, content, run_id, created_at)
        VALUES ('m1', 'c1', 'user', 'hi', null, 't');
    `);
    expect(migrate(db, real)).toBe(8); // rebuilds conversations; FK restored + checked inside
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1); // enforcement back on
    expect(db.pragma('foreign_key_check')).toEqual([]); // no orphans

    const conv = db.prepare(`SELECT project_id, mode FROM conversations WHERE id = 'c1'`).get() as {
      project_id: string;
      mode: string;
    };
    expect(conv).toEqual({ project_id: 'p1', mode: 'direct' }); // preserved + backfilled
    expect((db.prepare(`SELECT conversation_id FROM messages WHERE id = 'm1'`).get() as { conversation_id: string }).conversation_id).toBe('c1');
    // project_id is now nullable — a specialist conversation inserts fine
    db.exec(`INSERT INTO conversations (id, project_id, title, agent_id, mode, status, created_at, updated_at)
             VALUES ('c2', NULL, 'claudio chat', 'claudio', 'direct', 'active', 't', 't')`);
    expect((db.prepare(`SELECT project_id FROM conversations WHERE id = 'c2'`).get() as { project_id: string | null }).project_id).toBeNull();
    db.close();
  });

  it('a failing migration aborts and leaves no half-migrated database', () => {
    const db = new DatabaseCtor(':memory:');
    const real = loadMigrations();
    migrate(db, real);
    const before = currentSchemaVersion(db);
    const bad = [
      ...real,
      {
        version: 900,
        name: '900_bad.sql',
        sql: 'CREATE TABLE half (id TEXT PRIMARY KEY); CREATE TABLE oops (broken syntax here;',
      },
    ];
    expect(() => migrate(db, bad)).toThrow(MigrationError);
    expect(currentSchemaVersion(db)).toBe(before); // version untouched
    expect(tableNames(db)).not.toContain('half'); // no partial objects
    db.close();
  });
});
