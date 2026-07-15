/**
 * Boot reconciliation (UC-06, B1-04 skeleton): runs found in-flight at boot
 * stage to `interrupted`, then resolve via the status probe — exited /
 * running / unknown — and the queue re-arms.
 */

import { describe, expect, it } from 'vitest';
import type { ExecStatus } from '../src/domain/ports.js';
import type { Agent } from '../src/domain/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import type { HubStore } from '../src/store/types.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

const DEV_AGENT: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'dev',
  allowedTools: ['Read', 'Bash'],
  sessionTemplateId: 'tpl',
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
};

/** A port whose status/kill answers are scripted for the probe branches. */
class ProbeScriptedPort extends FakeSubstrateExecPort {
  statusAnswer: ExecStatus = { state: 'unknown' };
  override status(): Promise<ExecStatus> {
    return Promise.resolve(this.statusAnswer);
  }
}

interface Seeded {
  store: HubStore;
  port: ProbeScriptedPort;
  orch: Orchestrator;
  runId: string;
  projectId: string;
  conversationId: string;
}

/** Seeds a store that "crashed" with one run mid-stream (state=streaming). */
function seedInterrupted(withEvents: boolean): Seeded {
  const store = new MemoryHubStore();
  const port = new ProbeScriptedPort();
  const orch = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    agents: new Map([[DEV_AGENT.id, DEV_AGENT]]),
  });
  const project = store.createProject({ name: 'p', defaultAgentId: 'dev' });
  store.setProjectSession(project.id, { sessionId: 'sess_1', templateId: 'tpl' });
  store.updateProject(project.id, { status: 'ready' });
  const conv = store.createConversation({ projectId: project.id, title: 't', agentId: 'dev' });
  const { run } = store.sendMessage({
    conversationId: conv.id,
    content: 'crashy work',
    caps: DEV_AGENT.defaultCaps,
    policy: DEV_AGENT.allowedTools,
  });
  store.dispatchNextRun(project.id);
  store.transitionRun(run.id, 'starting', 'streaming', { execId: 'exec_zomb', pgid: 1 });
  if (withEvents) {
    store.ingestEvents(run.id, [
      { id: 'ev_1', seq: 1, type: 'output', payload: { blockType: 'text', text: 'partial answer' }, ts: '2026-07-15T00:00:00Z' },
      { id: 'ev_2', seq: 2, type: 'exit', payload: { exitCode: 0, reason: null }, ts: '2026-07-15T00:00:01Z' },
    ]);
  }
  return { store, port, orch, runId: run.id, projectId: project.id, conversationId: conv.id };
}

describe('boot reconciliation (UC-06)', () => {
  it('exited + exit 0 → completed, answer assembled from stored events', async () => {
    const s = seedInterrupted(true);
    s.port.statusAnswer = { state: 'exited', exitCode: 0 };
    await s.orch.reconcile();
    await s.orch.idle();
    const run = s.store.getRun(s.runId)!;
    expect(run.state).toBe('completed');
    expect(s.store.getSummary(s.runId)).toBeDefined();
    const msgs = s.store.listMessages(s.conversationId);
    expect(msgs.at(-1)).toMatchObject({ role: 'assistant', content: 'partial answer' });
  });

  it('exited non-zero → failed with runtime_error', async () => {
    const s = seedInterrupted(false);
    s.port.statusAnswer = { state: 'exited', exitCode: 1 };
    await s.orch.reconcile();
    const run = s.store.getRun(s.runId)!;
    expect(run.state).toBe('failed');
    expect(run.errorCode).toBe('runtime_error');
    expect(s.store.getUsage(s.runId)!.source).toBe('error-partial');
  });

  it('still running → killed (no re-attach in v1) → cancelled with outcome', async () => {
    const s = seedInterrupted(false);
    s.port.statusAnswer = { state: 'running' };
    await s.orch.reconcile();
    const run = s.store.getRun(s.runId)!;
    expect(run.state).toBe('cancelled');
    expect(run.killOutcome).toBe('already-exited'); // scripted port has no live exec
    expect(s.store.getUsage(s.runId)!.source).toBe('cancelled-unknown');
  });

  it('unknown → failed, orphan possibility noted (contract: unknown ≠ never-happened)', async () => {
    const s = seedInterrupted(false);
    s.port.statusAnswer = { state: 'unknown' };
    await s.orch.reconcile();
    const run = s.store.getRun(s.runId)!;
    expect(run.state).toBe('failed');
    expect(run.errorCode).toBe('internal');
    expect(run.errorDetail).toContain('orphan');
  });

  it('a run stuck in interrupted (crash between the two reconcile txs) resolves on the next boot', async () => {
    const s = seedInterrupted(false);
    s.store.transitionRun(s.runId, 'streaming', 'interrupted'); // tx-1 happened, then crash
    s.port.statusAnswer = { state: 'unknown' };
    await s.orch.reconcile(); // next boot picks it up directly at step 2
    expect(s.store.getRun(s.runId)!.state).toBe('failed');
  });

  it('queue rebuild: queued runs dispatch after reconcile (FR-04)', async () => {
    const s = seedInterrupted(false);
    s.port.statusAnswer = { state: 'unknown' };
    // a second, queued run waiting behind the interrupted one
    const conv2 = s.store.createConversation({ projectId: s.projectId, title: 'b', agentId: 'dev' });
    const { run: queued } = s.store.sendMessage({
      conversationId: conv2.id,
      content: 'queued work',
      caps: DEV_AGENT.defaultCaps,
      policy: DEV_AGENT.allowedTools,
    });
    s.port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    await s.orch.reconcile();
    await s.orch.idle();
    expect(s.store.getRun(queued.id)!.state).toBe('completed');
  });
});
