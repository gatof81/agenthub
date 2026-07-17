/**
 * Single-origin SPA serving (ADR-002): the backend serves the built frontend
 * so the browser is same-origin with /api. Verifies the static + fallback
 * surface never shadows /api and that unmatched /api stays JSON.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { Broadcaster } from '../src/api/broadcaster.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { AUTH, DEV_AGENT } from './apiHarness.js';

const TOKEN = 'test-token-agenthub';

function makeApp(staticDir: string): ReturnType<typeof buildApp> {
  const store = new MemoryHubStore();
  const port = new FakeSubstrateExecPort();
  const broadcaster = new Broadcaster();
  const orch = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    agents: new Map([[DEV_AGENT.id, DEV_AGENT]]),
    notify: broadcaster,
  });
  return buildApp({
    store,
    orchestrator: orch,
    agents: new Map([[DEV_AGENT.id, DEV_AGENT]]),
    workspaceTemplates: [{ id: 'tpl', name: 'Test workspace' }],
    broadcaster,
    authToken: TOKEN,
    staticDir,
  });
}

describe('SPA serving (ADR-002 single-origin)', () => {
  let dir: string;
  let app: ReturnType<typeof buildApp>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hub-spa-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Agent Hub</title>');
    writeFileSync(join(dir, 'assets-app.js'), 'console.log("spa");');
    app = makeApp(dir);
  });

  it('serves index.html at the root — the browser gets the SPA', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Agent Hub');
    // static assets are public — no token gate (the browser has none yet)
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('serves a real static asset without a token', async () => {
    const res = await request(app).get('/assets-app.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('spa');
  });

  it('falls back to index.html for a client-side route (deep link)', async () => {
    const res = await request(app).get('/projects/abc/conversations/xyz');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Agent Hub');
  });

  it('never shadows /api: health still answers JSON', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('an authenticated unmatched /api path is a JSON 404, not the SPA', async () => {
    const res = await request(app).get('/api/does-not-exist').set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'not_found' });
    expect(res.text).not.toContain('Agent Hub');
  });

  it('an unauthenticated /api path still 401s (gate is untouched)', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'unauthorized' });
  });

  it('a token-gated /api route works through the same app', async () => {
    const res = await request(app).get('/api/projects').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.projects)).toBe(true);
  });
});

describe('SPA serving disabled (no staticDir — API-only boot)', () => {
  it('does not serve a SPA; the root is a 404', async () => {
    const store = new MemoryHubStore();
    const port = new FakeSubstrateExecPort();
    const app = buildApp({
      store,
      orchestrator: new Orchestrator({
        store,
        adapter: new FakeRuntimeAdapter(port),
        execPort: port,
        agents: new Map([[DEV_AGENT.id, DEV_AGENT]]),
      }),
      agents: new Map([[DEV_AGENT.id, DEV_AGENT]]),
      workspaceTemplates: [{ id: 'tpl', name: 'Test workspace' }],
      broadcaster: new Broadcaster(),
      authToken: TOKEN,
    });
    const res = await request(app).get('/');
    expect(res.status).toBe(404);
    // /api still works
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
});
