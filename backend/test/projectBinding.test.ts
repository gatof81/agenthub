/**
 * N2 (FR-49, ADR-007): a project binds an existing owner-account session —
 * the Hub creates nothing — and lifecycle authority follows ownership: the
 * Hub stops/starts only sessions its own identity owns (`legacy-technical`);
 * an `owner` session is never touched by archive/restore. Offline, both
 * stores (13 §3/§6).
 */

import DatabaseCtor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Agent, Project } from '../src/domain/types.js';
import { Orchestrator, OrchestratorError } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { loadMigrations, migrate } from '../src/store/migrations.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { SqliteHubStore } from '../src/store/sqlite.js';
import type { HubStore } from '../src/store/types.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

const DEV: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'You are the dev agent.',
  allowedTools: ['Read', 'Bash'],
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
};

function makeHarness(store: HubStore): { port: FakeSubstrateExecPort; orch: Orchestrator } {
  const port = new FakeSubstrateExecPort();
  const orch = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    agents: new Map([[DEV.id, DEV]]),
  });
  return { port, orch };
}

/** bind/provision settle on the fake in a tick; give the event loop a few */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

const OWNED_SESSION = {
  sessionId: 's_owned',
  name: 'Education Hz',
  status: 'running',
  ownerUsername: 'owner-admin',
  createdAt: null,
  lastConnectedAt: null,
  externalRef: null,
};

function suite(name: string, makeStore: () => HubStore): void {
  describe(`project binding — ${name}`, () => {
    it('binds an existing session: creates nothing, records ownership, back-links the ref (FR-49)', async () => {
      const store = makeStore();
      const { port, orch } = makeHarness(store);
      port.seedSession({ ...OWNED_SESSION });
      const created = orch.createProject({
        name: 'edu',
        defaultAgentId: 'dev',
        sessionTemplateId: null,
        existingSessionId: 's_owned',
      });
      expect(created.status).toBe('provisioning');
      await settle();
      const project = store.getProject(created.id) as Project;
      expect(project.status).toBe('ready');
      expect(project.sessionBinding).toMatchObject({
        sessionId: 's_owned',
        bindingMode: 'existing',
        ownerAccountId: 'owner-admin',
        ownership: 'owner',
        lastKnownState: 'running',
      });
      // the Hub created no session upstream
      expect(port.seededSessions).toHaveLength(0);
      // and the session carries the back-link (#418)
      expect((await port.getSession('s_owned'))?.externalRef).toBe(
        `agenthub:project:${created.id}`,
      );
    });

    it('binding an unknown session lands the project in error — nothing is conjured (FR-44 principle)', async () => {
      const store = makeStore();
      const { port, orch } = makeHarness(store);
      const created = orch.createProject({
        name: 'ghost',
        defaultAgentId: 'dev',
        sessionTemplateId: null,
        existingSessionId: 's_nope',
      });
      await settle();
      expect(store.getProject(created.id)?.status).toBe('error');
      expect(port.seededSessions).toHaveLength(0);
    });

    it('a stopped session binds fine — state is surfaced, not judged (FR-33)', async () => {
      const store = makeStore();
      const { port, orch } = makeHarness(store);
      port.seedSession({ ...OWNED_SESSION, sessionId: 's_stop', status: 'stopped' });
      const created = orch.createProject({
        name: 'stopped-bind',
        defaultAgentId: 'dev',
        sessionTemplateId: null,
        existingSessionId: 's_stop',
      });
      await settle();
      const project = store.getProject(created.id) as Project;
      expect(project.status).toBe('ready');
      expect(project.sessionBinding.lastKnownState).toBe('stopped');
    });

    it('archive/restore of an owner-bound project never touches the session (ADR-007)', async () => {
      const store = makeStore();
      const { port, orch } = makeHarness(store);
      port.seedSession({ ...OWNED_SESSION });
      const created = orch.createProject({
        name: 'edu',
        defaultAgentId: 'dev',
        sessionTemplateId: null,
        existingSessionId: 's_owned',
      });
      await settle();
      await orch.archiveProject(created.id);
      expect(port.stoppedSessions).toHaveLength(0); // the owner's session keeps running
      expect(store.getProject(created.id)?.status).toBe('archived');

      const restored = await orch.restoreProject(created.id);
      expect(restored.status).toBe('ready');
      expect(port.startedSessions).toHaveLength(0); // nothing was stopped, nothing to start
    });

    it('restoring an owner-bound project whose session was deleted → session_gone, stays archived (FR-44)', async () => {
      const store = makeStore();
      const { port, orch } = makeHarness(store);
      port.seedSession({ ...OWNED_SESSION });
      const created = orch.createProject({
        name: 'edu',
        defaultAgentId: 'dev',
        sessionTemplateId: null,
        existingSessionId: 's_owned',
      });
      await settle();
      await orch.archiveProject(created.id);
      port.markSessionGone('s_owned'); // owner hard-deleted it outside the Hub
      await expect(orch.restoreProject(created.id)).rejects.toMatchObject({
        code: 'session_gone',
      });
      expect(store.getProject(created.id)?.status).toBe('archived');
    });

    it('template-created projects keep legacy lifecycle: archive stops, and the ref is set from birth', async () => {
      const store = makeStore();
      const { port, orch } = makeHarness(store);
      const created = orch.createProject({
        name: 'legacy',
        defaultAgentId: 'dev',
        sessionTemplateId: 'tpl',
      });
      await settle();
      const project = store.getProject(created.id) as Project;
      expect(project.status).toBe('ready');
      expect(project.sessionBinding).toMatchObject({
        bindingMode: 'created',
        ownership: 'legacy-technical',
      });
      const sessionId = project.sessionBinding.sessionId as string;
      expect(port.seededSessions[0]?.seed.externalRef).toBe(`agenthub:project:${created.id}`);
      await orch.archiveProject(created.id);
      expect(port.stoppedSessions).toEqual([sessionId]); // Hub-owned → Hub-stopped
    });

    it('createProject refuses both-or-neither workspace declarations', () => {
      const store = makeStore();
      const { orch } = makeHarness(store);
      expect(() =>
        orch.createProject({ name: 'x', defaultAgentId: 'dev', sessionTemplateId: null }),
      ).toThrow(/exactly one/);
      expect(() =>
        orch.createProject({
          name: 'x',
          defaultAgentId: 'dev',
          sessionTemplateId: 'tpl',
          existingSessionId: 's_owned',
        }),
      ).toThrow(/exactly one/);
      expect(() => {
        throw new OrchestratorError('not_found', 'sanity: error class importable');
      }).toThrow(OrchestratorError);
    });
  });
}

