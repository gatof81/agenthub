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
