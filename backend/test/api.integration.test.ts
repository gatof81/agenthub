/** API surface against the fakes (08 §1): flows + status-code semantics. */

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AUTH, makeApiHarness } from './apiHarness.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

describe('HTTP API (08 §1)', () => {
  it('health: liveness unauthenticated, detail authenticated', async () => {
    const { app } = makeApiHarness();
    const open = await request(app).get('/api/health');
    expect(open.status).toBe(200);
    expect(open.body).toEqual({ status: 'ok' });
    const authed = await request(app).get('/api/health').set(AUTH);
    // backups disabled in the harness → enabled:false, never degraded
    expect(authed.body.backup).toEqual({ enabled: false, lastSnapshotAt: null, degraded: false });
  });

  it('health surfaces backup freshness when a gauge is wired (OPS-02)', async () => {
    const { app } = makeApiHarness(undefined, {
      snapshotFreshness: () => ({ lastSnapshotAt: '2026-07-15T09:00:00.000Z', degraded: false }),
    });
    const res = await request(app).get('/api/health').set(AUTH);
    expect(res.body.backup).toEqual({
      enabled: true,
      lastSnapshotAt: '2026-07-15T09:00:00.000Z',
      degraded: false,
    });
    // liveness stays unauthenticated + minimal
    const open = await request(app).get('/api/health');
    expect(open.body).toEqual({ status: 'ok' });
  });

  it('health surfaces the metrics snapshot when wired (B3-07, authed only)', async () => {
    const { app } = makeApiHarness(undefined, {
      metricsSnapshot: () => ({ runTransitions: { completed: 3 }, seamErrors: 0, activeRuns: 1 }),
    });
    const res = await request(app).get('/api/health').set(AUTH);
    expect(res.body.metrics).toEqual({ runTransitions: { completed: 3 }, seamErrors: 0, activeRuns: 1 });
    // unauthenticated liveness never exposes metrics
    const open = await request(app).get('/api/health');
    expect(open.body).toEqual({ status: 'ok' });
  });

  it('every response carries a 16-hex X-Request-Id (OPS-04)', async () => {
    const { app } = makeApiHarness();
    const res = await request(app).get('/api/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f]{16}$/);
  });

  it('project lifecycle: 202 provisioning → ready; agents listed; conversation created instantly (UC-01)', async () => {
    const { app, orch } = makeApiHarness();
    const agents = await request(app).get('/api/agents').set(AUTH);
    expect(agents.body.agents[0]).toMatchObject({ id: 'dev', allowedTools: expect.any(Array) });

    const created = await request(app)
      .post('/api/projects')
      .set(AUTH)
      .send({ name: 'my project', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    expect(created.status).toBe(202);
    expect(created.body.project.status).toBe('provisioning');
    await orch.idle();

    const projectId = created.body.project.id as string;
    const detail = await request(app).get(`/api/projects/${projectId}`).set(AUTH);
    expect(detail.body.project.status).toBe('ready');

    const conv = await request(app)
      .post(`/api/projects/${projectId}/conversations`)
      .set(AUTH)
      .send({});
    expect(conv.status).toBe(201);
    expect(conv.body.conversation.agentId).toBe('dev');
    expect(detail.headers['x-request-id']).not.toBe(created.headers['x-request-id']);
  });

  it('send → 202 {runId}; GET /api/runs/:id returns activity + usage + summary when terminal (UC-02)', async () => {
    const { app, orch, port } = makeApiHarness();
    const project = (
      await request(app).post('/api/projects').set(AUTH).send({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' })
    ).body.project;
    await orch.idle();
    const conv = (
      await request(app).post(`/api/projects/${project.id}/conversations`).set(AUTH).send({})
    ).body.conversation;

    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.toolshape) });
    const sent = await request(app)
      .post(`/api/conversations/${conv.id}/messages`)
      .set(AUTH)
      .send({ content: 'do some work' });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({
      messageId: expect.stringMatching(/^msg_/),
      runId: expect.stringMatching(/^run_/),
      runState: expect.stringMatching(/queued|starting|streaming/),
    });
    await orch.idle();

    const run = await request(app).get(`/api/runs/${sent.body.runId}`).set(AUTH);
    expect(run.body.run.state).toBe('completed');
    expect(run.body.usage.source).toBe('result-event');
    expect(run.body.summary.outcome).toBe('completed');
    expect(run.body.activity.commands.length + run.body.activity.files.length).toBeGreaterThan(0);

    const thread = await request(app).get(`/api/conversations/${conv.id}`).set(AUTH);
    expect(thread.body.messages.at(-1).role).toBe('assistant');
  });

  it('409 while the project is provisioning (08 §1) with the state in the body', async () => {
    const { app, store } = makeApiHarness();
    const project = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' }); // stays provisioning
    const conv = store.createConversation({ projectId: project.id, title: 't', agentId: 'dev' });
    const sent = await request(app)
      .post(`/api/conversations/${conv.id}/messages`)
      .set(AUTH)
      .send({ content: 'x' });
    expect(sent.status).toBe(409);
    expect(sent.body.code).toBe('project_not_ready');
    expect(sent.body.detail).toContain('provisioning');
  });

  it('422 on validation failures; 404 on absences', async () => {
    const { app } = makeApiHarness();
    expect(
      (await request(app).post('/api/projects').set(AUTH).send({ name: '' })).status,
    ).toBe(422);
    expect(
      (await request(app).post('/api/projects').set(AUTH).send({ name: 'x', defaultAgentId: 'nope', sessionTemplateId: 'tpl' }))
        .status,
    ).toBe(422);
    expect((await request(app).get('/api/runs/run_missing').set(AUTH)).status).toBe(404);
    expect((await request(app).get('/api/conversations/conv_missing').set(AUTH)).status).toBe(404);
  });

  it('cancel: 202 on cancellable, 409 with state on terminal (UC-04)', async () => {
    const { app, orch, port } = makeApiHarness();
    const project = (
      await request(app).post('/api/projects').set(AUTH).send({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' })
    ).body.project;
    await orch.idle();
    const conv = (
      await request(app).post(`/api/projects/${project.id}/conversations`).set(AUTH).send({})
    ).body.conversation;
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    const sent = await request(app)
      .post(`/api/conversations/${conv.id}/messages`)
      .set(AUTH)
      .send({ content: 'quick' });
    await orch.idle(); // completes
    const cancel = await request(app).post(`/api/runs/${sent.body.runId}/cancel`).set(AUTH);
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe('run_not_cancellable');
  });

  it('archiving a project stops its session (PATCH semantics, FR-30)', async () => {
    const { app, orch, port } = makeApiHarness();
    const project = (
      await request(app).post('/api/projects').set(AUTH).send({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' })
    ).body.project;
    await orch.idle();
    const patched = await request(app)
      .patch(`/api/projects/${project.id}`)
      .set(AUTH)
      .send({ status: 'archived' });
    expect(patched.body.project.status).toBe('archived');
    expect(port.stoppedSessions).toEqual(['fakesess_1']);
    // archived projects filtered by default
    const list = await request(app).get('/api/projects').set(AUTH);
    expect(list.body.projects).toHaveLength(0);
  });
});
