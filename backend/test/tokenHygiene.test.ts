/**
 * B2-05 token hygiene (SEC-04/07, 13 §5): the OAuth token injected via
 * `runEnv` must reach EXACTLY one place — each run's exec env — and leak
 * nowhere else. The store side is asserted at the strongest level
 * available: the raw bytes of the SQLite file after full turns.
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/domain/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { SqliteHubStore } from '../src/store/sqlite.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

const TOKEN = 'sk-hygiene-canary-3f9a1b7c-not-a-real-token';

const AGENT: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'You are the dev agent.',
  allowedTools: ['Read', 'Bash'],
  sessionTemplateId: 'tpl_default',
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
};

describe('OAuth token hygiene (13 §5)', () => {
  it('token reaches the exec env and HUB_RUN_ID marker rides along; neither leaks into the store file', async () => {
    const dbPath = join(tmpdir(), `hub-hygiene-${process.pid}-${Date.now()}.sqlite`);
    const store = new SqliteHubStore(dbPath);
    const port = new FakeSubstrateExecPort();
    const orch = new Orchestrator({
      store,
      adapter: new FakeRuntimeAdapter(port),
      execPort: port,
      agents: new Map([[AGENT.id, AGENT]]),
      runEnv: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    });

    const project = orch.createProject({ name: 'p', defaultAgentId: 'dev' });
    await orch.idle();
    const conversation = orch.createConversation({ projectId: project.id });

    // two full turns (baseline + resume) so messages, events, usage and
    // summaries all land in the store before the leak scan
    for (const phase of [FIXTURES.baseline, FIXTURES.resume1]) {
      port.enqueueFixture({ streamLines: fixtureStreamLines(phase) });
      orch.send(conversation.id, 'hello there');
      await orch.idle();
    }

    // 1) the ONLY sanctioned destination: each exec request's env
    expect(port.execRequests.length).toBeGreaterThanOrEqual(2);
    for (const { req } of port.execRequests) {
      expect(req.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
      expect(req.env?.HUB_RUN_ID).toMatch(/^run_/); // ADR-003 marker
    }

    // 2) terminal states really landed (the scan below is meaningful)
    const runIds = store
      .listMessages(conversation.id)
      .map((m) => m.runId)
      .filter(Boolean);
    expect(runIds.length).toBeGreaterThanOrEqual(2);

    // 3) strongest store-side assertion available: raw file bytes
    store.close();
    const raw = readFileSync(dbPath);
    expect(raw.includes(Buffer.from(TOKEN))).toBe(false);
  });
});
