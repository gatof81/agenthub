/**
 * Task read API (N5b-2b): the surface the task view reads. Tasks are seeded via
 * the store (the supervisor's write path is covered elsewhere), then fetched
 * through the HTTP gateway — the conversation's tasks (for the kickoff-turn
 * affordance, matched by sourceMessageId) and one task in full (steps with the
 * DelegatedWorkspaceAccess audit + work products).
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { AUTH, makeApiHarness } from './apiHarness.js';

function seedProjectAndConversation(store: ReturnType<typeof makeApiHarness>['store']) {
  const project = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
  const conversation = store.createConversation({
    projectId: project.id,
    title: 't',
    agentId: 'dev',
    mode: 'automatic',
  });
  return { project, conversation };
}

describe('task read API (N5b-2b)', () => {
  it('lists the tasks a conversation spawned, matchable by sourceMessageId', async () => {
    const { app, store } = makeApiHarness();
    const { project, conversation } = seedProjectAndConversation(store);
    const task = store.createTask({
      projectId: project.id,
      sourceConversationId: conversation.id,
      sourceMessageId: 'msg_kickoff',
    });
    // a task in a different conversation must not leak in
    const other = store.createConversation({ projectId: project.id, title: 'o', agentId: 'dev', mode: 'automatic' });
    store.createTask({ projectId: project.id, sourceConversationId: other.id, sourceMessageId: 'msg_other' });

    const res = await request(app).get(`/api/conversations/${conversation.id}/tasks`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.tasks[0]).toMatchObject({ id: task.id, sourceMessageId: 'msg_kickoff', state: 'planning' });
  });

  it('returns a task in full — steps with the workspace grant, and work products', async () => {
    const { app, store } = makeApiHarness();
    const { project, conversation } = seedProjectAndConversation(store);
    const task = store.createTask({ projectId: project.id, sourceConversationId: conversation.id });
    const devStep = store.createTaskStep({
      taskId: task.id,
      kind: 'implementation',
      specialistId: 'dev',
      workspaceAccess: {
        accessMode: 'worktree-write',
        branch: `hub/task/${task.id}`,
        path: `/home/developer/workspace/.hub-task-worktrees/${task.id}`,
        pathBounds: [],
        expiresAt: null,
      },
    });
    store.addWorkProduct({
      taskId: task.id,
      taskStepId: devStep.id,
      producerSpecialistId: 'dev',
      runId: 'run_x',
      kind: 'implementation_report',
      body: {
        objective: 'add X',
        summary: 'did it',
        filesChanged: ['a.ts'],
        commandsRun: ['npm test'],
        testsRun: ['unit'],
        knownRisks: [],
        commitOrPatch: null,
      },
    });

    const res = await request(app).get(`/api/tasks/${task.id}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({ id: task.id, state: 'planning' });
    expect(res.body.steps).toHaveLength(1);
    expect(res.body.steps[0].workspaceAccess).toMatchObject({ accessMode: 'worktree-write' });
    expect(res.body.workProducts).toHaveLength(1);
    expect(res.body.workProducts[0]).toMatchObject({ kind: 'implementation_report' });
  });

  it('404s an unknown task and an unknown conversation', async () => {
    const { app } = makeApiHarness();
    expect((await request(app).get('/api/tasks/ghost').set(AUTH)).status).toBe(404);
    expect((await request(app).get('/api/conversations/ghost/tasks').set(AUTH)).status).toBe(404);
  });

  it('requires auth on both read endpoints', async () => {
    const { app } = makeApiHarness();
    expect((await request(app).get('/api/tasks/whatever')).status).toBe(401);
    expect((await request(app).get('/api/conversations/ghost/tasks')).status).toBe(401);
  });
});
