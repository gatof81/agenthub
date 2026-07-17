/** API surface against the fakes (08 §1): flows + status-code semantics. */

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONVERSATION_TITLE } from '../src/domain/projections.js';
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

  it('auto-titles a conversation from its first message; leaves later ones and renames alone', async () => {
    const { app, orch, port } = makeApiHarness();
    const project = (
      await request(app).post('/api/projects').set(AUTH).send({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' })
    ).body.project;
    await orch.idle();
    const title = async (id: string): Promise<string> =>
      (await request(app).get(`/api/conversations/${id}`).set(AUTH)).body.conversation.title;

    // born with the default, earns a name from the first message
    const conv = (
      await request(app).post(`/api/projects/${project.id}/conversations`).set(AUTH).send({})
    ).body.conversation;
    expect(conv.title).toBe(DEFAULT_CONVERSATION_TITLE);
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.toolshape) });
    await request(app).post(`/api/conversations/${conv.id}/messages`).set(AUTH).send({ content: 'Fix the login bug' });
    await orch.idle();
    expect(await title(conv.id)).toBe('Fix the login bug');

    // a second message never re-titles
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.toolshape) });
    await request(app).post(`/api/conversations/${conv.id}/messages`).set(AUTH).send({ content: 'and add a test' });
    await orch.idle();
    expect(await title(conv.id)).toBe('Fix the login bug');

    // an explicit rename BEFORE the first message is never overwritten
    const named = (
      await request(app).post(`/api/projects/${project.id}/conversations`).set(AUTH).send({})
    ).body.conversation;
    await request(app).patch(`/api/conversations/${named.id}`).set(AUTH).send({ title: 'Design notes' });
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.toolshape) });
    await request(app).post(`/api/conversations/${named.id}/messages`).set(AUTH).send({ content: 'first message here' });
    await orch.idle();
    expect(await title(named.id)).toBe('Design notes');
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
    // the workspace is the project's and has no default (ADR-006, FR-45):
    // omitting it must 422, not fall back to something
    const noTemplate = await request(app)
      .post('/api/projects')
      .set(AUTH)
      .send({ name: 'x', defaultAgentId: 'dev' });
    expect(noTemplate.status).toBe(422);
    expect(noTemplate.body.detail).toContain('sessionTemplateId');
    // an invented or stale id must be rejected at the boundary, the way
    // defaultAgentId is — otherwise it 202s and dies at the seam later, with
    // nothing pointing at the cause (ADR-006, FR-45)
    const badTemplate = await request(app)
      .post('/api/projects')
      .set(AUTH)
      .send({ name: 'x', defaultAgentId: 'dev', sessionTemplateId: 'not-a-real-template' });
    expect(badTemplate.status).toBe(422);
    expect(badTemplate.body.detail).toContain('workspace-templates');
    // a padded id must be stored as the value that was VALIDATED — trimming
    // for the check and storing the raw string sent " tpl " to the seam as an
    // unknown template, killing the project with nothing pointing at a space
    const padded = await request(app)
      .post('/api/projects')
      .set(AUTH)
      .send({ name: 'padded', defaultAgentId: 'dev', sessionTemplateId: '  tpl  ' });
    expect(padded.status).toBe(202);
    expect(padded.body.project.sessionTemplateId).toBe('tpl');
    // repo.auth gets the same treatment: a malformed shape must 422 here, not
    // reach the seam and come back as an opaque substrate error
    const badAuth = await request(app)
      .post('/api/projects')
      .set(AUTH)
      .send({
        name: 'x',
        defaultAgentId: 'dev',
        sessionTemplateId: 'tpl',
        repo: { url: 'https://github.com/o/r', auth: { kind: 'pat' } }, // no pat
      });
    expect(badAuth.status).toBe(422);
    expect(badAuth.body.detail).toContain('repo.auth');
    // and the rejection must not echo the credential back (SEC-04/05)
    const leaky = await request(app)
      .post('/api/projects')
      .set(AUTH)
      .send({
        name: 'x',
        defaultAgentId: 'dev',
        sessionTemplateId: 'tpl',
        repo: { url: 'https://github.com/o/r', auth: { kind: 'nope', pat: 'ghp_LEAK_CANARY' } },
      });
    expect(leaky.status).toBe(422);
    expect(JSON.stringify(leaky.body)).not.toContain('ghp_LEAK_CANARY');
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

