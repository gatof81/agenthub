/**
 * TaskCoordinator unit tests (ADR-013) — the extraction's testability win made
 * concrete: the task zone is exercised against NARROW fakes (memory store, a
 * recording WorkspaceManagerPort, recording pump/finalize callbacks) with no
 * Orchestrator, no adapter, and no exec port constructed at all. Behavior
 * itself is unchanged (structure-only extraction); the end-to-end task flows
 * stay covered by taskSupervision.integration / taskApproval / supervisor
 * suites through the facade.
 */

import { describe, expect, it } from 'vitest';
import type { PullRequestContent, WorkspaceManagerPort } from '../src/domain/ports.js';
import type { Agent, Run, Task, TaskWorkspace } from '../src/domain/types.js';
import { deriveRunSummary } from '../src/domain/projections.js';
import { DeterministicReportExtractor } from '../src/orchestrator/reportExtractor.js';
import { OrchestratorError } from '../src/orchestrator/errors.js';
import { TaskCoordinator, type FinalizeRun } from '../src/orchestrator/taskCoordinator.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { DEV_AGENT } from './apiHarness.js';

/** Records worktree operations; hands out the ADR-010 B fallback descriptor. */
class RecordingWorkspaceManager implements WorkspaceManagerPort {
  calls: string[] = [];
  createTaskWorkspace(): Promise<TaskWorkspace> {
    this.calls.push('create');
    return Promise.resolve({ strategy: 'project-primary', branch: null, path: null });
  }
  commitWork(): Promise<void> {
    this.calls.push('commit');
    return Promise.resolve();
  }
  cleanup(): Promise<void> {
    this.calls.push('cleanup');
    return Promise.resolve();
  }
  openPullRequest(_t: Task, _w: TaskWorkspace, _c: PullRequestContent): Promise<{ url: string | null }> {
    this.calls.push('pr');
    return Promise.resolve({ url: 'https://example.invalid/pr/1' });
  }
}

function makeCoordinator(opts?: { qaSpecialistId?: string | null }) {
  const store = new MemoryHubStore();
  const workspace = new RecordingWorkspaceManager();
  const finalized: Array<{ run: Run; from: Run['state']; to: string; note: string }> = [];
  const pumped: string[] = [];
  const killed: string[] = [];
  const finalize: FinalizeRun = (run, from, to, o) => {
    finalized.push({ run, from, to, note: o.assistantContent });
    // seal like the real choke point so state assertions see the terminal row
    store.finalizeRun({
      runId: run.id,
      from,
      to,
      assistantContent: o.assistantContent,
      usage: { totalCostUsd: null, numTurns: null, usage: null, source: o.usageSource },
      summary: deriveRunSummary({
        run: store.getRun(run.id)!,
        outcome: to,
        events: [],
        usage: { totalCostUsd: null, numTurns: null },
        userMessageContent: o.userMessageContent,
        warnings: o.warnings,
        runtimeSessionId: o.runtimeSessionId,
        endedAt: '2026-07-24T00:00:00.000Z',
      }),
    });
  };
  const agents = new Map<string, Agent>([[DEV_AGENT.id, DEV_AGENT]]);
  const coordinator = new TaskCoordinator({
    store,
    agents,
    workspaceManager: workspace,
    extractor: new DeterministicReportExtractor(),
    qaSpecialistId: opts?.qaSpecialistId ?? 'qa',
    pump: (key) => pumped.push(key),
    finalize,
    cancelRun: (runId) => {
      killed.push(runId);
      return Promise.resolve();
    },
  });
  return { store, workspace, coordinator, finalized, pumped, killed };
}

/** A project + conversation + a task row in `state`, seeded through the store. */
function seedTask(store: MemoryHubStore, state: Task['state']) {
  const project = store.createProject({
    name: 'p',
    defaultAgentId: 'dev',
    sessionTemplateId: 'tpl',
    repo: null,
    instructions: null,
  });
  const conversation = store.createConversation({
    projectId: project.id,
    title: 't',
    agentId: 'dev',
    mode: 'automatic',
  });
  const { message } = store.sendMessage({
    conversationId: conversation.id,
    content: 'do the thing',
    caps: DEV_AGENT.defaultCaps,
    policy: DEV_AGENT.allowedTools,
    instructions: DEV_AGENT.instructions,
  });
  const task = store.createTask({
    projectId: project.id,
    sourceConversationId: conversation.id,
    sourceMessageId: message.id,
  });
  const transitions: Record<string, Task['state'][]> = {
    planning: [],
    implementing: ['implementing'],
    awaiting_human_approval: ['implementing', 'qa_pending', 'qa_running', 'awaiting_human_approval'],
  };
  let from: Task['state'] = 'planning';
  for (const to of transitions[state] ?? []) {
    store.transitionTask(task.id, from, to);
    from = to;
  }
  return { project, conversation, task: store.getTask(task.id)! };
}

/** The conversation's queued envelope run, dispatched to `starting` (as pump would). */
function dispatchEnvelopeRun(store: MemoryHubStore, projectId: string): Run {
  const run = store.dispatchNextRun(projectId);
  expect(run).not.toBeNull();
  return run!;
}

