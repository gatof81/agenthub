/**
 * Migration runner (09 §4): numbered forward-only SQL files applied at boot,
 * each inside a transaction gated by meta.schema_version. A failed migration
 * aborts startup — never a half-migrated serving process. No down-migrations
 * (restore from snapshot is the rollback story).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  return files.map((file) => {
    const version = Number.parseInt(file.split('_')[0]!, 10);
    return { version, name: file, sql: readFileSync(join(dir, file), 'utf8') };
  });
}

export class MigrationError extends Error {
  constructor(
    readonly migration: string,
    cause: unknown,
  ) {
    super(`migration ${migration} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MigrationError';
    this.cause = cause;
  }
}

export function currentSchemaVersion(db: Database): number {
  const hasMeta = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
    .get();
  if (!hasMeta) return 0;
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? Number.parseInt(row.value, 10) : 0;
}

/** Applies every migration above the stored version, in order, one tx each. */
export function migrate(db: Database, migrations: Migration[] = loadMigrations()): number {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  // Table rebuilds (e.g. migration 006 makes conversations.project_id nullable)
  // DROP a table that messages/runs reference, which trips FK enforcement.
  // PRAGMA foreign_keys is a no-op inside a transaction, so toggle it here —
  // around every migration transaction — and, when it was on, verify no orphan
  // was introduced before restoring. better-sqlite3 enables FKs by default, so
  // this matters for every caller, not just SqliteHubStore.
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF');
  try {
    for (const m of sorted) {
      if (m.version <= currentSchemaVersion(db)) continue;
      const apply = db.transaction(() => {
        db.exec(m.sql);
        db.prepare(
          `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(String(m.version));
      });
      try {
        apply();
      } catch (err) {
        throw new MigrationError(m.name, err);
      }
    }
    if (fkWasOn) {
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(`foreign_key_check found ${violations.length} violation(s) after migration`);
      }
    }
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
  return currentSchemaVersion(db);
}
