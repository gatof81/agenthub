/**
 * SessionResolver unit tests (ADR-013) — the extraction's testability win: the
 * where-does-this-run-execute decision is exercised against a FAKE router and
 * the memory store, with no Orchestrator, no adapter, and no turn executed.
 * The resolver returns SIGNALS (session / fail / start-task / steer-task) and
 * never acts on them — that routing stays with the facade and is covered by
 * the autoRouting / taskSupervision.integration suites.
 */

import { describe, expect, it } from 'vitest';
import type { RouterPort } from '../src/domain/ports.js';
import type { Agent, Conversation, RouteProposal, Run } from '../src/domain/types.js';
import { SessionResolver } from '../src/orchestrator/sessionResolver.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { DEV_AGENT } from './apiHarness.js';

const QA_AGENT: Agent = { ...DEV_AGENT, id: 'qa', name: 'QA' };

/** A router that returns a scripted proposal — never a model (ADR-008). */
function routerReturning(proposal: Partial<RouteProposal>): RouterPort {
  return {
    route: () =>
      Promise.resolve({
        specialistId: DEV_AGENT.id,
        workType: 'question',
        confidence: 1,
        reason: 'scripted',
        source: 'fallback',
        ...proposal,
      } as RouteProposal),
  };
}

function makeResolver(router: RouterPort, opts?: { qaSpecialistId?: string | null }) {
  const store = new MemoryHubStore();
  const resolver = new SessionResolver({
    store,
    execPort: new FakeSubstrateExecPort(),
    agents: new Map([
      [DEV_AGENT.id, DEV_AGENT],
      [QA_AGENT.id, QA_AGENT],
    ]),
    router,
    qaSpecialistId: opts?.qaSpecialistId === undefined ? QA_AGENT.id : opts.qaSpecialistId,
  });
  return { store, resolver };
}

/** A ready project (bound session s1) with an automatic conversation and one dispatched run. */
function seedRun(store: MemoryHubStore): { conversation: Conversation; run: Run } {
  const project = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
  store.setProjectSession(project.id, {
    sessionId: 's1',
    lastKnownState: 'ready',
    bindingMode: 'created',
    ownership: 'legacy-technical',
    ownerAccountId: null,
  });
  const conversation = store.createConversation({
    projectId: project.id,
    title: 't',
    agentId: 'dev',
    mode: 'automatic',
  });
  store.sendMessage({
    conversationId: conversation.id,
    content: 'hello',
    caps: DEV_AGENT.defaultCaps,
    policy: DEV_AGENT.allowedTools,
    instructions: DEV_AGENT.instructions,
  });
  const run = store.dispatchNextRun(project.id)!;
  return { conversation: store.getConversation(conversation.id)!, run };
}

describe('SessionResolver (ADR-013, fake router + store, no turn executed)', () => {
  it('question → the selector picks the project session and the ADR-008 decision persists on the run', async () => {
    const { store, resolver } = makeResolver(routerReturning({ workType: 'question' }));
    const { conversation, run } = seedRun(store);
    const target = await resolver.resolve(run, conversation, 'hello');
    expect(target).toEqual({ kind: 'session', sessionId: 's1' });
    const persisted = store.getRun(run.id)!;
    expect(persisted.targetSessionId).toBe('s1');
    expect(persisted.targetDecision?.workspaceStrategy).toBe('project-primary');
  });

  it('task with no active task → start-task seating the CONVERSATION\'S agent (ADR-015), QA never the dev', async () => {
    const { store, resolver } = makeResolver(routerReturning({ workType: 'task', specialistId: 'qa' }));
    const { conversation, run } = seedRun(store);
    const target = await resolver.resolve(run, conversation, 'build X');
    // router proposed the QA specialist; the seat gate reroutes to the
    // conversation's own (implementation-capable) agent
    expect(target).toEqual({ kind: 'start-task', devSpecialistId: 'dev', qaSpecialistId: 'qa' });
  });

  it('task while one is active → steer-task, never a sibling (I-14)', async () => {
    const { store, resolver } = makeResolver(routerReturning({ workType: 'task' }));
    const { conversation, run } = seedRun(store);
    const active = store.createTask({
      projectId: conversation.projectId!,
      sourceConversationId: conversation.id,
      sourceMessageId: run.messageId,
    });
    const target = await resolver.resolve(run, conversation, 'also do Y');
    expect(target).toMatchObject({ kind: 'steer-task', task: { id: active.id } });
  });

  it('task without a QA specialist configured → the envelope never fires (a plain session)', async () => {
    const { store, resolver } = makeResolver(routerReturning({ workType: 'task' }), {
      qaSpecialistId: null,
    });
    const { conversation, run } = seedRun(store);
    const target = await resolver.resolve(run, conversation, 'build X');
    expect(target).toEqual({ kind: 'session', sessionId: 's1' });
  });

  it('direct conversation with an unbound specialist → a fail signal, not a throw', async () => {
    const { store, resolver } = makeResolver(routerReturning({}));
    const conversation = store.createConversation({
      projectId: null,
      title: 't',
      agentId: 'dev',
      mode: 'direct',
    });
    store.sendMessage({
      conversationId: conversation.id,
      content: 'hi',
      caps: DEV_AGENT.defaultCaps,
      policy: DEV_AGENT.allowedTools,
      instructions: DEV_AGENT.instructions,
    });
    const run = store.dispatchNextRun(`specialist:${DEV_AGENT.id}`)!;
    const target = await resolver.resolve(run, store.getConversation(conversation.id)!, 'hi');
    expect(target).toMatchObject({ kind: 'fail', detail: expect.stringContaining('N3b-1') });
  });
});
