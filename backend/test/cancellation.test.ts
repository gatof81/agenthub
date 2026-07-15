/**
 * B3-01 cancellation hardening: the kill-outcome race (found by the
 * Increment-2 live acceptance) and the FR-21 post-cancel sweep.
 */

import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/domain/types.js';
import type { HubNotifier, RunStateNotification } from '../src/domain/ports.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { FakeSubstrateExecPort, type FakeExecPortOptions } from '../src/substrate/fake.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

const AGENT: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'You are the dev agent.',
  allowedTools: ['Read', 'Bash'],
  sessionTemplateId: 'tpl_default',
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
};

class CaptureNotifier implements HubNotifier {
  readonly runStates: RunStateNotification[] = [];
  runState(_c: string, n: RunStateNotification): void {
    this.runStates.push(n);
  }
  replayable(): void {}
  usage(): void {}
  summary(): void {}
  projectState(): void {}
}

/** Gate that blocks only the FIRST stream chunk until released. */
function pacedGate(): { gate: () => Promise<void>; release: () => void; armed: () => boolean } {
  let pending: (() => void) | null = null;
  let armed = false;
  return {
    gate: () =>
      new Promise<void>((resolve) => {
        if (!armed) {
          armed = true;
          pending = resolve;
        } else {
          resolve();
        }
      }),
    release: () => pending?.(),
    armed: () => pending !== null,
  };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

async function harness(portOpts: FakeExecPortOptions = {}) {
  const store = new MemoryHubStore();
  const port = new FakeSubstrateExecPort(portOpts);
  const notify = new CaptureNotifier();
  const orch = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    agents: new Map([[AGENT.id, AGENT]]),
    notify,
  });
  const project = orch.createProject({ name: 'p', defaultAgentId: 'dev' });
  await orch.idle();
  const conversation = orch.createConversation({ projectId: project.id });
  return { store, port, orch, notify, conversation };
}

const SWEEP_CLEAN = 'HUB_SWEEP|||';

describe('kill-outcome race (B3-01)', () => {
  it('records the outcome even when the stream ends before the kill response', async () => {
    const paced = pacedGate();
    let releaseKill: () => void = () => {};
    const killResponseGate = (): Promise<void> =>
      new Promise<void>((r) => {
        releaseKill = r;
      });

    const { store, port, orch, conversation } = await harness({
      gate: paced.gate,
      killResponseGate,
    });
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    port.enqueueFixture({ streamLines: [SWEEP_CLEAN] }); // the sweep exec

    const { run } = orch.send(conversation.id, 'work');
    await until(() => store.getRun(run.id)!.state === 'streaming' && paced.armed());

    const cancelPromise = orch.cancelRun(run.id); // kill marks the exec, response held
    paced.release(); // the stream observes the kill and ENDS first
    await new Promise((r) => setTimeout(r, 20));
    releaseKill(); // now the kill response lands
    await cancelPromise;
    await orch.idle();

    const final = store.getRun(run.id)!;
    expect(final.state).toBe('cancelled');
    expect(final.killOutcome).toBe('terminated'); // lost before B3-01
  });
});

describe('post-cancel sweep (FR-21, ADR-003)', () => {
  it('sweeps via the marker, records the result in the terminal transaction', async () => {
    const paced = pacedGate();
    const { store, port, orch, notify, conversation } = await harness({ gate: paced.gate });
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.cancel) });
    port.enqueueFixture({ streamLines: ['HUB_SWEEP|101 102|102|102'] });

    const { run } = orch.send(conversation.id, 'work');
    await until(() => store.getRun(run.id)!.state === 'streaming' && paced.armed());
    const cancelPromise = orch.cancelRun(run.id);
    paced.release();
    await cancelPromise;
    await orch.idle();

    const final = store.getRun(run.id)!;
    expect(final.state).toBe('cancelled');
    expect(final.sweepResult).toEqual({
      scanned: 2,
      killed: ['101'],
      survivors: ['102'],
    });

    // the sweep exec: raw port, marker as positional arg, no env, bounded
    const sweepExec = port.execRequests.at(-1)!;
    expect(sweepExec.req.argv[0]).toBe('bash');
    expect(sweepExec.req.argv[3]).toBe('hub_sweep');
    expect(sweepExec.req.argv[4]).toBe(run.id);
    expect(sweepExec.req.env).toBeUndefined();
    expect(sweepExec.req.maxDurationMs).toBe(15_000);

    // the terminal notification carries the sweep result (one transaction)
    const terminal = notify.runStates.findLast((n) => n.runId === run.id)!;
    expect(terminal.state).toBe('cancelled');
    expect(terminal.sweepResult).toEqual(final.sweepResult);
  });

  it('degrades to a warning when the sweep exec fails — the cancel stands', async () => {
    const paced = pacedGate();
    const { store, port, orch, conversation } = await harness({ gate: paced.gate });
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.cancel) });
    // no sweep fixture → the sweep exec throws inside the port

    const { run } = orch.send(conversation.id, 'work');
    await until(() => store.getRun(run.id)!.state === 'streaming' && paced.armed());
    const cancelPromise = orch.cancelRun(run.id);
    paced.release();
    await cancelPromise;
    await orch.idle();

    const final = store.getRun(run.id)!;
    expect(final.state).toBe('cancelled');
    expect(final.sweepResult).toBeNull();
    const summary = store.getSummary(run.id)!;
    expect(summary.warnings.some((w) => w.includes('post-cancel sweep'))).toBe(true);
  });

  it('a queued cancel dispatches nothing — no turn exec, no sweep exec', async () => {
    const paced = pacedGate();
    const { store, port, orch, conversation } = await harness({ gate: paced.gate });
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });

    const first = orch.send(conversation.id, 'one');
    const second = orch.send(conversation.id, 'two'); // queued behind first (I-2)
    expect(store.getRun(second.run.id)!.state).toBe('queued');

    await orch.cancelRun(second.run.id);
    expect(store.getRun(second.run.id)!.state).toBe('cancelled');

    await until(() => paced.armed()); // first run reached its gated chunk
    paced.release();
    await orch.idle();
    expect(store.getRun(first.run.id)!.state).toBe('completed');
    // exactly one exec ever reached the port: the first turn
    expect(port.execRequests).toHaveLength(1);
  });
});
