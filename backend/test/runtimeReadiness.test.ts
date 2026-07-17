/**
 * B3-08: the runtime readiness probe (`RuntimeAdapter.awaitReady`).
 *
 * The gap it closes is real and upstream: the session image's entrypoint
 * swaps `~/.npm-global` (which holds `claude`) for a workspace symlink on
 * every boot, and nothing synchronises that window with the session
 * lifecycle — so the seam can report a provisioned session whose first turn
 * dies on `claude: command not found`. See ClaudeCliRuntimeAdapter.awaitReady
 * for the pinned upstream citations. These tests pin the probe's behaviour
 * against that window, plus the orchestrator's disposition when it never
 * closes.
 */

import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/domain/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { ClaudeCliRuntimeAdapter, RuntimeNotReadyError } from '../src/runtime/claudeCliAdapter.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';

/** Probe pacing that keeps the tests in milliseconds, not minutes. */
const FAST = { readiness: { pollIntervalMs: 1, timeoutMs: 50 } };

/** `command -v claude` found it (exit 0) / did not (exit 1). */
const found = { streamLines: [], exitCode: 0 };
const notFound = { streamLines: [], exitCode: 1 };

describe('claude-cli readiness probe (B3-08)', () => {
  it('resolves as soon as claude is on PATH, probing through a non-interactive shell', async () => {
    const port = new FakeSubstrateExecPort();
    port.enqueueFixture(found);
    await new ClaudeCliRuntimeAdapter(port, FAST).awaitReady('s1');
    expect(port.execRequests).toHaveLength(1);
    // the probe must resolve `claude` the same way a turn's argv will: via
    // PATH, in a shell — not by stat'ing a path the adapter invents
    expect(port.execRequests[0]!.req.argv).toEqual(['bash', '-c', 'command -v claude']);
    expect(port.execRequests[0]!.sessionId).toBe('s1');
  });

  it('waits out the entrypoint swap window: retries while claude is absent, then resolves', async () => {
    const port = new FakeSubstrateExecPort();
    port.enqueueFixture(notFound); // mid `mv` → `ln`: the directory is gone
    port.enqueueFixture(notFound);
    port.enqueueFixture(found); // entrypoint finished the swap
    await new ClaudeCliRuntimeAdapter(port, FAST).awaitReady('s1');
    expect(port.execRequests).toHaveLength(3);
  });

  it('retries a probe that cannot even dispatch, then resolves', async () => {
    // a seam hiccup while the container is still coming up is
    // indistinguishable from "not ready" — it must not fail provisioning
    const port = new FakeSubstrateExecPort();
    let calls = 0;
    const realExec = port.exec.bind(port);
    port.exec = (sessionId, req) => {
      if (++calls === 1) {
        return {
          [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('ECONNREFUSED')) }),
        };
      }
      return realExec(sessionId, req);
    };
    port.enqueueFixture(found);
    await new ClaudeCliRuntimeAdapter(port, FAST).awaitReady('s1');
    expect(calls).toBe(2);
  });

  it('gives up at the deadline when the swap never completes → RuntimeNotReadyError', async () => {
    // the entrypoint's own permanent-failure branch (workspace .npm-global
    // gone AND the image copy already consumed): no turn would ever run, so
    // failing provisioning is the correct disposition, not a retry forever
    const port = new FakeSubstrateExecPort({ fixtureProvider: () => notFound });
    const adapter = new ClaudeCliRuntimeAdapter(port, FAST);
    await expect(adapter.awaitReady('s1')).rejects.toBeInstanceOf(RuntimeNotReadyError);
    await expect(adapter.awaitReady('s1')).rejects.toThrow(/s1.*within 50 ms.*not on PATH/s);
  });

  it('treats a probe stream with no exit event as not-ready, not as success', async () => {
    const port = new FakeSubstrateExecPort();
    port.exec = () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) });
    await expect(new ClaudeCliRuntimeAdapter(port, FAST).awaitReady('s1')).rejects.toThrow(
      /without an exit event/,
    );
  });
});

const AGENT: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'dev',
  allowedTools: ['Read'],
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 2, timeoutMs: 60_000 },
};

describe('provisioning waits for the runtime (B3-08)', () => {
  const harness = (awaitReady: () => Promise<void>) => {
    const store = new MemoryHubStore();
    const port = new FakeSubstrateExecPort();
    const adapter = new FakeRuntimeAdapter(port);
    adapter.awaitReady = awaitReady;
    const orch = new Orchestrator({
      store,
      adapter,
      execPort: port,
      agents: new Map([[AGENT.id, AGENT]]),
    });
    return { store, orch };
  };

  it('a project is ready only after the runtime says it can run', async () => {
    const seen: string[] = [];
    const { store, orch } = harness(() => {
      seen.push('probed');
      return Promise.resolve();
    });
    const project = orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    await orch.idle();
    expect(seen).toEqual(['probed']);
    expect(store.getProject(project.id)!.status).toBe('ready');
  });

  it('a runtime that never becomes ready fails the project but keeps the session id', async () => {
    const { store, orch } = harness(() => Promise.reject(new RuntimeNotReadyError('never')));
    const project = orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    await orch.idle();
    const failed = store.getProject(project.id)!;
    expect(failed.status).toBe('error');
    // the session exists upstream; losing its id here would leak the
    // container with nothing left able to stop it
    expect(failed.sessionBinding.sessionId).not.toBeNull();
  });
});
