/**
 * ProvisioningService unit tests (ADR-013) — the extraction's testability win:
 * the provisioning zone is exercised against NARROW fakes (memory store, the
 * fake exec port, the fake adapter) with no Orchestrator and no run-loop
 * machinery constructed at all. Behavior is unchanged (structure-only
 * extraction); the end-to-end lifecycle flows stay covered through the facade
 * by projectBinding / repoInProject / restore / reconciler suites.
 */

import { describe, expect, it } from 'vitest';
import type { Agent } from '../src/domain/types.js';
import { ProvisioningService } from '../src/orchestrator/provisioningService.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { DEV_AGENT } from './apiHarness.js';

function makeService() {
  const store = new MemoryHubStore();
  const port = new FakeSubstrateExecPort();
  const adapter = new FakeRuntimeAdapter(port);
  const agents = new Map<string, Agent>([[DEV_AGENT.id, DEV_AGENT]]);
  const events: Array<{ projectId: string; state: string }> = [];
  const service = new ProvisioningService({
    store,
    adapter,
    execPort: port,
    agents,
    notify: {
      projectState: (projectId, state) => events.push({ projectId, state }),
      runState: () => {},
      replayable: () => {},
      usage: () => {},
      summary: () => {},
    },
  });
  return { store, port, service, events };
}

describe('ProvisioningService (ADR-013, narrow fakes only)', () => {
  it('createProject validates the agent and the template/bind exclusivity', async () => {
    const { service } = makeService();
    expect(() =>
      service.createProject({ name: 'p', defaultAgentId: 'ghost', sessionTemplateId: 'tpl' }),
    ).toThrowError(/not configured/);
    expect(() =>
      service.createProject({
        name: 'p',
        defaultAgentId: 'dev',
        sessionTemplateId: 'tpl',
        existingSessionId: 's1',
      }),
    ).toThrowError(/exactly one/);
    // settle the (zero) in-flight work — pending() drains for idle()
    await Promise.all(service.pending());
  });

  it('provisions a project to ready, tracking the in-flight promise via pending()', async () => {
    const { store, service, events } = makeService();
    const project = service.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    expect(project.status).toBe('provisioning'); // the API's 202 shape (UC-01)
    expect(service.pending()).toHaveLength(1);
    await Promise.all(service.pending());
    expect(store.getProject(project.id)!.status).toBe('ready');
    expect(events).toContainEqual({ projectId: project.id, state: 'ready' });
    expect(service.pending()).toHaveLength(0);
  });

  it('reconcileProvisioning heals a mid-provisioning project to error (B3-02)', () => {
    const { store, service, events } = makeService();
    const stuck = store.createProject({ name: 'stuck', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    const ready = store.createProject({ name: 'ok', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    store.updateProject(ready.id, { status: 'ready' });
    service.reconcileProvisioning();
    expect(store.getProject(stuck.id)!.status).toBe('error');
    expect(store.getProject(ready.id)!.status).toBe('ready');
    expect(events).toEqual([{ projectId: stuck.id, state: 'error' }]);
  });

  it('restoreConversation enforces I-12: rejected while its project is archived', () => {
    const { store, service } = makeService();
    const project = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
    const conversation = store.createConversation({
      projectId: project.id,
      title: 't',
      agentId: 'dev',
      mode: 'automatic',
    });
    store.updateConversation(conversation.id, { status: 'archived' });
    store.updateProject(project.id, { status: 'archived' });
    expect(() => service.restoreConversation(conversation.id)).toThrowError(/I-12/);
    store.updateProject(project.id, { status: 'ready' });
    expect(service.restoreConversation(conversation.id).status).toBe('active');
  });
});
