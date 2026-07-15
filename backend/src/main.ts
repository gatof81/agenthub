/* eslint-disable no-console -- the composition root logs startup facts; SEC-05 payload rules apply to run data, which is never logged here. No secret value is ever logged (SEC-04). */
/**
 * Composition root: the only file allowed to see every module — it wires
 * implementations into the domain ports (06 §4) and starts the server.
 * HUB_RUNTIME selects the stack (config/runtime.ts): `fake` (default) is
 * the Increment-1 offline stack; `real` (B2-05) wires the seam client and
 * the claude-cli adapter, with the OAuth token riding each run's exec env.
 */

import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildApp } from './api/app.js';
import { Broadcaster } from './api/broadcaster.js';
import { BackupService } from './backup/service.js';
import { LocalSnapshotSink } from './backup/localSink.js';
import { R2SnapshotSink } from './backup/r2Sink.js';
import { loadAgents } from './config/agents.js';
import { resolveBackupConfig } from './config/backup.js';
import { resolveRuntimeConfig } from './config/runtime.js';
import type { RuntimeAdapter, SubstrateExecPort } from './domain/ports.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { ClaudeCliRuntimeAdapter } from './runtime/claudeCliAdapter.js';
import { FakeRuntimeAdapter } from './runtime/fakeAdapter.js';
import { SqliteHubStore } from './store/sqlite.js';
import { FakeSubstrateExecPort, type ExecFixture } from './substrate/fake.js';
import { RealSubstrateExecPort } from './substrate/real.js';
import { CookieSeamAuth } from './substrate/seamAuth.js';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    console.error(`missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

function fixtureCycler(fixturesDir: string): () => ExecFixture {
  const phases = readdirSync(fixturesDir).filter((d) => /^p\d/.test(d));
  const usable = phases.filter((p) => {
    try {
      readFileSync(join(fixturesDir, p, 'stream.jsonl'));
      return true;
    } catch {
      return false;
    }
  });
  if (usable.length === 0) throw new Error(`no stream.jsonl fixtures under ${fixturesDir}`);
  let i = 0;
  return () => {
    const phase = usable[i % usable.length]!;
    i += 1;
    return {
      streamLines: readFileSync(join(fixturesDir, phase, 'stream.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== ''),
    };
  };
}

async function main(): Promise<void> {
  const port = Number(env('HUB_PORT', '8790'));
  const dbPath = env('HUB_DB_PATH', './hub.sqlite');
  const authToken = env('HUB_API_TOKEN');
  const agentsPath = env('AGENTS_CONFIG', './agents.example.yaml');
  const runtimeConfig = resolveRuntimeConfig(process.env);

  const agents = loadAgents(agentsPath);
  const store = new SqliteHubStore(dbPath);
  const broadcaster = new Broadcaster();

  let execPort: SubstrateExecPort;
  let adapter: RuntimeAdapter;
  let runEnv: Record<string, string> = {};
  if (runtimeConfig.kind === 'real') {
    const auth = new CookieSeamAuth({
      baseUrl: runtimeConfig.seamBaseUrl,
      username: runtimeConfig.seamUsername,
      password: runtimeConfig.seamPassword,
    });
    execPort = new RealSubstrateExecPort({ baseUrl: runtimeConfig.seamBaseUrl, auth });
    adapter = new ClaudeCliRuntimeAdapter(execPort);
    // env-only credential path (SEC-07): the token rides each run's exec
    // env and exists nowhere else — never persisted, never logged (13 §5)
    runEnv = { CLAUDE_CODE_OAUTH_TOKEN: runtimeConfig.oauthToken };
  } else {
    const fakePort = new FakeSubstrateExecPort({
      fixtureProvider: fixtureCycler(runtimeConfig.fixturesDir),
    });
    execPort = fakePort;
    adapter = new FakeRuntimeAdapter(fakePort);
  }

  const orchestrator = new Orchestrator({
    store,
    adapter,
    execPort,
    agents,
    notify: broadcaster,
    runEnv,
  });

  // boot reconciliation runs before the API accepts writes (07 §3, UC-06)
  await orchestrator.reconcile();

  // backup pipeline (B3-04): a snapshot sink + periodic VACUUM INTO → gzip →
  // upload, with the freshness gauge surfaced on /api/health (OPS-01/02)
  const backupConfig = resolveBackupConfig(process.env);
  let backupService: BackupService | undefined;
  if (backupConfig.kind !== 'none') {
    const tmpDir = join(dbDir(dbPath), 'backup-tmp');
    mkdirSync(tmpDir, { recursive: true });
    const sink =
      backupConfig.kind === 'r2'
        ? new R2SnapshotSink(backupConfig)
        : new LocalSnapshotSink(backupConfig.dir);
    backupService = new BackupService({
      snapshot: (dest) => store.snapshotTo(dest),
      sink,
      tmpDir,
      intervalMs: backupConfig.intervalMs,
    });
    backupService.start();
    console.log(`backup: ${backupConfig.kind} sink, every ${backupConfig.intervalMs} ms`);
  }

  const app = buildApp({
    store,
    orchestrator,
    agents,
    broadcaster,
    authToken,
    ...(backupService
      ? {
          snapshotFreshness: () => {
            const f = backupService!.freshness();
            return { lastSnapshotAt: f.lastSnapshotAt, degraded: f.degraded };
          },
        }
      : {}),
  });
  app.listen(port, () => {
    console.log(`agenthub backend listening on :${port} (runtime: ${runtimeConfig.kind})`);
  });

  // clean-shutdown snapshot (09 §5) + graceful stop
  const shutdown = (): void => {
    backupService?.stop();
    void backupService?.snapshotOnce().finally(() => process.exit(0));
    if (!backupService) process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/** Directory of the SQLite db file — the backup temp dir lives beside it. */
function dbDir(dbPath: string): string {
  return dbPath === ':memory:' ? '.' : dirname(dbPath);
}

main().catch((err: unknown) => {
  console.error('fatal during startup:', err);
  process.exit(1);
});