suite('memory store', () => new MemoryHubStore());
suite('sqlite store', () => new SqliteHubStore(':memory:'));

describe('migration 004 (doc 19 §5)', () => {
  it('backfills existing projects as created/legacy-technical and preserves rows', () => {
    const db = new DatabaseCtor(':memory:');
    const all = loadMigrations();
    migrate(db, all.filter((m) => m.version <= 3)); // a pre-correction database
    db.prepare(
      `INSERT INTO projects (id, name, status, default_agent_id, session_id, created_at, updated_at)
       VALUES ('p1', 'old', 'ready', 'dev', 'sess_old', 't', 't')`,
    ).run();
    migrate(db, all);
    const row = db
      .prepare(`SELECT binding_mode, owner_account_id, session_ownership FROM projects WHERE id = 'p1'`)
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      binding_mode: 'created',
      owner_account_id: null, // unrecorded, never fabricated
      session_ownership: 'legacy-technical',
    });
    db.close();
  });
});

describe('create-on-behalf lifecycle (N2, #420)', () => {
  it('a session created in the owner account is owned by them and never stopped on archive', async () => {
    const store = new MemoryHubStore();
    const port = new FakeSubstrateExecPort();
    port.createOnBehalfUserId = 'owner-uuid-1';
    const orch = new Orchestrator({
      store,
      adapter: new FakeRuntimeAdapter(port),
      execPort: port,
      agents: new Map([[DEV.id, DEV]]),
    });
    const created = orch.createProject({
      name: 'edu',
      defaultAgentId: 'dev',
      sessionTemplateId: 'tpl',
    });
    await settle();
    const project = store.getProject(created.id) as Project;
    expect(project.status).toBe('ready');
    expect(project.sessionBinding).toMatchObject({
      bindingMode: 'created',
      ownership: 'owner',
      ownerAccountId: 'owner-uuid-1',
    });
    // the session carries the project back-link from birth (#418)
    expect(port.seededSessions[0]?.seed.externalRef).toBe(`agenthub:project:${created.id}`);
    await orch.archiveProject(created.id);
    // owner-account session: archiving is a Hub-side act only (ADR-007)
    expect(port.stoppedSessions).toHaveLength(0);
  });
});

