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
  const project = orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
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
    // the partial answer streamed before the cap tripped is preserved, not lost
    // with the live view (the reported "message vanishes, only the error stays")
    const assistant = store.listMessages(conversation.id, {}).filter((m) => m.role === 'assistant');
    expect(assistant.at(-1)?.content).toContain('ready');
  });

  it('does not trip when usage stays under the cap → normal completion', async () => {
    const { store, port, orch, conversation } = await harness(); // budget $2, trivial turn
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    const { run } = orch.send(conversation.id, 'cheap');
    await orch.idle();
    expect(store.getRun(run.id)!.state).toBe('completed');
    expect(store.getRun(run.id)!.errorCode).toBeNull();
  });

  it('never trips with no cap (budgetUsd null, off by default, ADR-003)', async () => {
    // the same fixture that trips a $0.001 cap runs clean with no cap — only
    // maxTurns + timeout bound it now.
    const noCap = { ...AGENT, defaultCaps: { ...AGENT.defaultCaps, budgetUsd: null } };
    const { store, port, orch, conversation } = await harness({}, noCap);
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    const { run } = orch.send(conversation.id, 'spendy but uncapped');
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
    const boom = Object.assign(new Error('too-many-concurrent-execs'), { status: 429 });
    orchAny.adapter.runTurn = (): AsyncIterable<never> => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(boom) }),
    });
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
    const boom = new Error('ECONNREFUSED');
    orchAny.adapter.runTurn = (): AsyncIterable<never> => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(boom) }),
    });
    const { run } = orch.send(conversation.id, 'down');
    await orch.idle();
    const final = store.getRun(run.id)!;
    expect(final.state).toBe('failed');
    expect(final.errorCode).toBe('seam_unavailable');
  });

  it('a mid-stream seam drop keeps the partial text (the catch path, before the post-loop assembly)', async () => {
    const { store, orch, conversation } = await harness();
    const orchAny = orch as unknown as { adapter: { runTurn: () => AsyncIterable<unknown> } };
    // the seam streams some text, then its generator throws — the container
    // fell over mid-turn after the user had already read something
    orchAny.adapter.runTurn = (): AsyncIterable<unknown> => {
      const items: unknown[] = [
        { kind: 'started', execId: 'e1', pgid: 1, requestId: 'r1' },
        { kind: 'event', type: 'output', payload: { blockType: 'text', text: 'partial before the drop' } },
      ];
      let i = 0;
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            i < items.length
              ? Promise.resolve({ value: items[i++], done: false })
              : Promise.reject(new Error('ECONNRESET')),
        }),
      };
    };
    const { run } = orch.send(conversation.id, 'review');
    await orch.idle();
    const final = store.getRun(run.id)!;
    expect(final.state).toBe('failed');
    expect(final.errorCode).toBe('seam_unavailable');
    const assistant = store.listMessages(conversation.id, {}).filter((m) => m.role === 'assistant');
    expect(assistant.at(-1)?.content).toContain('partial before the drop');
  });
});

describe('max_turns classification (ADR-003, L3)', () => {
  // The shape CLI 2.1.212 emits on --max-turns exhaustion: a real result event
  // (is_error, subtype error_max_turns, null result) after some partial work —
  // NOT a killed stream, so no sweep is involved.
  const maxTurnsStream = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'S',
      model: 'claude-sonnet-5',
      claude_code_version: '2.1.212',
    }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it…' }] } }),
    JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      result: null,
      num_turns: 2,
      session_id: 'S',
      total_cost_usd: 0.02,
      usage: {},
    }),
  ];

  it('error_max_turns → failed/max_turns, and keeps the partial text as the message', async () => {
    const { store, port, orch, conversation } = await harness();
    port.enqueueFixture({ streamLines: maxTurnsStream });
    const { run } = orch.send(conversation.id, 'do a lot in one turn');
    await orch.idle();
    const final = store.getRun(run.id)!;
    expect(final.state).toBe('failed');
    expect(final.errorCode).toBe('max_turns'); // not the generic runtime_error
    expect(final.errorDetail).toContain('turn limit');
    expect(final.errorDetail).toMatch(/cap \d+/); // a real number, never "cap undefined"
    // the work done before the limit is not thrown away
    const assistant = store.listMessages(conversation.id, {}).filter((m) => m.role === 'assistant');
    expect(assistant.at(-1)?.content).toContain('Working on it');
  });
});

describe('partial answer preservation on any non-completed end', () => {
  // A generic crash after the agent had already streamed useful text: the text
  // must be kept as the message, not discarded so only the error remains.
  const crashAfterText = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'S',
      model: 'claude-sonnet-5',
      claude_code_version: '2.1.212',
    }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Here is my partial review before it broke.' }] },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: null,
      num_turns: 1,
      session_id: 'S',
      total_cost_usd: 0.01,
      usage: {},
    }),
  ];

  it('a generic runtime error keeps the partial text (not only max_turns)', async () => {
    const { store, port, orch, conversation } = await harness();
    port.enqueueFixture({ streamLines: crashAfterText });
    const { run } = orch.send(conversation.id, 'review this');
    await orch.idle();
    const final = store.getRun(run.id)!;
    expect(final.state).toBe('failed');
    expect(final.errorCode).toBe('runtime_error');
    const assistant = store.listMessages(conversation.id, {}).filter((m) => m.role === 'assistant');
    expect(assistant.at(-1)?.content).toContain('partial review');
  });
});
