/** Shared wiring for API-level tests: full app on fakes, in-memory store. */

import type { Express } from 'express';
import { buildApp } from '../src/api/app.js';
import { Broadcaster } from '../src/api/broadcaster.js';
import type { Agent } from '../src/domain/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import type { HubStore } from '../src/store/types.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';

export const TEST_TOKEN = 'test-token-agenthub';
export const AUTH = { Authorization: `Bearer ${TEST_TOKEN}` };

export const DEV_AGENT: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'dev agent',
  allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
  sessionTemplateId: 'tpl_default',
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
};

export interface ApiHarness {
  app: Express;
  store: HubStore;
  port: FakeSubstrateExecPort;
  orch: Orchestrator;
  broadcaster: Broadcaster;
}

export function makeApiHarness(gate?: () => Promise<void>): ApiHarness {
  const store = new MemoryHubStore();
  const port = new FakeSubstrateExecPort(gate ? { gate } : {});
  const broadcaster = new Broadcaster();
  const orch = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    agents: new Map([[DEV_AGENT.id, DEV_AGENT]]),
    notify: broadcaster,
  });
  const app = buildApp({
    store,
    orchestrator: orch,
    agents: new Map([[DEV_AGENT.id, DEV_AGENT]]),
    broadcaster,
    authToken: TEST_TOKEN,
    heartbeatMs: 3600_000, // effectively off in tests
  });
  return { app, store, port, orch, broadcaster };
}
