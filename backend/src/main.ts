/* eslint-disable no-console -- the composition root logs startup facts; SEC-05 payload rules apply to run data, which is never logged here. No secret value is ever logged (SEC-04). */
/**
 * Composition root: the only file allowed to see every module — it wires
 * implementations into the domain ports (06 §4) and starts the server.
 * HUB_RUNTIME selects the stack (config/runtime.ts): `fake` (default) is
 * the Increment-1 offline stack; `real` (B2-05) wires the seam client and
 * the claude-cli adapter, with the OAuth token riding each run's exec env.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAccessVerifier } from './api/accessAuth.js';
import { buildApp } from './api/app.js';
import { Broadcaster } from './api/broadcaster.js';
import { BackupService } from './backup/service.js';
import { LocalSnapshotSink } from './backup/localSink.js';
import { R2SnapshotSink } from './backup/r2Sink.js';
import { loadAgents } from './config/agents.js';
import { loadWorkspaceTemplates } from './config/workspaceTemplates.js';
import { resolveBackupConfig } from './config/backup.js';
import { resolveTokenPrices } from './config/budget.js';
import { resolveRuntimeConfig } from './config/runtime.js';
import type { RuntimeAdapter, SubstrateExecPort } from './domain/ports.js';
import { JsonLogger } from './observability/logger.js';
import { CountingMetrics } from './observability/metrics.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { ModelRouter } from './orchestrator/modelRouter.js';
import { DeterministicRouter } from './orchestrator/router.js';
import {
  DeterministicReportExtractor,
  ModelReportExtractor,
} from './orchestrator/reportExtractor.js';
import { FakeWorkspaceManager, RealWorkspaceManager } from './orchestrator/workspaceManager.js';
import type { ReportExtractorPort, RouterPort, WorkspaceManagerPort } from './domain/ports.js';
import { ClaudeCliRuntimeAdapter } from './runtime/claudeCliAdapter.js';
import { FakeRuntimeAdapter } from './runtime/fakeAdapter.js';
import { SqliteHubStore } from './store/sqlite.js';
import { FakeSubstrateExecPort, type ExecFixture } from './substrate/fake.js';
import { RealSubstrateExecPort } from './substrate/real.js';
import { CookieSeamAuth } from './substrate/seamAuth.js';

/**
 * How long the clean-shutdown snapshot may take before the process exits
 * anyway. Generous next to a healthy snapshot (~1 s against R2 from the
 * deployment host) and well under systemd's default 90 s SIGKILL, so the
 * timeout — not the kill — is what ends a wedged shutdown, and it leaves a
 * log line behind.
 */
