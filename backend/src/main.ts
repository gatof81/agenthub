/* eslint-disable no-console -- the composition root logs startup facts; SEC-05 payload rules apply to run data, which is never logged here */
/**
 * Composition root: the only file allowed to see every module — it wires
 * implementations into the domain ports (06 §4) and starts the server.
 * Increment 1 runs the FAKE substrate + runtime (A1): fully offline, fixture
 * cycling, no credentials.
 */

import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './api/app.js';
import { Broadcaster } from './api/broadcaster.js';
import { loadAgents } from './config/agents.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from './runtime/fakeAdapter.js';
import { SqliteHubStore } from './store/sqlite.js';
import { FakeSubstrateExecPort, type ExecFixture } from './substrate/fake.js';

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
  const fixturesDir = env(
    'HUB_FAKE_FIXTURES_DIR',
    '../docs/spikes/S-01/fixtures/run-20260714T142930Z',
  );

  const agents = loadAgents(agentsPath);
  const store = new SqliteHubStore(dbPath);
  const broadcaster = new Broadcaster();
  const execPort = new FakeSubstrateExecPort({ fixtureProvider: fixtureCycler(fixturesDir) });
  const orchestrator = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(execPort),
    execPort,
    agents,
    notify: broadcaster,
  });

  // boot reconciliation runs before the API accepts writes (07 §3, UC-06)
  await orchestrator.reconcile();

  const app = buildApp({ store, orchestrator, agents, broadcaster, authToken });
  app.listen(port, () => {
    console.log(`agenthub backend listening on :${port} (runtime: fake, Increment 1)`);
  });
}

main().catch((err: unknown) => {
  console.error('fatal during startup:', err);
  process.exit(1);
});
