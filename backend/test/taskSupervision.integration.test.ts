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
import type { WorkspaceManagerPort } from '../src/domain/ports.js';
import type { Agent, Project, Task, TaskWorkspace } from '../src/domain/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { SqliteHubStore } from '../src/store/sqlite.js';
import type { HubStore } from '../src/store/types.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { taskWorktreePath } from '../src/orchestrator/workspaceManager.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

const DEV: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'You are the dev agent.',
  allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
  capabilities: ['implementation'],
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

/** A design-only role (#124): declared capabilities WITHOUT `implementation`. */
const ARCH: Agent = {
  id: 'arch',
  name: 'Architect',
  instructions: 'You are the architect. You design; you never write product code.',
  allowedTools: ['Read', 'Grep', 'Glob'],
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
  capabilities: ['architecture', 'design'],
};

/** Records cleanup calls so the reconcile worktree-cleanup path can be asserted. */
class RecordingWorkspaceManager implements WorkspaceManagerPort {
  cleanupCalls: TaskWorkspace[] = [];
  createTaskWorkspace(task: Task): Promise<TaskWorkspace> {
    return Promise.resolve({ strategy: 'worktree', branch: `hub/task/${task.id}`, path: `/w/${task.id}` });
  }
  commitWork(): Promise<void> {
    return Promise.resolve();
  }
  cleanup(_task: Task, workspace: TaskWorkspace): Promise<void> {
    this.cleanupCalls.push(workspace);
    return Promise.resolve();
  }
  openPullRequest(): Promise<{ url: string | null }> {
    return Promise.resolve({ url: null });
  }
}

