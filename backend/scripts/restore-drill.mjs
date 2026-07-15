/**
 * Restore drill (B3-04, OPS-03): download the newest snapshot from the
 * configured sink, decompress it into a scratch db, open it as a HubStore,
 * and assert it is a live, queryable database. Run once before Phase-1 exit
 * against the production sink (read-only — never writes to the sink).
 *
 *   node --import tsx scripts/restore-drill.mjs
 *
 * Reads the same BACKUP_SINK / R2_* / BACKUP_LOCAL_DIR env the server uses.
 */

import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBackupConfig } from '../src/config/backup.ts';
import { LocalSnapshotSink } from '../src/backup/localSink.ts';
import { R2SnapshotSink } from '../src/backup/r2Sink.ts';
import { SqliteHubStore } from '../src/store/sqlite.ts';

const cfg = resolveBackupConfig(process.env);
if (cfg.kind === 'none') {
  console.error('BACKUP_SINK is none — nothing to restore. Set local or r2.');
  process.exit(2);
}
const sink = cfg.kind === 'r2' ? new R2SnapshotSink(cfg) : new LocalSnapshotSink(cfg.dir);

const snapshots = (await sink.list('snapshots')).map((s) => s.key).sort();
if (snapshots.length === 0) {
  console.error('no snapshots found in the sink');
  process.exit(1);
}
const newest = snapshots[snapshots.length - 1];
console.log(`restoring newest snapshot: ${newest} (of ${snapshots.length})`);

const dir = mkdtempSync(join(tmpdir(), 'hub-restore-drill-'));
const dbPath = join(dir, 'restored.sqlite');
try {
  writeFileSync(dbPath, gunzipSync(await sink.get(newest)));
  const store = new SqliteHubStore(dbPath);
  const projects = store.listProjects({ includeArchived: true });
  const active = store.listRunsByState(['queued', 'starting', 'streaming', 'interrupted']);
  store.close();
  console.log(`RESTORE_OK — ${projects.length} projects, ${active.length} non-terminal runs`);
  console.log('the restored db opened, migrated clean, and is queryable.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
