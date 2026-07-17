/**
 * B5-02/03: the project's repo reaches the seam, and its credential reaches
 * ONLY the seam (FR-45/46/47, SEC-11, ADR-006).
 *
 * The credential half is the reason this file exists. SEC-11 is the Hub's
 * first capability to write to the owner's source, and its whole mitigation
 * is "the Hub never holds the PAT" — a claim that is worthless unless
 * something checks it. So the canary below scans the actual persisted bytes,
 * in the 13 §5 style, rather than trusting that no code path writes it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../src/domain/types.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { SqliteHubStore } from '../src/store/sqlite.js';
import type { HubStore } from '../src/store/types.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';

const AGENT: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'dev',
  allowedTools: ['Read'],
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 2, timeoutMs: 60_000 },
};

/** An obviously-fake credential shape; the canary hunts for this exact string. */
const CANARY_PAT = 'ghp_CANARY_must_never_be_persisted_0000';

function harness(store: HubStore = new MemoryHubStore()) {
  const port = new FakeSubstrateExecPort();
  const orch = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    agents: new Map([[AGENT.id, AGENT]]),
  });
  return { store, port, orch };
}

describe('the project declares its workspace (ADR-006, FR-45)', () => {
  it("provisions from the PROJECT's template, not the agent's", async () => {
    const { port, orch } = harness();
    orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl-project' });
    await orch.idle();
    // the agent has no template to fall back to — that is the point of ADR-006
    expect(port.seededSessions[0]!.templateId).toBe('tpl-project');
  });

  it('two projects on ONE agent get their own workspaces', async () => {
    // the owner's actual case: one DEV-Agent, two repositories
    const { port, orch } = harness();
    orch.createProject({
      name: 'home-automation',
      defaultAgentId: 'dev',
      sessionTemplateId: 'tpl',
      repo: { url: 'https://github.com/o/home-automation' },
    });
    await orch.idle();
    orch.createProject({
      name: 'shared-terminal',
      defaultAgentId: 'dev',
      sessionTemplateId: 'tpl',
      repo: { url: 'https://github.com/o/shared-terminal' },
    });
    await orch.idle();
    expect(port.seededSessions.map((s) => s.seed.repo?.url)).toEqual([
      'https://github.com/o/home-automation',
      'https://github.com/o/shared-terminal',
    ]);
  });

  it('a legacy project with no template fails loudly — never a blank template to the seam', async () => {
    // Only pre-ADR-006 rows that never provisioned can be null (migration 002
    // backfills the rest). A `?? ''` fallback used to send a blank template to
    // the seam and let it fail there, with nothing saying the Hub meant to.
    const { store, port, orch } = harness();
    const p = store.createProject({ name: 'legacy', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    const legacy = { ...store.getProject(p.id)!, sessionTemplateId: null };
    const orchAny = orch as unknown as {
      provision: (pr: unknown, a: unknown, i: string, r: null) => Promise<void>;
    };
    await orchAny.provision(legacy, AGENT, '', null);
    expect(port.seededSessions).toHaveLength(0); // nothing dispatched
    expect(store.getProject(p.id)!.status).toBe('error');
  });

  it('a project without a repo provisions an empty workspace, exactly as before', async () => {
    const { port, orch } = harness();
    orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    await orch.idle();
    expect(port.seededSessions[0]!.seed.repo).toBeUndefined();
  });
});

describe('the repo credential reaches the seam and nowhere else (FR-47, SEC-11)', () => {
  it('the PAT is handed to the seam', async () => {
    const { port, orch } = harness();
    orch.createProject({
      name: 'p',
      defaultAgentId: 'dev',
      sessionTemplateId: 'tpl',
      repo: { url: 'https://github.com/o/r' },
      repoAuth: { kind: 'pat', pat: CANARY_PAT },
    });
    await orch.idle();
    expect(port.seededSessions[0]!.seed.repoAuth).toEqual({ kind: 'pat', pat: CANARY_PAT });
  });

  it('the PAT is NOT stored on the project', async () => {
    const { store, orch } = harness();
    const p = orch.createProject({
      name: 'p',
      defaultAgentId: 'dev',
      sessionTemplateId: 'tpl',
      repo: { url: 'https://github.com/o/r' },
      repoAuth: { kind: 'pat', pat: CANARY_PAT },
    });
    await orch.idle();
    const stored = store.getProject(p.id)!;
    expect(stored.repo).toEqual({ url: 'https://github.com/o/r' }); // metadata only
    expect(JSON.stringify(stored)).not.toContain(CANARY_PAT);
  });

  it('the PAT never reaches the database FILE — the bytes, not the API (SEC-11 canary)', async () => {
    // SEC-11's mitigation is "the Hub never holds it". Asserting that through
    // the store's own API only proves the API hides it; this reads the disk.
    const dir = mkdtempSync(join(tmpdir(), 'hub-sec11-'));
    const dbPath = join(dir, 'hub.sqlite');
    try {
      const store = new SqliteHubStore(dbPath);
      const { orch } = harness(store);
      orch.createProject({
        name: 'p',
        defaultAgentId: 'dev',
        sessionTemplateId: 'tpl',
        repo: { url: 'https://github.com/o/r' },
        repoAuth: { kind: 'pat', pat: CANARY_PAT },
      });
      await orch.idle();
      store.close();
      const raw = readFileSync(dbPath).toString('latin1');
      expect(raw).not.toContain(CANARY_PAT);
      expect(raw).toContain('https://github.com/o/r'); // the metadata IS stored
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
