/**
 * RunLoop unit tests (ADR-013) — the last extraction's testability win: the
 * dispatch → execute → terminal engine runs against the FAKE adapter alone
 * (memory store, fake exec port, stubbed resolveTarget/sessionMeta callbacks)
 * with no Orchestrator, no router, no provisioning, and no task machinery
 * constructed at all. The invariant-dense behavior itself is unchanged
 * (structure-only extraction) and stays covered through the facade by the
 * orchestrator.integration / cancellation / errorTaxonomy / reconciler suites.
 */

import { describe, expect, it } from 'vitest';
import type { Conversation, Run } from '../src/domain/types.js';
import { RunLoop } from '../src/orchestrator/runLoop.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { DEV_AGENT } from './apiHarness.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

function makeLoop(resolveTo: string | null = 's1') {
  const store = new MemoryHubStore();
  const port = new FakeSubstrateExecPort();
  const woken: string[] = [];
  const loop = new RunLoop({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    // the facade wiring, stubbed: a fixed session (or null = "finalized elsewhere")
    resolveTarget: () => Promise.resolve(resolveTo),
    sessionMeta: () => ({ sessionId: resolveTo, lastKnownState: 'ready' }),
    onRunTerminal: (runId) => woken.push(runId),
  });
  return { store, port, loop, woken };
}

function seedQueuedRun(store: MemoryHubStore): { conversation: Conversation; run: Run } {
  const project = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
  const conversation = store.createConversation({
    projectId: project.id,
    title: 't',
    agentId: 'dev',
    mode: 'direct',
  });
  const { run } = store.sendMessage({
    conversationId: conversation.id,
    content: 'do it',
    caps: DEV_AGENT.defaultCaps,
    policy: DEV_AGENT.allowedTools,
    instructions: DEV_AGENT.instructions,
  });
  return { conversation, run };
}

async function settle(loop: RunLoop): Promise<void> {
  while (loop.pending().length > 0) await Promise.all(loop.pending());
}

describe('RunLoop (ADR-013, fake adapter alone)', () => {
  it('pump → execute → completed: the full engine against narrow fakes', async () => {
    const { store, port, loop, woken } = makeLoop();
    const { conversation, run } = seedQueuedRun(store);
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });

    loop.pump(conversation.projectId!);
    await settle(loop);

    const final = store.getRun(run.id)!;
    expect(final.state).toBe('completed');
    expect(store.getSummary(run.id)).not.toBeNull();
    // every sealed run wakes the injected task-step hook (N5b seam)
    expect(woken).toEqual([run.id]);
  });

  it('a null resolveTarget (fail/kickoff/steer already sealed elsewhere) executes no turn', async () => {
    const { store, port, loop } = makeLoop(null);
    const { conversation } = seedQueuedRun(store);
    loop.pump(conversation.projectId!);
    await settle(loop);
    expect(port.execRequests).toHaveLength(0);
  });

  it('cancelRun on a queued run seals it cancelled and keeps the queue moving (FR-04)', async () => {
    const { store, loop } = makeLoop();
    const { run } = seedQueuedRun(store);
    await loop.cancelRun(run.id);
    expect(store.getRun(run.id)!.state).toBe('cancelled');
  });

  it('reconcileRuns heals an interrupted-with-unknown-exec run to failed (UC-06)', async () => {
    const { store, loop } = makeLoop();
    const { run } = seedQueuedRun(store);
    store.dispatchNextRun(store.getConversation(store.getRun(run.id)!.conversationId)!.projectId!);
    await loop.reconcileRuns();
    const final = store.getRun(run.id)!;
    expect(final.state).toBe('failed');
    expect(final.errorCode).toBe('internal');
  });
});
