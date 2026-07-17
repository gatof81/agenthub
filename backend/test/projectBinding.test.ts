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
