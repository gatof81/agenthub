/**
 * Human approval API (N6): the owner's verdict on a task awaiting_human_approval.
 * Approve/reject are terminal; request-changes re-enters the dev → QA loop (run
 * end-to-end on the fake substrate) back to awaiting_human_approval. Tasks are
 * seeded at awaiting_human_approval via the store, then acted on through HTTP.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { AUTH, DEV_AGENT, makeApiHarness } from './apiHarness.js';
import type { Orchestrator } from '../src/orchestrator/orchestrator.js';
import type { HubStore } from '../src/store/types.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

/**
 * Create a task with a dev + QA step, driven (via the store) to
 * awaiting_human_approval. The project is provisioned through the orchestrator
 * so it has a substrate session — the resumed step runs (request-changes) need
 * one to resolve their execution target.
 */
async function seedApprovable(orch: Orchestrator, store: HubStore) {
  const created = orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
  await orch.idle();
  const project = store.getProject(created.id)!;
  const conversation = store.createConversation({
    projectId: project.id,
    title: 't',
    agentId: 'dev',
    mode: 'automatic',
  });
  const { message, run } = store.sendMessage({
    conversationId: conversation.id,
    content: 'add feature X',
    caps: DEV_AGENT.defaultCaps,
    policy: DEV_AGENT.allowedTools,
    instructions: DEV_AGENT.instructions,
  });
  // sendMessage also creates a run; a real kickoff run is terminal by now — settle
  // this seed one so it doesn't sit queued and get dispatched ahead of the resume's
  // step runs (which would consume their fixtures).
  await orch.cancelRun(run.id);
  const task = store.createTask({
    projectId: project.id,
    sourceConversationId: conversation.id,
    sourceMessageId: message.id,
  });
  const grant = {
    accessMode: 'worktree-write' as const,
    branch: `hub/task/${task.id}`,
    path: `/home/developer/workspace/.hub-task-worktrees/${task.id}`,
    pathBounds: [],
    expiresAt: null,
  };
  store.createTaskStep({ taskId: task.id, kind: 'implementation', specialistId: 'dev', workspaceAccess: grant });
  store.createTaskStep({ taskId: task.id, kind: 'qa', specialistId: 'dev', workspaceAccess: grant });
  store.transitionTask(task.id, 'planning', 'implementing');
  store.transitionTask(task.id, 'implementing', 'qa_pending');
  store.transitionTask(task.id, 'qa_pending', 'qa_running');
  store.transitionTask(task.id, 'qa_running', 'awaiting_human_approval');
  return { project, conversation, task };
}

describe('human approval API (N6)', () => {
  it('approve moves the task to approved (terminal)', async () => {
    const { app, store, orch } = makeApiHarness();
    const { task } = await seedApprovable(orch, store);
    const res = await request(app).post(`/api/tasks/${task.id}/approve`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.task.state).toBe('approved');
    expect(store.getTask(task.id)!.state).toBe('approved');
  });

  it('reject moves the task to rejected (terminal)', async () => {
    const { app, store, orch } = makeApiHarness();
    const { task } = await seedApprovable(orch, store);
    const res = await request(app).post(`/api/tasks/${task.id}/reject`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.task.state).toBe('rejected');
  });

  it('409s an approval action on a task not awaiting approval', async () => {
    const { app, store, orch } = makeApiHarness();
    const { task } = await seedApprovable(orch, store);
    await request(app).post(`/api/tasks/${task.id}/approve`).set(AUTH); // now approved
    const again = await request(app).post(`/api/tasks/${task.id}/reject`).set(AUTH);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('task_not_approvable');
  });

  it('request-changes requires a non-empty note', async () => {
    const { app, store, orch } = makeApiHarness();
    const { task } = await seedApprovable(orch, store);
    const res = await request(app).post(`/api/tasks/${task.id}/request-changes`).set(AUTH).send({ note: '  ' });
    expect(res.status).toBe(400);
    expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval'); // untouched
  });

  it('request-changes re-runs the loop back to awaiting_human_approval', async () => {
    const { app, store, port, orch } = makeApiHarness();
    const { task } = await seedApprovable(orch, store);
    // the resumed dev + QA step runs each consume a fixture (no marker → QA passes)
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });

    const res = await request(app)
      .post(`/api/tasks/${task.id}/request-changes`)
      .set(AUTH)
      .send({ note: 'please rename foo to bar' });
    expect(res.status).toBe(200);
    expect(res.body.task.state).toBe('changes_requested_by_user');

    await orch.idle(); // let the resumed loop finish
    expect(store.getTask(task.id)!.state).toBe('awaiting_human_approval');
    // a second dev + QA round was appended
    expect(store.listTaskSteps(task.id)).toHaveLength(4);
    expect(port.execRequests).toHaveLength(2);
  });

  it('requires auth', async () => {
    const { app } = makeApiHarness();
    expect((await request(app).post('/api/tasks/whatever/approve')).status).toBe(401);
  });
});