function makeHarness(store: HubStore, workspaceManager?: WorkspaceManagerPort) {
  const port = new FakeSubstrateExecPort();
  const orch = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    agents: new Map([
      [DEV.id, DEV],
      [QA.id, QA],
      [ARCH.id, ARCH],
    ]),
    // the developer is routed (DeterministicRouter echoes the conversation's
    // agent); QA is the configured reviewer that arms the task envelope
    qaSpecialistId: 'qa',
    ...(workspaceManager ? { workspaceManager } : {}),
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

      // both step turns ran inside the task's git worktree (ADR-010 B) — the
      // exec carried its absolute path as workingDir, isolated from the session root
      const worktree = taskWorktreePath(task.id);
      expect(port.execRequests.every((r) => r.req.workingDir === worktree)).toBe(true);

      // two steps (implementation, qa), each linked to a real run + an audited grant
      const steps = store.listTaskSteps(task.id);
      expect(steps.map((s) => s.kind)).toEqual(['implementation', 'qa']);
      expect(steps[0]!.workspaceAccess).toMatchObject({ accessMode: 'worktree-write', path: worktree });
      expect(steps[1]!.workspaceAccess).toMatchObject({ accessMode: 'test-execution', path: worktree });

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

    it('step runs keep their OWN continuation chains and never touch the conversation handle (#123)', async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      const conv = orch.createConversation({ projectId: project.id, mode: 'automatic' });

      // Distinct CLI session ids per exec, so the resume chains are observable.
      // The first QA cycle demands changes (the extractor's marker), forcing a
      // second dev + QA cycle: dev attempt 2 must resume dev attempt 1's CLI
      // session, QA cycle 2 must resume QA cycle 1's — and neither role ever
      // resumes the other's, nor lands on the conversation.
      const stepLines = (cliSession: string, text: string): string[] => [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: cliSession, model: 'claude-sonnet-5', claude_code_version: '2.1.212' }),
        // an Edit step, so dev attempts show file progress (the #124 no-progress
        // guard would otherwise cut the changes-required cycle this test drives)
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' }, id: 'tu_1' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
        JSON.stringify({ type: 'result', subtype: 'success', session_id: cliSession, result: text, total_cost_usd: 0.01, num_turns: 1 }),
      ];
      port.enqueueFixture({ streamLines: stepLines('cli-dev-1', 'implemented the change') });
      port.enqueueFixture({ streamLines: stepLines('cli-qa-1', 'CHANGES_REQUIRED: missing test') });
      port.enqueueFixture({ streamLines: stepLines('cli-dev-2', 'added the test') });
      port.enqueueFixture({ streamLines: stepLines('cli-qa-2', 'all good') });

      orch.send(conv.id, 'implement feature X');
      await orch.idle();

      const task = store.listTasks({ projectId: project.id })[0]!;
      expect(task.state).toBe('awaiting_human_approval');

      // each step recorded ITS run's CLI session on its own row (migration 011)
      const steps = store.listTaskSteps(task.id);
      expect(steps.map((s) => [s.kind, s.runtimeSessionId])).toEqual([
        ['implementation', 'cli-dev-1'],
        ['qa', 'cli-qa-1'],
        ['implementation', 'cli-dev-2'],
        ['qa', 'cli-qa-2'],
      ]);

      // the execs resumed per-chain: first of each chain fresh, second resumes
      // the first — QA never inherits the implementer's CLI context
      const resumeOf = (i: number): string | null => {
        const argv = port.execRequests[i]!.req.argv;
        const at = argv.indexOf('--resume');
        return at === -1 ? null : argv[at + 1]!;
      };
      expect(port.execRequests).toHaveLength(4);
      expect(resumeOf(0)).toBeNull(); // dev attempt 1: fresh
      expect(resumeOf(1)).toBeNull(); // QA cycle 1: fresh — NOT cli-dev-1
      expect(resumeOf(2)).toBe('cli-dev-1'); // dev attempt 2 continues dev
      expect(resumeOf(3)).toBe('cli-qa-1'); // QA cycle 2 continues QA

      // the conversation's continuation handle stayed untouched — the worktree
      // CLI sessions must not leak into post-task turns (the #123 poisoning)
      expect(store.getConversation(conv.id)!.runtimeSessionId).toBeNull();
      store.close();
    });

    it('a work-shaped message during an active task steers it — never a sibling (I-14, ADR-014)', async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      const conv = orch.createConversation({ projectId: project.id, mode: 'automatic' });

      // an active (mid-flight) task on the conversation, seeded directly — the
      // gate reads the store, not the supervisor's in-memory loop
      const active = store.createTask({
        projectId: project.id,
        sourceConversationId: conv.id,
        sourceMessageId: 'msg_kickoff',
      });
      store.transitionTask(active.id, 'planning', 'implementing');

      const { run } = orch.send(conv.id, 'also update the docs');
      await orch.idle();

      // no sibling task, no substrate turn — the message queued as steering
      expect(store.listTasks({ projectId: project.id })).toHaveLength(1);
      expect(port.execRequests).toHaveLength(0);
      expect(store.getTask(active.id)!.pendingFeedback).toEqual(['also update the docs']);
      expect(store.getRun(run.id)!.state).toBe('completed');
      const reply = store.listMessages(conv.id).at(-1)!;
      expect(reply.role).toBe('assistant');
      expect(reply.content).toContain('folded into its next developer step');
      store.close();
    });

    it('steering a task awaiting approval re-enters the loop through changes_requested_by_user (ADR-014)', async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      const conv = orch.createConversation({ projectId: project.id, mode: 'automatic' });

      // round 1: a full dev → QA pass to awaiting_human_approval
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      orch.send(conv.id, 'implement feature X');
      await orch.idle();
      const task = store.listTasks({ projectId: project.id })[0]!;
      expect(task.state).toBe('awaiting_human_approval');

      // the owner answers in CHAT instead of using the approve/reject buttons
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      orch.send(conv.id, 'please also add tests');
      await orch.idle();

      // still ONE task — re-entered and completed another dev → QA round
      expect(store.listTasks({ projectId: project.id })).toHaveLength(1);
      expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval');
      expect(store.listTaskSteps(task.id)).toHaveLength(4);
      // the resume's developer prompt carried the chat note as the change request
      const devPrompt = store
        .listMessages(conv.id)
        .find((m) => m.role === 'user' && m.content.includes('owner requested changes'));
      expect(devPrompt).toBeDefined();
      expect(devPrompt!.content).toContain('please also add tests');
      store.close();
    });

    it('a task routed to a non-implementing specialist reroutes the dev step to a capable one (#124)', async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      // the deterministic router echoes the conversation's specialist — pin the
      // ARCHITECT so the proposal is a design-only role, the #124 prod scenario
      const conv = orch.createConversation({ projectId: project.id, mode: 'automatic', agentId: 'arch' });

      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      orch.send(conv.id, 'implement feature X');
      await orch.idle();

      // the task spawned — but the implementation seat went to the capable
      // developer, not the architect the router proposed
      const task = store.listTasks({ projectId: project.id })[0]!;
      expect(task.state).toBe('awaiting_human_approval');
      const steps = store.listTaskSteps(task.id);
      expect(steps.map((s) => [s.kind, s.specialistId])).toEqual([
        ['implementation', 'dev'],
        ['qa', 'qa'],
      ]);
      // the step runs carried the DEVELOPER's snapshot, not the architect's
      const devRun = store.getRun(
        store.listWorkProducts(task.id).find((w) => w.kind === 'implementation_report')!.runId!,
      )!;
      expect(devRun.instructionsSnapshot).toBe(DEV.instructions);
      store.close();
    });

    it('with no implementation-capable specialist, a task message falls back to a normal turn (#124)', async () => {
      const store = makeStore();
      const port = new FakeSubstrateExecPort();
      const orch = new Orchestrator({
        store,
        adapter: new FakeRuntimeAdapter(port),
        execPort: port,
        // only design-only + QA roles: nobody can take the implementation seat
        agents: new Map([
          [ARCH.id, ARCH],
          [QA.id, QA],
        ]),
        qaSpecialistId: 'qa',
      });
      const p = orch.createProject({ name: 'p', defaultAgentId: 'arch', sessionTemplateId: 'tpl' });
      await orch.idle();
      const conv = orch.createConversation({ projectId: p.id, mode: 'automatic' });

      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      orch.send(conv.id, 'implement feature X');
      await orch.idle();

      // no task doomed to a role-mismatch loop — a single ordinary turn ran
      expect(store.listTasks({ projectId: p.id })).toHaveLength(0);
      expect(port.execRequests).toHaveLength(1);
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

    it('boot reconcile heals a crashed in-flight task to failed and cleans up its worktree, leaving awaiting_human_approval alone (ADR-009 boot reconciliation)', async () => {
      const workspace = new RecordingWorkspaceManager();
      const { store, orch, readyProject } = makeHarness(makeStore(), workspace);
      const project = await readyProject();
      // a task caught mid-flight by the crash: its supervise() loop died with the
      // process, so it would otherwise stay non-terminal forever
      const stuck = store.createTask({ projectId: project.id });
      store.transitionTask(stuck.id, 'planning', 'implementing');
      // a persisted step carries the worktree grant — reconcile recovers the
      // worktree descriptor from the steps (workspaceFromSteps) and cleans it up
      store.createTaskStep({
        taskId: stuck.id,
        kind: 'implementation',
        specialistId: 'dev',
        workspaceAccess: {
          accessMode: 'worktree-write',
          branch: `hub/task/${stuck.id}`,
          path: `/w/${stuck.id}`,
          pathBounds: [],
          expiresAt: null,
        },
      });
      // a task legitimately paused for the owner — a resting state, NOT a crash
      const paused = store.createTask({ projectId: project.id });
      store.transitionTask(paused.id, 'planning', 'implementing');
      store.transitionTask(paused.id, 'implementing', 'qa_pending');
      store.transitionTask(paused.id, 'qa_pending', 'qa_running');
      store.transitionTask(paused.id, 'qa_running', 'awaiting_human_approval');

      await orch.reconcile();

      expect(store.getTask(stuck.id)!.state).toBe('failed'); // healed, not stuck
      expect(store.getTask(paused.id)!.state).toBe('awaiting_human_approval'); // untouched
      // the crashed task's worktree was recovered from its steps and cleaned up;
      // the paused task (no steps, resting) was never touched
      expect(workspace.cleanupCalls).toHaveLength(1);
      expect(workspace.cleanupCalls[0]).toMatchObject({ path: `/w/${stuck.id}` });
      store.close();
    });
  });
}

suite('memory', () => new MemoryHubStore());
suite('sqlite', () => new SqliteHubStore(':memory:'));
