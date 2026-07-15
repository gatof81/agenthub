/**
 * B3-04 restore drill, the full 13 §4 flow offline: seed a store with an
 * in-flight run, snapshot (VACUUM INTO → gzip → local sink), restore into a
 * scratch db, run boot reconciliation on the restored store (heals the run
 * to a legal state), and prove a fresh turn runs against it. The live R2
 * variant of this drill is B3-05.
 */

import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupService } from '../src/backup/service.js';
import { LocalSnapshotSink } from '../src/backup/localSink.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { SqliteHubStore } from '../src/store/sqlite.js';
import type { Agent } from '../src/domain/types.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

const DEV: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'dev',
  allowedTools: ['Read', 'Bash'],
  sessionTemplateId: 'tpl',
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-bkint-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('backup restore drill (13 §4, offline)', () => {
  it('snapshot with an in-flight run → restore → reconcile heals it → a turn runs', async () => {
    // — a "live" store that crashes mid-run —
    const dbPath = join(dir, 'hub.sqlite');
    const store = new SqliteHubStore(dbPath);
    const project = store.createProject({ name: 'keepme', defaultAgentId: 'dev' });
    store.setProjectSession(project.id, { sessionId: 'sess_1', templateId: 'tpl' });
    store.updateProject(project.id, { status: 'ready' });
    const conv = store.createConversation({ projectId: project.id, title: 't', agentId: 'dev' });
    const { run } = store.sendMessage({
      conversationId: conv.id,
      content: 'in-flight work',
      caps: DEV.defaultCaps,
      policy: DEV.allowedTools,
    });
    store.dispatchNextRun(project.id);
    store.transitionRun(run.id, 'starting', 'streaming', { execId: 'exec_x', pgid: 2 });

    // — snapshot → gzip → local sink —
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
    store.close(); // the crash

    // — restore into a scratch db —
    const restoredPath = join(dir, 'restored.sqlite');
    writeFileSync(restoredPath, gunzipSync(await sink.get(key!)));
    const restored = new SqliteHubStore(restoredPath);
    expect(restored.getProject(project.id)?.name).toBe('keepme');
    expect(restored.getRun(run.id)?.state).toBe('streaming'); // captured mid-flight

    // — boot reconciliation on the restored store heals to a legal state —
    const port = new FakeSubstrateExecPort();
    const orch = new Orchestrator({
      store: restored,
      adapter: new FakeRuntimeAdapter(port),
      execPort: port,
      agents: new Map([[DEV.id, DEV]]),
    });
    port.enqueueFixture({ streamLines: ['HUB_SWEEP|||'] }); // unknown-branch sweep
    await orch.reconcile();
    await orch.idle();
    const healed = restored.getRun(run.id)!;
    expect(['failed', 'cancelled', 'completed']).toContain(healed.state); // legal terminal

    // — and a fresh turn runs against the restored, reconciled store —
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    const { run: nextRun } = orch.send(conv.id, 'after restore');
    await orch.idle();
    expect(restored.getRun(nextRun.id)!.state).toBe('completed');

    restored.close();
  });
});
