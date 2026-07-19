/**
 * Task supervision end-to-end (N5b, ADR-009) on the fake substrate — offline,
 * deterministic. A routed `task` message spawns a supervised developer → QA
 * task: the kickoff run executes no turn, and the implementation and QA run as
 * their own step runs through the REAL run loop (dispatch → exec → finalize).
 * This proves the wiring the supervisor's unit test stubs out: the envelope, the
 * StepRunner, the finalize completion signal, and work-product recording. The
 * changes-required loop itself is unit-tested in supervisor.test.ts; here the
 * fixture output carries no marker, so QA passes and the task lands in
 * `awaiting_human_approval`. Runs against both HubStore implementations.
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
  capabilities: ['implement'],
};

const QA: Agent = {
  id: 'qa',
  name: 'Reviewer',
  instructions: 'You are the QA agent.',
  allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
  capabilities: ['qa'],
};

function makeHarness(store: HubStore) {
  const port = new FakeSubstrateExecPort();
  const orch = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    agents: new Map([
      [DEV.id, DEV],
      [QA.id, QA],
    ]),
    // the developer is routed (DeterministicRouter echoes the conversation's
    // agent); QA is the configured reviewer that arms the task envelope
    qaSpecialistId: 'qa',
  });
  const readyProject = async (): Promise<Project> => {
    const p = orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    await orch.idle();
    return store.getProject(p.id)!;
  };
  return { store, port, orch, readyProject };
}

function suite(name: string, makeStore: () => HubStore): void {
  describe(`task supervision — ${name}`, () => {
    it('a routed task drives dev → QA to awaiting_human_approval, with work products', async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      const conv = orch.createConversation({ projectId: project.id, mode: 'automatic' });

      // one fixture per step run (dev, then QA); the kickoff run execs nothing
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      const { run: kickoff } = orch.send(conv.id, 'implement feature X');
      await orch.idle();

      // the kickoff run completed without touching the substrate
      const kickoffRun = store.getRun(kickoff.id)!;
      expect(kickoffRun.state).toBe('completed');
      expect(kickoffRun.taskStepId).toBeNull();

      // exactly the two step execs ran — the kickoff added none
      expect(port.execRequests).toHaveLength(2);
      expect(port.execRequests.every((r) => r.sessionId === 'fakesess_1')).toBe(true);

      // the task reached human approval, through the full state machine
      const tasks = store.listTasks({ projectId: project.id });
      expect(tasks).toHaveLength(1);
      const task = tasks[0]!;
      expect(task.state).toBe('awaiting_human_approval');
      expect(task.sourceConversationId).toBe(conv.id);

      // two steps (implementation, qa), each linked to a real run
      const steps = store.listTaskSteps(task.id);
      expect(steps.map((s) => s.kind)).toEqual(['implementation', 'qa']);

      // both work products recorded, each with run provenance
      const wps = store.listWorkProducts(task.id);
      expect(wps.map((w) => w.kind).sort()).toEqual(['implementation_report', 'qa_report']);
      expect(wps.every((w) => w.runId !== null)).toBe(true);

      // each step ran as a real run under the right specialist's snapshot, via
      // the step link, and was never re-routed (no target decision recorded)
      const devRun = store.getRun(wps.find((w) => w.kind === 'implementation_report')!.runId!)!;
      const qaRun = store.getRun(wps.find((w) => w.kind === 'qa_report')!.runId!)!;
      expect(devRun.state).toBe('completed');
      expect(qaRun.state).toBe('completed');
      expect(devRun.taskStepId).not.toBeNull();
      expect(qaRun.taskStepId).not.toBeNull();
      expect(devRun.instructionsSnapshot).toBe(DEV.instructions);
      expect(qaRun.instructionsSnapshot).toBe(QA.instructions);
      expect(devRun.targetDecision).toBeNull();
      expect(qaRun.targetDecision).toBeNull();

      store.close();
    });

    it('with no QA specialist configured, a task message just runs a normal turn (control)', async () => {
      const store = makeStore();
      const port = new FakeSubstrateExecPort();
      const orch = new Orchestrator({
        store,
        adapter: new FakeRuntimeAdapter(port),
        execPort: port,
        agents: new Map([[DEV.id, DEV]]),
        // qaSpecialistId omitted → the envelope never fires
      });
      const p = orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      await orch.idle();
      const conv = orch.createConversation({ projectId: p.id, mode: 'automatic' });

      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      const { run } = orch.send(conv.id, 'implement feature X');
      await orch.idle();

      // a single ordinary turn — no task spawned
      expect(store.getRun(run.id)!.state).toBe('completed');
      expect(store.getRun(run.id)!.taskStepId).toBeNull();
      expect(store.listTasks({ projectId: p.id })).toHaveLength(0);
      expect(port.execRequests).toHaveLength(1);
      store.close();
    });
  });
}

suite('memory', () => new MemoryHubStore());
suite('sqlite', () => new SqliteHubStore(':memory:'));
