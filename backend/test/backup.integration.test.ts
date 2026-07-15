/**
 * B3-04 end-to-end (offline): real SqliteHubStore VACUUM INTO → gzip → local
 * sink → decompress → reopen as a store and read the data back. Proves the
 * snapshot is a consistent, restorable copy (09 §5), not a raw WAL file.
 */

import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupService } from '../src/backup/service.js';
import { LocalSnapshotSink } from '../src/backup/localSink.js';
import { SqliteHubStore } from '../src/store/sqlite.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-bkint-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('backup end-to-end (VACUUM INTO → sink → restore)', () => {
  it('snapshots a live store and the restored copy has the same data', async () => {
    const dbPath = join(dir, 'hub.sqlite');
    const store = new SqliteHubStore(dbPath);
    const project = store.createProject({ name: 'keepme', defaultAgentId: 'dev' });

    const sink = new LocalSnapshotSink(join(dir, 'snap'));
    const svc = new BackupService({
      snapshot: (dest) => store.snapshotTo(dest),
      sink,
      tmpDir: dir,
      intervalMs: 3600_000,
      now: () => new Date('2026-07-15T09:00:00Z'),
      log: () => {},
    });

    const key = await svc.snapshotOnce();
    expect(key).toBe('snapshots/2026-07-15T090000Z.sqlite.gz');

    // restore: decompress into a fresh file, reopen as a store
    const restoredPath = join(dir, 'restored.sqlite');
    writeFileSync(restoredPath, gunzipSync(await sink.get(key!)));
    const restored = new SqliteHubStore(restoredPath);
    expect(restored.getProject(project.id)?.name).toBe('keepme');

    store.close();
    restored.close();
  });
});
