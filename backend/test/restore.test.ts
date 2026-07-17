/**
 * B4-01/02: restore archived projects and conversations (FR-43/44, I-12,
 * UC-11). Offline via the fake port, which can mark a session "gone" the way
 * a hard delete leaves it upstream — the FR-44 branch is only testable if the
 * fake can produce the real port's 404 → SessionGoneError translation.
 */

import { describe, expect, it } from 'vitest';
import { SessionGoneError } from '../src/domain/ports.js';
import type { Agent } from '../src/domain/types.js';
import { Orchestrator, OrchestratorError } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';

const AGENT: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'dev',
  allowedTools: ['Read'],
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 2, timeoutMs: 60_000 },
};

async function harness() {
  const store = new MemoryHubStore();
  const port = new FakeSubstrateExecPort();
  const orch = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    agents: new Map([[AGENT.id, AGENT]]),
  });
  const project = orch.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
  await orch.idle();
  return { store, port, orch, projectId: project.id };
}

describe('restore a project (FR-43)', () => {
  it('restarts the SAME session — the workspace and its transcripts survive', async () => {
    const { store, port, orch, projectId } = await harness();
    const sessionId = store.getProject(projectId)!.sessionBinding.sessionId!;

    await orch.archiveProject(projectId);
    expect(store.getProject(projectId)!.status).toBe('archived');
    expect(port.stoppedSessions).toEqual([sessionId]);

    const restored = await orch.restoreProject(projectId);
    expect(restored.status).toBe('ready');
    // the same id, not a new one: restore must never re-provision (FR-44's
    // whole point), because a fresh session would be a fresh empty workspace
    expect(port.startedSessions).toEqual([sessionId]);
    expect(restored.sessionBinding.sessionId).toBe(sessionId);
    expect(restored.sessionBinding.lastKnownState).toBe('ready');
  });

  it('a restored project takes a turn again', async () => {
    const { orch, projectId } = await harness();
    await orch.archiveProject(projectId);
    await orch.restoreProject(projectId);
    // send() rejects unless the project is ready (08 §1) — the real proof
    // that restore returned it to a usable state, not just a green label
    const conversation = orch.createConversation({ projectId });
    expect(() => orch.send(conversation.id, 'hello')).not.toThrow();
  });

  it('is idempotent — restoring a ready project is a no-op', async () => {
    const { port, orch, projectId } = await harness();
    const again = await orch.restoreProject(projectId);
    expect(again.status).toBe('ready');
    expect(port.startedSessions).toEqual([]); // never touched the seam
  });
});

describe('restore when the session is gone (FR-44)', () => {
  it('fails with session_gone and leaves the project ARCHIVED', async () => {
    const { store, port, orch, projectId } = await harness();
    const sessionId = store.getProject(projectId)!.sessionBinding.sessionId!;
    await orch.archiveProject(projectId);
    port.markSessionGone(sessionId); // hard-deleted upstream, workspace purged

    await expect(orch.restoreProject(projectId)).rejects.toMatchObject({
      name: 'OrchestratorError',
      code: 'session_gone',
    });
    // the load-bearing assertion: it did NOT come back as a ready project
    // wearing the old name over an empty workspace
    expect(store.getProject(projectId)!.status).toBe('archived');
    expect(store.getProject(projectId)!.sessionBinding.sessionId).toBe(sessionId);
  });

  it('translates the port error rather than leaking it to the API', async () => {
    // the API depends on the orchestrator, not the substrate (07 §2), so it
    // must never have to catch SessionGoneError itself
    const { store, port, orch, projectId } = await harness();
    port.markSessionGone(store.getProject(projectId)!.sessionBinding.sessionId!);
    await orch.archiveProject(projectId);
    const err = await orch.restoreProject(projectId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrchestratorError);
    expect(err).not.toBeInstanceOf(SessionGoneError);
  });

  it('a transient seam failure is NOT swallowed and NOT mistaken for session_gone', async () => {
    const { orch, projectId } = await harness();
    await orch.archiveProject(projectId);
    const orchAny = orch as unknown as { execPort: { startSession: () => Promise<void> } };
    orchAny.execPort.startSession = () => Promise.reject(new Error('ECONNREFUSED'));
    // retryable: it must surface as itself, not as the permanent verdict
    await expect(orch.restoreProject(projectId)).rejects.toThrow('ECONNREFUSED');
  });
});

describe('restore a conversation (FR-43, I-12)', () => {
  it('restores it when its project is live', async () => {
    const { store, orch, projectId } = await harness();
    const conversation = orch.createConversation({ projectId });
    store.updateConversation(conversation.id, { status: 'archived' });

    const restored = orch.restoreConversation(conversation.id);
    expect(restored.status).toBe('active');
  });

  it('refuses while the project is archived — that state could not take a turn (I-12)', async () => {
    const { store, orch, projectId } = await harness();
    const conversation = orch.createConversation({ projectId });
    store.updateConversation(conversation.id, { status: 'archived' });
    await orch.archiveProject(projectId);

    expect(() => orch.restoreConversation(conversation.id)).toThrow(OrchestratorError);
    try {
      orch.restoreConversation(conversation.id);
    } catch (e) {
      expect((e as OrchestratorError).code).toBe('project_archived');
    }
    expect(store.getConversation(conversation.id)!.status).toBe('archived');
  });
});
