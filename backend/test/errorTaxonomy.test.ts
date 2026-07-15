/**
 * B3-06: error-taxonomy surfacing + timeouts + lagging budget (08 §6,
 * FR-17/25, ADR-003, R-06). Offline via the fake runtime; the timeout and
 * budget kills reuse the B3-01 kill machinery, so the terminal state is
 * `failed` with the right code, not `cancelled`.
 */

import { describe, expect, it } from 'vitest';
import { estimateCostUsd, resolveTokenPrices } from '../src/config/budget.js';
import type { Agent } from '../src/domain/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { FakeSubstrateExecPort, type FakeExecPortOptions } from '../src/substrate/fake.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

const AGENT: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'dev',
  allowedTools: ['Read', 'Bash'],
  sessionTemplateId: 'tpl',
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 2, timeoutMs: 60_000 },
};

/** Blocks only the FIRST gate() call; all later calls (incl. the sweep exec) flow. */
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

async function harness(portOpts: FakeExecPortOptions = {}, agent = AGENT) {
  const store = new MemoryHubStore();
  const port = new FakeSubstrateExecPort(portOpts);
  const orch = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    agents: new Map([[agent.id, agent]]),
    timeoutGraceMs: 0, // Hub backstop = caps.timeoutMs exactly, for fast tests
  });
  const project = orch.createProject({ name: 'p', defaultAgentId: 'dev' });
  await orch.idle();
  const conversation = orch.createConversation({ projectId: project.id });
  return { store, port, orch, conversation };
}

const SWEEP_CLEAN = 'HUB_SWEEP|||';

describe('budget config', () => {
  it('estimates cost from tokens at the configured rates', () => {
    const prices = resolveTokenPrices({});
    const cost = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      prices,
    );
    expect(cost).toBeCloseTo(prices.inputPerMTok, 6);
  });

  it('env overrides a price; a bad value falls back to default', () => {
    expect(resolveTokenPrices({ BUDGET_USD_PER_MTOK_OUTPUT: '99' }).outputPerMTok).toBe(99);
    expect(resolveTokenPrices({ BUDGET_USD_PER_MTOK_OUTPUT: 'nope' }).outputPerMTok).toBe(15);
  });
});

describe('lagging budget (ADR-003, R-06, budget_exceeded)', () => {
  it('trips when the streamed-usage estimate crosses the cap → failed/budget_exceeded', async () => {
    // a tiny budget below the baseline turn's ~$0.0096 estimate (dominated by
    // its ~31.6k cache-read tokens) — the usage item trips it. 0 is rejected
    // by the caps validation (FR-17 hard limits), so use the smallest positive.
    const tiny = { ...AGENT, defaultCaps: { ...AGENT.defaultCaps, budgetUsd: 0.001 } };
    const { store, port, orch, conversation } = await harness({}, tiny);
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    port.enqueueFixture({ streamLines: [SWEEP_CLEAN] }); // the post-kill sweep
    const { run } = orch.send(conversation.id, 'spendy');
    await orch.idle();
    const final = store.getRun(run.id)!;
    expect(final.state).toBe('failed');
    expect(final.errorCode).toBe('budget_exceeded');
  });

  it('does not trip when usage stays under the cap → normal completion', async () => {
    const { store, port, orch, conversation } = await harness(); // budget $2, trivial turn
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    const { run } = orch.send(conversation.id, 'cheap');
    await orch.idle();
    expect(store.getRun(run.id)!.state).toBe('completed');
    expect(store.getRun(run.id)!.errorCode).toBeNull();
  });
});

describe('wall-clock timeout (FR-17/25, run_timeout)', () => {
  it('the Hub backstop kills a hung stream → failed/run_timeout', async () => {
    // gate the stream so it never terminates on its own; timeoutMs is tiny
    const paced = pacedGate();
    const fast = { ...AGENT, defaultCaps: { ...AGENT.defaultCaps, timeoutMs: 20 } };
    const { store, port, orch, conversation } = await harness({ gate: paced.gate }, fast);
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    port.enqueueFixture({ streamLines: [SWEEP_CLEAN] }); // post-kill sweep
    const { run } = orch.send(conversation.id, 'hang');
    await until(() => store.getRun(run.id)!.state === 'streaming' && paced.armed());
    // timeout (20 ms + 0 grace) fires, kills the exec; release the gate so the
    // (now-killed) stream drains and resolves
    await new Promise((r) => setTimeout(r, 40));
    paced.release();
    await orch.idle();
    const final = store.getRun(run.id)!;
    expect(final.state).toBe('failed');
    expect(final.errorCode).toBe('run_timeout');
  });

  it("classifies a seam exit reason 'timeout' as run_timeout", async () => {
    const { store, port, orch, conversation } = await harness();
    // a fixture that ends with the seam attributing a timeout exit
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline), exitReason: 'timeout' });
    port.enqueueFixture({ streamLines: [SWEEP_CLEAN] });
    const { run } = orch.send(conversation.id, 'slow');
    await orch.idle();
    const final = store.getRun(run.id)!;
    expect(final.state).toBe('failed');
    expect(final.errorCode).toBe('run_timeout');
  });
});

describe('seam error classification (08 §6)', () => {
  it('a seam 429/409 on exec → exec_refused (retryable context)', async () => {
    const { store, orch, conversation } = await harness();
    // adapter/port throws a status-bearing error before the stream starts
    const orchAny = orch as unknown as { adapter: { runTurn: () => AsyncIterable<never> } };
    orchAny.adapter.runTurn = async function* (): AsyncIterable<never> {
      await Promise.resolve();
      throw Object.assign(new Error('too-many-concurrent-execs'), { status: 429 });
    };
    const { run } = orch.send(conversation.id, 'refused');
    await orch.idle();
    const final = store.getRun(run.id)!;
    expect(final.state).toBe('failed');
    expect(final.errorCode).toBe('exec_refused');
    // FR-33: the detail carries the seam status + session-state context so a
    // client can retry provisioning without a second API call
    expect(final.errorDetail).toContain('429');
    expect(final.errorDetail).toContain('FR-33');
  });

  it('an unreachable seam (no status) → seam_unavailable', async () => {
    const { store, orch, conversation } = await harness();
    const orchAny = orch as unknown as { adapter: { runTurn: () => AsyncIterable<never> } };
    orchAny.adapter.runTurn = async function* (): AsyncIterable<never> {
      await Promise.resolve();
      throw new Error('ECONNREFUSED');
    };
    const { run } = orch.send(conversation.id, 'down');
    await orch.idle();
    const final = store.getRun(run.id)!;
    expect(final.state).toBe('failed');
    expect(final.errorCode).toBe('seam_unavailable');
  });
});