describe('specialist session binding (N3b-1, ADR-008)', () => {
  it('binds an existing owner session: records ownership, back-links the ref, creates nothing', async () => {
    const store = new MemoryHubStore();
    const port = new FakeSubstrateExecPort();
    port.seedSession({ ...OWNED_SESSION, sessionId: 's_claudio' });
    const orch = new Orchestrator({
      store,
      adapter: new FakeRuntimeAdapter(port),
      execPort: port,
      agents: new Map([[DEV.id, DEV]]),
    });
    const binding = await orch.bindSpecialistSession('dev', { sessionId: 's_claudio' });
    expect(binding).toMatchObject({
      specialistId: 'dev',
      sessionId: 's_claudio',
      ownership: 'owner',
      bindingMode: 'existing',
      status: 'available',
    });
    expect(port.seededSessions).toHaveLength(0); // nothing created
    expect((await port.getSession('s_claudio'))?.externalRef).toBe('agenthub:specialist:dev');
    expect(store.getSpecialistSession('dev')?.sessionId).toBe('s_claudio');
  });

  it('a stopped session binds as offline (state surfaced, not judged)', async () => {
    const store = new MemoryHubStore();
    const port = new FakeSubstrateExecPort();
    port.seedSession({ ...OWNED_SESSION, sessionId: 's_stop', status: 'stopped' });
    const orch = new Orchestrator({
      store,
      adapter: new FakeRuntimeAdapter(port),
      execPort: port,
      agents: new Map([[DEV.id, DEV]]),
    });
    const binding = await orch.bindSpecialistSession('dev', { sessionId: 's_stop' });
    expect(binding.status).toBe('offline');
  });

  it('creates a session on-behalf (ownership owner) when configured', async () => {
    const store = new MemoryHubStore();
    const port = new FakeSubstrateExecPort();
    port.createOnBehalfUserId = 'owner-uuid-1';
    const orch = new Orchestrator({
      store,
      adapter: new FakeRuntimeAdapter(port),
      execPort: port,
      agents: new Map([[DEV.id, DEV]]),
    });
    const binding = await orch.bindSpecialistSession('dev', { sessionTemplateId: 'tpl' });
    expect(binding).toMatchObject({
      bindingMode: 'created',
      ownership: 'owner',
      ownerAccountId: 'owner-uuid-1',
      status: 'available',
    });
    expect(port.seededSessions[0]?.seed.externalRef).toBe('agenthub:specialist:dev');
  });

  it('rejects an unknown session (session_gone) and both-or-neither', async () => {
    const store = new MemoryHubStore();
    const port = new FakeSubstrateExecPort();
    const orch = new Orchestrator({
      store,
      adapter: new FakeRuntimeAdapter(port),
      execPort: port,
      agents: new Map([[DEV.id, DEV]]),
    });
    await expect(orch.bindSpecialistSession('dev', { sessionId: 's_nope' })).rejects.toMatchObject({
      code: 'session_gone',
    });
    await expect(
      orch.bindSpecialistSession('dev', { sessionId: 's', sessionTemplateId: 'tpl' }),
    ).rejects.toThrow(/exactly one/);
    // unknown specialist
    await expect(
      orch.bindSpecialistSession('ghost', { sessionTemplateId: 'tpl' }),
    ).rejects.toBeTruthy();
  });
});

