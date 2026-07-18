/**
 * Automatic-mode routing end-to-end (N4a, ADR-008) on the fake substrate —
 * offline, deterministic. The router proposes a specialist (deterministic in
 * N4a: the conversation's own), the selector chooses the session, and the
 * ExecutionTargetDecision is recorded on the run. Direct mode records nothing.
 * Runs against both HubStore implementations — the run is the audit surface.
 */

import { describe, expect, it } from 'vitest';
import type { Agent, Project } from '../src/domain/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { SqliteHubStore } from '../src/store/sqlite.js';
import type { HubStore } from '../src/store/types.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

const DEV: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'You are the dev agent.',
  allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
  // capabilities the deterministic router carries onto the proposal (N3a)
  capabilities: ['implement'],
};

const OWNED_SESSION = {
  sessionId: 's_seed',
  name: 'Claudio',
  status: 'running',
  ownerUsername: 'owner-admin',
  createdAt: null,
  lastConnectedAt: null,
  externalRef: null,
};

function makeHarness(store: HubStore) {
  const port = new FakeSubstrateExecPort();
  const orch = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    agents: new Map([[DEV.id, DEV]]),
  });
  const readyProject = async (): Promise<Project> => {
    const p = orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    await orch.idle();
    return store.getProject(p.id)!;
  };
  return { store, port, orch, readyProject };
}

function suite(name: string, makeStore: () => HubStore): void {
  describe(`automatic routing — ${name}`, () => {
    it('a project automatic turn runs in the project primary session and records the decision', async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      const conv = orch.createConversation({ projectId: project.id, mode: 'automatic' });
      expect(conv.mode).toBe('automatic');

      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      const { run } = orch.send(conv.id, 'add a feature');
      await orch.idle();

      const final = store.getRun(run.id)!;
      expect(final.state).toBe('completed');
      // executed in the project's primary session, which has the repo/creds
      expect(port.execRequests.at(-1)!.sessionId).toBe('fakesess_1');
      expect(final.targetSessionId).toBe('fakesess_1');
      expect(final.targetDecision).toEqual({
        specialistId: 'dev',
        selectedSessionId: 'fakesess_1',
        reason: expect.stringContaining('project'),
        alternativesConsidered: [], // dev has no specialist session bound here
        workspaceStrategy: 'project-primary',
      });
      store.close();
    });

    it("lists the routed specialist's own session as a considered alternative", async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      port.seedSession({ ...OWNED_SESSION, sessionId: 's_claudio' });
      await orch.bindSpecialistSession('dev', { sessionId: 's_claudio' });
      const project = await readyProject();
      const conv = orch.createConversation({ projectId: project.id, mode: 'automatic' });

      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      const { run } = orch.send(conv.id, 'fix a bug');
      await orch.idle();

      const decision = store.getRun(run.id)!.targetDecision!;
      // still the primary — a specialist session is never chosen just because
      // the worker is a specialist (ADR-008) — but it is recorded as considered
      expect(decision.selectedSessionId).toBe('fakesess_1');
      expect(decision.workspaceStrategy).toBe('project-primary');
      expect(decision.alternativesConsidered).toContain('specialist session s_claudio');
      store.close();
    });

    it('a project-less automatic turn runs in the specialist session', async () => {
      const { store, port, orch } = makeHarness(makeStore());
      port.seedSession({ ...OWNED_SESSION, sessionId: 's_claudio' });
      await orch.bindSpecialistSession('dev', { sessionId: 's_claudio' });
      // a project-less automatic conversation (no createSpecialistConversation
      // helper for automatic yet — that arrives with the UI in N4b)
      const conv = store.createConversation({
        projectId: null,
        title: 'general',
        agentId: 'dev',
        mode: 'automatic',
      });

      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      const { run } = orch.send(conv.id, 'a general question');
      await orch.idle();

      const final = store.getRun(run.id)!;
      expect(final.state).toBe('completed');
      expect(port.execRequests.at(-1)!.sessionId).toBe('s_claudio');
      expect(final.targetSessionId).toBe('s_claudio');
      expect(final.targetDecision).toMatchObject({
        specialistId: 'dev',
        selectedSessionId: 's_claudio',
        workspaceStrategy: 'specialist-session',
      });
      store.close();
    });

    it('a direct turn records no execution-target decision (control)', async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      const conv = orch.createConversation({ projectId: project.id }); // default: direct
      expect(conv.mode).toBe('direct');

      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      const { run } = orch.send(conv.id, 'hi');
      await orch.idle();

      const final = store.getRun(run.id)!;
      expect(final.state).toBe('completed');
      expect(final.targetSessionId).toBeNull();
      expect(final.targetDecision).toBeNull();
      store.close();
    });
  });
}

suite('memory', () => new MemoryHubStore());
suite('sqlite', () => new SqliteHubStore(':memory:'));