describe('GET /api/sessions — discovery (N1, FR-48, ADR-007)', () => {
  it('lists seam sessions with scope and annotates project bindings', async () => {
    const { app, port } = makeApiHarness();
    port.seedSession({
      sessionId: 's_edu',
      name: 'Education Hz',
      status: 'running',
      ownerUsername: 'owner-admin',
      createdAt: '2026-07-17T00:00:00.000Z',
      lastConnectedAt: null,
      externalRef: null,
    });
    // a project bound to a session created through the Hub
    const created = await request(app)
      .post('/api/projects')
      .set(AUTH)
      .send({ name: 'Test', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    expect(created.status).toBe(202);
    // fake provisioning is synchronous enough: give the event loop a tick
    await new Promise((r) => setTimeout(r, 10));

    const res = await request(app).get('/api/sessions').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('all');
    const rows = res.body.sessions as Array<Record<string, unknown>>;
    const unbound = rows.find((s) => s.sessionId === 's_edu');
    expect(unbound).toMatchObject({
      name: 'Education Hz',
      ownerUsername: 'owner-admin',
      projectId: null,
      projectName: null,
      // unbound by any Hub project → nobody's project session (ADR-007)
      ownership: null,
    });
    const bound = rows.find((s) => s.projectId !== null);
    expect(bound).toBeDefined();
    expect(bound?.projectName).toBe('Test');
    // template-created with no on-behalf owner id → the Hub's own generic
    // session; the UI hides these, so the row must carry the discriminator.
    expect(bound?.ownership).toBe('legacy-technical');
  });

  it('surfaces the degraded own scope instead of presenting it as the estate (FR-48)', async () => {
    const { app, port } = makeApiHarness();
    port.listingScope = 'own';
    const res = await request(app).get('/api/sessions').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('own');
  });

  it('requires auth like every other route (V-3)', async () => {
    const { app } = makeApiHarness();
    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/projects — bind an existing session (N2, FR-49)', () => {
  it('binds: 202, then ready with ownership recorded and nothing created', async () => {
    const { app, port } = makeApiHarness();
    port.seedSession({
      sessionId: 's_edu',
      name: 'Education Hz',
      status: 'running',
      ownerUsername: 'owner-admin',
      createdAt: null,
      lastConnectedAt: null,
      externalRef: null,
    });
    const created = await request(app)
      .post('/api/projects')
      .set(AUTH)
      .send({ name: 'Edu', defaultAgentId: 'dev', sessionId: 's_edu' });
    expect(created.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    const res = await request(app).get(`/api/projects/${created.body.project.id}`).set(AUTH);
    expect(res.body.project.status).toBe('ready');
    expect(res.body.project.sessionBinding).toMatchObject({
      sessionId: 's_edu',
      bindingMode: 'existing',
      ownership: 'owner',
    });
    expect(port.seededSessions).toHaveLength(0);
  });

  it('refuses both-or-neither of sessionId and sessionTemplateId (422)', async () => {
    const { app } = makeApiHarness();
    const neither = await request(app)
      .post('/api/projects')
      .set(AUTH)
      .send({ name: 'x', defaultAgentId: 'dev' });
    expect(neither.status).toBe(422);
    const both = await request(app)
      .post('/api/projects')
      .set(AUTH)
      .send({ name: 'x', defaultAgentId: 'dev', sessionTemplateId: 'tpl', sessionId: 's1' });
    expect(both.status).toBe(422);
  });

  it('refuses a repo declaration on the bind path (the session already has its workspace)', async () => {
    const { app } = makeApiHarness();
    const res = await request(app)
      .post('/api/projects')
      .set(AUTH)
      .send({
        name: 'x',
        defaultAgentId: 'dev',
        sessionId: 's1',
        repo: { url: 'https://github.com/o/r' },
      });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/repo cannot be declared/);
  });
});

describe('GET /api/specialists (N3, ADR-008)', () => {
  it('lists reusable identities with role + capabilities', async () => {
    const { app } = makeApiHarness();
    const res = await request(app).get('/api/specialists').set(AUTH);
    expect(res.status).toBe(200);
    const dev = (res.body.specialists as Array<Record<string, unknown>>).find((s) => s.id === 'dev');
    // the harness DEV_AGENT declares no role/capabilities → null / [] defaults
    expect(dev).toMatchObject({ id: 'dev', name: 'Developer', role: null, capabilities: [] });
    expect(dev!.allowedTools).toBeInstanceOf(Array);
  });

  it('requires auth like every other /api route', async () => {
    const { app } = makeApiHarness();
    expect((await request(app).get('/api/specialists')).status).toBe(401);
  });
});

describe('specialist sessions (N3b-1)', () => {
  it('binds an existing session and reflects it in GET /api/specialists', async () => {
    const { app, port } = makeApiHarness();
    port.seedSession({
      sessionId: 's_dev',
      name: 'Claudio session',
      status: 'running',
      ownerUsername: 'owner-admin',
      createdAt: null,
      lastConnectedAt: null,
      externalRef: null,
    });
    const bind = await request(app)
      .post('/api/specialists/dev/session')
      .set(AUTH)
      .send({ sessionId: 's_dev' });
    expect(bind.status).toBe(201);
    expect(bind.body.session).toMatchObject({ sessionId: 's_dev', status: 'available', ownership: 'owner' });

    const list = await request(app).get('/api/specialists').set(AUTH);
    const dev = (list.body.specialists as Array<Record<string, unknown>>).find((s) => s.id === 'dev');
    expect(dev!.session).toMatchObject({ sessionId: 's_dev', status: 'available' });
  });

  it('422 on both-or-neither, 404 on unknown specialist, 401 without auth', async () => {
    const { app } = makeApiHarness();
    expect((await request(app).post('/api/specialists/dev/session').set(AUTH).send({})).status).toBe(422);
    expect(
      (await request(app).post('/api/specialists/dev/session').set(AUTH).send({ sessionId: 's', sessionTemplateId: 'tpl' })).status,
    ).toBe(422);
    expect((await request(app).post('/api/specialists/ghost/session').set(AUTH).send({ sessionId: 's' })).status).toBe(404);
    expect((await request(app).post('/api/specialists/dev/session').send({ sessionId: 's' })).status).toBe(401);
  });

  it('an unbound specialist reports session: null', async () => {
    const { app } = makeApiHarness();
    const list = await request(app).get('/api/specialists').set(AUTH);
    const dev = (list.body.specialists as Array<Record<string, unknown>>).find((s) => s.id === 'dev');
    expect(dev!.session).toBeNull();
  });
});
