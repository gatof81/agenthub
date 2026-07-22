/**
 * Run-history read API: `GET /api/conversations/:id/runs` — the activity
 * panel's list (newest first: running on top, executed below). Entries are
 * lean (lifecycle + outcome + light summary); the per-run snapshots and the
 * full activity stay on `GET /api/runs/:id`.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { RunSummary } from '../src/domain/types.js';
import type { HubStore } from '../src/store/types.js';
import { AUTH, makeApiHarness } from './apiHarness.js';

const CAPS = { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 };
const POLICY = ['Read', 'Bash'];

function summaryFor(runId: string, outcome: RunSummary['outcome']): RunSummary {
  return {
    runId,
    objective: 'do the thing',
    outcome,
    filesTouched: ['src/a.ts'],
    commandsRun: ['npm test'],
    denialCount: 1,
    warnings: ['some warning'],
    costUsd: 0.1234,
    numTurns: 3,
    durationMs: 4200,
    runtimeSessionId: 'rs_secret',
  };
}

function seed(store: HubStore) {
  const project = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
  const conversation = store.createConversation({ projectId: project.id, title: 't', agentId: 'dev' });
  return { project, conversation };
}

function sendRun(store: HubStore, conversationId: string, content: string) {
  return store.sendMessage({
    conversationId,
    content,
    caps: CAPS,
    policy: POLICY,
    instructions: 'You are DEV.',
  }).run;
}

describe('GET /api/conversations/:id/runs', () => {
  it('lists runs newest-first with the light summary; active runs carry summary: null', async () => {
    const { app, store } = makeApiHarness();
    const { conversation } = seed(store);
    const r1 = sendRun(store, conversation.id, 'first');
    store.finalizeRun({
      runId: r1.id,
      from: 'queued',
      to: 'cancelled',
      usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'cancelled-unknown' },
      summary: summaryFor(r1.id, 'cancelled'),
    });
    const r2 = sendRun(store, conversation.id, 'second'); // still queued

    const res = await request(app).get(`/api/conversations/${conversation.id}/runs`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.runs.map((e: { run: { id: string } }) => e.run.id)).toEqual([r2.id, r1.id]);

    const [active, done] = res.body.runs;
    expect(active.run.state).toBe('queued');
    expect(active.summary).toBeNull();
    expect(done.run).toMatchObject({ state: 'cancelled', killOutcome: null });
    // the light summary: outcome fields only — never files/commands/warnings,
    // and never the runtime continuation handle
    expect(done.summary).toEqual({
      objective: 'do the thing',
      outcome: 'cancelled',
      costUsd: 0.1234,
      numTurns: 3,
      durationMs: 4200,
      denialCount: 1,
    });
  });

  it('entries are lean: no caps/policy/instructions snapshots, no seam handles', async () => {
    const { app, store } = makeApiHarness();
    const { conversation } = seed(store);
    sendRun(store, conversation.id, 'first');

    const res = await request(app).get(`/api/conversations/${conversation.id}/runs`).set(AUTH);
    const entry = res.body.runs[0].run;
    for (const key of ['capsSnapshot', 'policySnapshot', 'instructionsSnapshot', 'execId', 'pgid', 'seamRequestId']) {
      expect(entry).not.toHaveProperty(key);
    }
    expect(entry).toMatchObject({ conversationId: conversation.id, state: 'queued' });
    expect(entry.createdAt).toEqual(expect.any(String));
  });

  it('pages with ?limit and flags hasMore', async () => {
    const { app, store } = makeApiHarness();
    const { conversation } = seed(store);
    const ids = ['a', 'b', 'c'].map((c) => sendRun(store, conversation.id, c).id);

    const res = await request(app)
      .get(`/api/conversations/${conversation.id}/runs?limit=2`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(true);
    // the newest two of three
    expect(res.body.runs.map((e: { run: { id: string } }) => e.run.id)).toEqual([ids[2], ids[1]]);
  });

  it('404s an unknown conversation and 401s without the token', async () => {
    const { app } = makeApiHarness();
    expect((await request(app).get('/api/conversations/ghost/runs').set(AUTH)).status).toBe(404);
    expect((await request(app).get('/api/conversations/ghost/runs')).status).toBe(401);
  });
});