const SHUTDOWN_SNAPSHOT_TIMEOUT_MS = 15_000;

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
  // the client picks the project's workspace from these (ADR-006, FR-45)
  const workspaceTemplates = loadWorkspaceTemplates(agentsPath);
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
    execPort = new RealSubstrateExecPort({
      baseUrl: runtimeConfig.seamBaseUrl,
      auth,
      // own-scope discovery rows are attributed to the execution identity
      // itself (N1, FR-48) — the wire carries no owner for the caller's rows
      selfUsername: runtimeConfig.seamUsername,
      // create new project sessions in the owner's account on their behalf
      // (N2, #420) when configured; absent → self-owned (legacy-technical)
      ...(runtimeConfig.seamOwnerUserId ? { ownerUserId: runtimeConfig.seamOwnerUserId } : {}),
    });
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

  // observability (B3-07): structured logs + process-local metrics. Gauges
  // read live from the store; the DB-size gauges point at the sqlite file.
  const logger = new JsonLogger();
  const metrics = new CountingMetrics({
    activeRuns: () => store.listRunsByState(['starting', 'streaming']).length,
    queuedRuns: () => store.listRunsByState(['queued']).length,
    dbPath: dbPath === ':memory:' ? null : dbPath,
  });

  // Automatic-mode router (ADR-008/012): the message-aware model router in
  // `real` mode (one cheap Haiku call, reusing the OAuth token, deterministic
  // fallback on failure); the offline deterministic router in `fake` mode, so
  // CI stays credential-free (13 §6).
  const router: RouterPort =
    runtimeConfig.kind === 'real'
      ? new ModelRouter({ oauthToken: runtimeConfig.oauthToken, logger })
      : new DeterministicRouter();

  // Task work-product extractor (N5b, ADR-009): the model-backed one in `real`
  // (a cheap Haiku forced tool call, reusing the OAuth token, mechanical
  // fallback), the deterministic one offline. Same real/fake split as the router.
  const reportExtractor: ReportExtractorPort =
    runtimeConfig.kind === 'real'
      ? new ModelReportExtractor({ oauthToken: runtimeConfig.oauthToken, logger })
      : new DeterministicReportExtractor();

  // Task worktree isolation (N5b-2, ADR-010 B): git worktrees over the exec seam
  // in `real`; a deterministic no-git descriptor offline. Same real/fake split.
  const workspaceManager: WorkspaceManagerPort =
    runtimeConfig.kind === 'real'
      ? new RealWorkspaceManager({ store, execPort, logger })
      : new FakeWorkspaceManager();

  // The developer → QA task envelope is opt-in (N5b): only a configured QA
  // specialist arms it, so a hub without one spawns no tasks and every message
  // runs as an ordinary turn (prod-safe default). Ignored — with a warning — if
  // it does not name a loaded agent, so a typo never fails every task.
  let qaSpecialistId = process.env.HUB_QA_SPECIALIST?.trim() || undefined;
  if (qaSpecialistId && !agents.has(qaSpecialistId)) {
    logger.warn('config.qa_specialist_unknown', { specialistId: qaSpecialistId });
    qaSpecialistId = undefined;
  }

  const orchestrator = new Orchestrator({
    store,
    adapter,
    execPort,
    agents,
    router,
    reportExtractor,
    workspaceManager,
    ...(qaSpecialistId ? { qaSpecialistId } : {}),
    notify: broadcaster,
    runEnv,
    tokenPrices: resolveTokenPrices(process.env), // budget estimate (B3-06)
    logger,
    metrics,
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
    // Seed the freshness gauge from the sink so /api/health reads fresh from
    // boot when a snapshot already exists, not degraded until the first tick
    // (OPS-01/02). Best-effort — a list() failure just leaves it degraded.
    await backupService.seedFromSink();
    backupService.start();
    logger.info('backup.enabled', { sink: backupConfig.kind, intervalMs: backupConfig.intervalMs });
  }

  // Serve the built SPA same-origin with /api (ADR-002). Default location is
  // frontend/dist beside the repo; HUB_STATIC_DIR overrides. Only wired when
  // actually built — an API-only boot (no dist yet) still starts, it just
  // doesn't serve a SPA (the browser gets the API, no static UI).
  const defaultStaticDir = join(dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
  const staticDir = process.env.HUB_STATIC_DIR ?? defaultStaticDir;
  const spaDir = existsSync(join(staticDir, 'index.html')) ? staticDir : undefined;
  logger.info('spa.static', { serving: spaDir !== undefined });

  // Cloudflare Access JWT verification for browser traffic (Q-07, ADR-011).
  // Absent env → bearer-only (dev/local). Names only, never values (SEC-04).
  const accessVerifier = resolveAccessVerifier(process.env);
  logger.info('access.jwt', { enabled: accessVerifier !== null });

  const app = buildApp({
    store,
    orchestrator,
    agents,
    workspaceTemplates,
    broadcaster,
    authToken,
    ...(accessVerifier !== null ? { accessVerifier } : {}),
    ...(spaDir !== undefined ? { staticDir: spaDir } : {}),
    logger,
    metricsSnapshot: () => ({ ...metrics.snapshot() }),
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
    logger.info('server.listening', { port, runtime: runtimeConfig.kind });
  });

  // clean-shutdown snapshot (09 §5) + graceful stop.
  //
  // Bounded and always logged (B3-09). Previously this awaited an unbounded
  // snapshotOnce() and logged only failures — so a snapshot that never
  // settled left the process hung forever with an empty log, and a snapshot
  // that worked was equally silent. Both were observed: under `tsx` the
  // shutdown snapshot's first R2 request never completes (which is why the
  // production entrypoint is now compiled JS — see `npm run build`). The
  // race below is the belt to that fix's braces: shutdown stays bounded even
  // if a sink wedges, and the operator always learns the outcome.
  const shutdown = (): void => {
    if (!backupService) {
      process.exit(0);
      return;
    }
    backupService.stop();
    void backupService
      .snapshotOnceBounded(SHUTDOWN_SNAPSHOT_TIMEOUT_MS)
      .then((r) => {
        if (r.outcome === 'timeout') {
          logger.error('backup.shutdown_snapshot_timeout', {
            timeoutMs: SHUTDOWN_SNAPSHOT_TIMEOUT_MS,
          });
        } else if (r.outcome === 'failed') {
          logger.error('backup.shutdown_snapshot_failed', {});
        } else {
          logger.info('backup.shutdown_snapshot', { key: r.key });
        }
      })
      .finally(() => process.exit(0));
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