describe('TaskCoordinator (ADR-013, narrow fakes only)', () => {
  it('rejects approval actions on a task not awaiting human approval (409 taxonomy)', async () => {
    const { store, coordinator } = makeCoordinator();
    const { task } = seedTask(store, 'implementing');
    await expect(coordinator.approveTask(task.id)).rejects.toMatchObject({
      name: 'OrchestratorError',
      code: 'task_not_approvable',
    });
    await expect(coordinator.rejectTask(task.id)).rejects.toBeInstanceOf(OrchestratorError);
    expect(() => coordinator.requestTaskChanges(task.id, 'n')).toThrowError(OrchestratorError);
  });

  it('approveTask: terminal success → PR opened best-effort, URL recorded, worktree cleaned', async () => {
    const { store, workspace, coordinator } = makeCoordinator();
    const { task } = seedTask(store, 'awaiting_human_approval');
    const approved = await coordinator.approveTask(task.id);
    expect(approved.state).toBe('approved');
    expect(approved.pullRequestUrl).toBe('https://example.invalid/pr/1');
    expect(workspace.calls).toEqual(['pr', 'cleanup']);
  });

  it('steerTask on a LIVE task (I-14): queues feedback and seals the envelope run with the "Noted" note', () => {
    const { store, coordinator, finalized } = makeCoordinator();
    const { project, conversation, task } = seedTask(store, 'implementing');
    const run = dispatchEnvelopeRun(store, project.id);

    coordinator.steerTask(run, store.getConversation(conversation.id)!, task, 'also add logging');

    // the message waits at the next dev boundary — never a sibling task (ADR-014)
    expect(store.drainTaskFeedback(task.id)).toEqual(['also add logging']);
    expect(store.getTask(task.id)!.state).toBe('implementing');
    expect(finalized).toHaveLength(1);
    expect(finalized[0]!.to).toBe('completed');
    expect(finalized[0]!.note).toContain('folded into its next developer step');
    expect(store.getRun(run.id)!.state).toBe('completed');
  });

  it('steerTask from awaiting_human_approval (I-14): re-enters the loop as owner-requested changes', () => {
    const { store, coordinator, finalized } = makeCoordinator();
    const { project, conversation, task } = seedTask(store, 'awaiting_human_approval');
    const run = dispatchEnvelopeRun(store, project.id);

    coordinator.steerTask(run, store.getConversation(conversation.id)!, task, 'tighten the tests');

    // requestTaskChanges moves it to changes_requested_by_user; the resumed
    // loop's synchronous prefix may already have advanced it to implementing
    expect(['changes_requested_by_user', 'implementing']).toContain(store.getTask(task.id)!.state);
    expect(finalized[0]!.note).toContain('re-entering the developer → QA loop');
    // the resumed supervise() loop runs in the background and is tracked for idle()
    expect(coordinator.driving().length).toBe(1);
  });

  it('cancelTask (#140): 409 for terminal and awaiting states; a live step run is killed', async () => {
    const { store, coordinator, killed } = makeCoordinator();
    // awaiting → the verbs are reject/request-changes, not cancel
    const resting = seedTask(store, 'awaiting_human_approval');
    await expect(coordinator.cancelTask(resting.task.id)).rejects.toMatchObject({
      code: 'task_not_cancellable',
    });
    // a RUNNING task: request lands, and the live step run gets the kill
    const live = seedTask(store, 'implementing');
    // drain the seed's envelope run so the step run below is the live one (I-2)
    const seedRun = store.dispatchNextRun(live.project.id)!;
    store.transitionRun(seedRun.id, 'starting', 'streaming');
    store.finalizeRun({
      runId: seedRun.id,
      from: 'streaming',
      to: 'completed',
      usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'result-event' },
      summary: deriveRunSummary({
        run: store.getRun(seedRun.id)!,
        outcome: 'completed',
        events: [],
        usage: { totalCostUsd: null, numTurns: null },
        userMessageContent: 'x',
        warnings: [],
        runtimeSessionId: null,
        endedAt: '2026-07-28T00:00:00.000Z',
      }),
    });
    const step = store.createTaskStep({
      taskId: live.task.id,
      kind: 'implementation',
      specialistId: 'dev',
      workspaceAccess: null,
    });
    store.sendMessage({
      conversationId: live.conversation.id,
      content: 'step prompt',
      caps: DEV_AGENT.defaultCaps,
      policy: DEV_AGENT.allowedTools,
      instructions: DEV_AGENT.instructions,
      taskStepId: step.id,
    });
    const stepRun = store.dispatchNextRun(live.project.id)!; // starting = live
    const after = await coordinator.cancelTask(live.task.id);
    expect(after.state).toBe('implementing'); // cooperative: transition lands at the boundary
    expect(killed).toEqual([stepRun.id]);
  });

  it('reconcileTasks heals transient states to failed and leaves resting/terminal tasks alone', async () => {
    const { store, coordinator } = makeCoordinator();
    const live = seedTask(store, 'implementing');
    const resting = seedTask(store, 'awaiting_human_approval');
    await coordinator.reconcileTasks();
    expect(store.getTask(live.task.id)!.state).toBe('failed');
    expect(store.getTask(resting.task.id)!.state).toBe('awaiting_human_approval');
  });
});