describe('direct specialist conversation (N3b-2, ADR-008)', () => {
  function boundHarness() {
    const store = new MemoryHubStore();
    const port = new FakeSubstrateExecPort();
    port.seedSession({ ...OWNED_SESSION, sessionId: 's_claudio' });
    const orch = new Orchestrator({
      store,
      adapter: new FakeRuntimeAdapter(port),
      execPort: port,
      agents: new Map([[DEV.id, DEV]]),
    });
    return { store, port, orch };
  }

  it('requires a bound session; then creates a project-less direct conversation', async () => {
    const { orch } = boundHarness();
    expect(() => orch.createSpecialistConversation('dev')).toThrow(/no session bound/);
    await orch.bindSpecialistSession('dev', { sessionId: 's_claudio' });
    const conv = orch.createSpecialistConversation('dev', 'chat');
    expect(conv).toMatchObject({ projectId: null, agentId: 'dev', mode: 'direct', title: 'chat' });
  });

  it('a message runs in the specialist session and completes', async () => {
    const { store, port, orch } = boundHarness();
    await orch.bindSpecialistSession('dev', { sessionId: 's_claudio' });
    const conv = orch.createSpecialistConversation('dev');
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    orch.send(conv.id, 'hola');
    await orch.idle();
    const runs = store.listRunsByState(['completed', 'failed']);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.state).toBe('completed');
    // the exec targeted the specialist's session, not any project
    expect(port.execRequests.at(-1)!.sessionId).toBe('s_claudio');
  });

  it('serializes runs per workspace: a specialist queues, does not run two at once (I-2)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = new MemoryHubStore();
    const port = new FakeSubstrateExecPort({ gate: () => gate });
    port.seedSession({ ...OWNED_SESSION, sessionId: 's_claudio' });
    const orch = new Orchestrator({
      store,
      adapter: new FakeRuntimeAdapter(port),
      execPort: port,
      agents: new Map([[DEV.id, DEV]]),
    });
    await orch.bindSpecialistSession('dev', { sessionId: 's_claudio' });
    // two DIFFERENT direct conversations with the same specialist
    const c1 = orch.createSpecialistConversation('dev');
    const c2 = orch.createSpecialistConversation('dev');
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
    orch.send(c1.id, 'one');
    orch.send(c2.id, 'two');
    // one active, one queued — the specialist workspace is serialized
    await new Promise((r) => setTimeout(r, 5));
    const active = store.listRunsByState(['starting', 'streaming']);
    const queued = store.listRunsByState(['queued']);
    expect(active).toHaveLength(1);
    expect(queued).toHaveLength(1);
    release();
    await orch.idle();
    expect(store.listRunsByState(['completed'])).toHaveLength(2);
  });

  it('an offline specialist session fails the run with a clear message (start pending #429)', async () => {
    const { store, port, orch } = boundHarness();
    // bind while running, then the session goes stopped; fake startSession is
    // tolerant (no owner-only 403 offline), but to model the pending-upstream
    // case we mark it gone so start cannot succeed
    await orch.bindSpecialistSession('dev', { sessionId: 's_claudio' });
    const conv = orch.createSpecialistConversation('dev');
    port.markSessionGone('s_claudio');
    port.enqueueFixture({ streamLines: [], exitCode: 0 });
    orch.send(conv.id, 'hi');
    await orch.idle();
    const run = store.listRunsByState(['failed'])[0]!;
    expect(run.state).toBe('failed');
    expect(run.errorCode).toBe('exec_refused');
  });

  it('a transient seam blip during session resolution fails the run instead of wedging the queue (FR-04)', async () => {
    const { store, port, orch } = boundHarness();
    await orch.bindSpecialistSession('dev', { sessionId: 's_claudio' });
    const conv = orch.createSpecialistConversation('dev');
    // Unlike a 404 (getSession → null, handled by fail()) or a start refusal
    // (caught try/catch, also handled), an UNEXPECTED throw from getSession —
    // an HTTP 500, a timeout, ECONNRESET — used to escape resolveRunSession
    // and executeRun's own try/catch entirely: pump()'s `.catch(() => {})`
    // swallowed it while the run stayed `starting` forever. dispatchNextRun
    // treats any `starting`/`streaming` run as the workspace's active run, so
    // that one seam blip wedged the whole specialist's queue (I-2/FR-04)
    // until a process restart. Only the FIRST call throws, so the second run
    // proves resolution recovers and completes normally once the queue moves.
    let calls = 0;
    const originalGetSession = port.getSession.bind(port);
    port.getSession = (sessionId: string): ReturnType<FakeSubstrateExecPort['getSession']> => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('ECONNRESET'));
      return originalGetSession(sessionId);
    };
    port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) }); // consumed by the second run
    const r1 = orch.send(conv.id, 'one').run;
    const r2 = orch.send(conv.id, 'two').run;
    await orch.idle();

    const f1 = store.getRun(r1.id)!;
    expect(f1.state).toBe('failed'); // not wedged in `starting`
    expect(f1.errorCode).toBe('seam_unavailable');
    expect(f1.errorDetail).toContain('ECONNRESET');

    // the queue survived the blip: the second run in the SAME workspace
    // dispatched and ran to completion, not stuck behind the first forever
    const f2 = store.getRun(r2.id)!;
    expect(f2.state).toBe('completed');
  });

  it('a 409/429 during session resolution is exec_refused, not seam_unavailable (08 §6, FR-33)', async () => {
    const { store, port, orch } = boundHarness();
    await orch.bindSpecialistSession('dev', { sessionId: 's_claudio' });
    const conv = orch.createSpecialistConversation('dev');
    // A seam 409/429 (container down / at caps) carries retryable context and
    // is classified exec_refused with the FR-33 session state — the same
    // duck-typing the mid-turn seam catch uses. An unqualified throw (above)
    // stays seam_unavailable; this proves resolution honours the distinction.
    port.getSession = (): ReturnType<FakeSubstrateExecPort['getSession']> =>
      Promise.reject(Object.assign(new Error('session at capacity'), { status: 429 }));
    const run = orch.send(conv.id, 'one').run;
    await orch.idle();

    const finalized = store.getRun(run.id)!;
    expect(finalized.state).toBe('failed');
    expect(finalized.errorCode).toBe('exec_refused');
    expect(finalized.errorDetail).toContain('429');
    expect(finalized.errorDetail).toContain('FR-33');
  });
});
