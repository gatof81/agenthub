/**
 * B3-07 observability floor (14 §1/§2, OPS-04): structured JSON logs with a
 * propagated correlation id, the no-payload-logging guarantee (SEC-04/05,
 * 13 §5 / BX-02), and process-local metrics.
 */

import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/domain/types.js';
import { JsonLogger, withCorrelation } from '../src/observability/logger.js';
import { CountingMetrics } from '../src/observability/metrics.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

const AGENT: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'dev',
  allowedTools: ['Read', 'Bash'],
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 2, timeoutMs: 60_000 },
};

function captureLogger() {
  const lines: string[] = [];
  const logger = new JsonLogger({
    write: (l) => lines.push(l),
    now: () => new Date('2026-07-15T00:00:00Z'),
  });
  return { logger, records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('JsonLogger', () => {
  it('emits one JSON line per event with ts/level/event', () => {
    const { logger, records } = captureLogger();
    logger.info('http.request', { status: 200 });
    logger.error('run.terminal', { runId: 'run_1', state: 'failed' });
    const recs = records();
    expect(recs[0]).toMatchObject({ ts: '2026-07-15T00:00:00.000Z', level: 'info', event: 'http.request', status: 200 });
    expect(recs[1]).toMatchObject({ level: 'error', event: 'run.terminal', runId: 'run_1' });
  });

  it('attaches the ambient correlation id and clears it outside the scope', () => {
    const { logger, records } = captureLogger();
    withCorrelation('cid-abc', () => logger.info('inside'));
    logger.info('outside');
    const recs = records();
    expect(recs[0]!['cid']).toBe('cid-abc');
    expect(recs[1]!['cid']).toBeUndefined();
  });

  it('caller fields cannot overwrite the reserved ts/level/event/cid', () => {
    const { logger, records } = captureLogger();
    withCorrelation('real-cid', () =>
      logger.info('evt', { cid: 'spoofed', level: 'x', event: 'y', keep: 'me' } as never),
    );
    const rec = records()[0]!;
    expect(rec['cid']).toBe('real-cid');
    expect(rec['level']).toBe('info');
    expect(rec['event']).toBe('evt');
    expect(rec['keep']).toBe('me');
  });
});

describe('no-payload logging (SEC-04/05, 13 §5 / BX-02)', () => {
  it('a full run logs ids/type/counts only — never the message or event content', async () => {
    const { logger, records } = captureLogger();
    const store = new MemoryHubStore();
    const port = new FakeSubstrateExecPort();
    const secret = 'PROMPT-CANARY-should-never-be-logged';
    const orch = new Orchestrator({
      store,
      adapter: new FakeRuntimeAdapter(port),
      execPort: port,
      agents: new Map([[AGENT.id, AGENT]]),
      logger,
    });
    const project = orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    await orch.idle();
    const conversation = orch.createConversation({ projectId: project.id });
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    orch.send(conversation.id, secret);
    await orch.idle();

    const blob = records()
      .map((r) => JSON.stringify(r))
      .join('\n');
    expect(blob).not.toContain(secret); // the user message never reaches a log
    // the terminal log carried the type + ids, though
    const terminal = records().find((r) => r['event'] === 'run.terminal');
    expect(terminal).toBeDefined();
    expect(terminal!['state']).toBe('completed');
    expect(typeof terminal!['runId']).toBe('string');
  });
});

describe('CountingMetrics', () => {
  it('counts run-state transitions and seam errors; gauges read live', () => {
    let active = 3;
    const metrics = new CountingMetrics({
      activeRuns: () => active,
      queuedRuns: () => 2,
      dbPath: null,
    });
    metrics.runTransition('completed');
    metrics.runTransition('completed');
    metrics.runTransition('failed');
    metrics.seamError();
    active = 1;
    const snap = metrics.snapshot();
    expect(snap.runTransitions).toEqual({ completed: 2, failed: 1 });
    expect(snap.seamErrors).toBe(1);
    expect(snap.activeRuns).toBe(1); // gauge reflects the live value
    expect(snap.queuedRuns).toBe(2);
    expect(snap.dbBytes).toBeNull(); // :memory: → no file gauge
  });

  it('the orchestrator increments the transition + seam-error counters', async () => {
    const store = new MemoryHubStore();
    const port = new FakeSubstrateExecPort();
    const metrics = new CountingMetrics({
      activeRuns: () => store.listRunsByState(['starting', 'streaming']).length,
      queuedRuns: () => store.listRunsByState(['queued']).length,
      dbPath: null,
    });
    const orch = new Orchestrator({
      store,
      adapter: new FakeRuntimeAdapter(port),
      execPort: port,
      agents: new Map([[AGENT.id, AGENT]]),
      metrics,
    });
    const project = orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    await orch.idle();
    const conversation = orch.createConversation({ projectId: project.id });
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    orch.send(conversation.id, 'hi');
    await orch.idle();
    expect(metrics.snapshot().runTransitions['completed']).toBe(1);
  });
});
