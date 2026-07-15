/**
 * The HubStore contract suite (13 §2): one suite, every implementation —
 * identical results INCLUDING guarded-update rejections (I-2/I-3). New store
 * behavior lands here first; both implementations must pass unchanged.
 */

import { describe, expect, it } from 'vitest';
import { IllegalTransitionError, StaleStateError } from '../src/domain/runStateMachine.js';
import type { Caps, RunSummary } from '../src/domain/types.js';
import {
  NotFoundError,
  PAYLOAD_CAP_BYTES,
  ValidationError,
  type HubStore,
  type NewRunEvent,
} from '../src/store/types.js';

const CAPS: Caps = { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 };
const POLICY = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'];

function summaryFor(runId: string, outcome: RunSummary['outcome']): RunSummary {
  return {
    runId,
    objective: 'test objective',
    outcome,
    filesTouched: [],
    commandsRun: [],
    denialCount: 0,
    warnings: [],
    costUsd: null,
    numTurns: null,
    durationMs: null,
    runtimeSessionId: null,
  };
}

function ev(id: string, seq: number, type: NewRunEvent['type'], payload: unknown): NewRunEvent {
  return { id, seq, type, payload, ts: '2026-07-15T00:00:00.000Z' };
}

/** Creates project→conversation→queued run, returns the trio. */
function seedRun(store: HubStore) {
  const project = store.createProject({ name: 'p', defaultAgentId: 'dev' });
  const conv = store.createConversation({ projectId: project.id, title: 't', agentId: 'dev' });
  const { message, run } = store.sendMessage({
    conversationId: conv.id,
    content: 'hello',
    caps: CAPS,
    policy: POLICY,
  });
  return { project, conv, message, run };
}

export function storeContractSuite(name: string, makeStore: () => HubStore): void {
  describe(`HubStore contract — ${name}`, () => {
    // — projects & conversations —

    it('creates a project in provisioning status with an empty session binding (UC-01)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'agent hub', defaultAgentId: 'dev' });
      expect(p.status).toBe('provisioning');
      expect(p.sessionBinding).toEqual({ sessionId: null, templateId: null, lastKnownState: null });
      expect(store.getProject(p.id)?.name).toBe('agent hub');
      store.close();
    });

    it('archived projects are filtered by default (08 §1)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev' });
      store.updateProject(p.id, { status: 'archived' });
      expect(store.listProjects().map((x) => x.id)).not.toContain(p.id);
      expect(store.listProjects({ includeArchived: true }).map((x) => x.id)).toContain(p.id);
      store.close();
    });

    it('updates the session binding partially', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev' });
      store.setProjectSession(p.id, { sessionId: 'sess_1', templateId: 'tpl_1' });
      const after = store.setProjectSession(p.id, { lastKnownState: 'running' });
      expect(after.sessionBinding).toEqual({
        sessionId: 'sess_1',
        templateId: 'tpl_1',
        lastKnownState: 'running',
      });
      store.close();
    });

    it('conversations require an existing project and expose no agentId/projectId update path (I-6/I-10)', () => {
      const store = makeStore();
      expect(() =>
        store.createConversation({ projectId: 'proj_missing', title: 't', agentId: 'dev' }),
      ).toThrow(NotFoundError);
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev' });
      const c = store.createConversation({ projectId: p.id, title: 't', agentId: 'dev' });
      const renamed = store.updateConversation(c.id, { title: 'renamed' });
      expect(renamed.agentId).toBe('dev');
      expect(renamed.projectId).toBe(p.id);
      store.close();
    });

    // — sendMessage (09 §3 tx) —

    it('sendMessage creates the linked user message + queued run in one operation (I-1)', () => {
      const store = makeStore();
      const { message, run } = seedRun(store);
      expect(message.role).toBe('user');
      expect(message.runId).toBe(run.id);
      expect(run.messageId).toBe(message.id);
      expect(run.state).toBe('queued');
      expect(run.capsSnapshot).toEqual(CAPS);
      expect(run.policySnapshot).toEqual(POLICY);
      expect(store.getRunByMessage(message.id)?.id).toBe(run.id);
      store.close();
    });

    it('rejects an empty allowlist — a run without an explicit policy is unrepresentable (I-7)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev' });
      const c = store.createConversation({ projectId: p.id, title: 't', agentId: 'dev' });
      expect(() =>
        store.sendMessage({ conversationId: c.id, content: 'x', caps: CAPS, policy: [] }),
      ).toThrow(ValidationError);
      expect(() =>
        store.sendMessage({ conversationId: c.id, content: 'x', caps: CAPS, policy: [' '] }),
      ).toThrow(ValidationError);
      store.close();
    });

    it('rejects non-positive caps (FR-17 hard limits from day 1)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev' });
      const c = store.createConversation({ projectId: p.id, title: 't', agentId: 'dev' });
      expect(() =>
        store.sendMessage({
          conversationId: c.id,
          content: 'x',
          caps: { maxTurns: 0, budgetUsd: 1, timeoutMs: 1 },
          policy: POLICY,
        }),
      ).toThrow(ValidationError);
      store.close();
    });

    it('caps oversized message content with a truncation marker (09 §6)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev' });
      const c = store.createConversation({ projectId: p.id, title: 't', agentId: 'dev' });
      const { message } = store.sendMessage({
        conversationId: c.id,
        content: 'x'.repeat(300 * 1024),
        caps: CAPS,
        policy: POLICY,
      });
      expect(message.content.length).toBeLessThan(300 * 1024);
      expect(message.content).toContain('[truncated: original');
      store.close();
    });

    // — dispatch & serialization (I-2, FR-04/19) —

    it('dispatches FIFO per project and refuses a second active run (I-2)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev' });
      const c1 = store.createConversation({ projectId: p.id, title: 'a', agentId: 'dev' });
      const c2 = store.createConversation({ projectId: p.id, title: 'b', agentId: 'dev' });
      const r1 = store.sendMessage({ conversationId: c1.id, content: '1', caps: CAPS, policy: POLICY }).run;
      const r2 = store.sendMessage({ conversationId: c2.id, content: '2', caps: CAPS, policy: POLICY }).run;

      const first = store.dispatchNextRun(p.id);
      expect(first?.id).toBe(r1.id);
      expect(first?.state).toBe('starting');
      // second conversation of the SAME project must not dispatch while one is active
      expect(store.dispatchNextRun(p.id)).toBeUndefined();
      expect(store.getActiveRun(p.id)?.id).toBe(r1.id);
      expect(store.getQueuedRuns(p.id).map((r) => r.id)).toEqual([r2.id]);

      // finalize the first → the queue survives and dispatches in order (FR-04)
      store.transitionRun(r1.id, 'starting', 'streaming');
      store.finalizeRun({
        runId: r1.id,
        from: 'streaming',
        to: 'completed',
        assistantContent: 'done',
        usage: { totalCostUsd: 0.01, numTurns: 1, usage: null, source: 'result-event' },
        summary: summaryFor(r1.id, 'completed'),
      });
      expect(store.dispatchNextRun(p.id)?.id).toBe(r2.id);
      store.close();
    });

    it('projects do not serialize against each other', () => {
      const store = makeStore();
      const a = seedRun(store);
      const b = seedRun(store);
      expect(store.dispatchNextRun(a.project.id)?.id).toBe(a.run.id);
      expect(store.dispatchNextRun(b.project.id)?.id).toBe(b.run.id);
      store.close();
    });

    // — guarded transitions (I-3) —

    it('walks the happy path with handles and stamps startedAt at streaming (UC-02)', () => {
      const store = makeStore();
      const { project, run } = seedRun(store);
      store.dispatchNextRun(project.id);
      const streaming = store.transitionRun(run.id, 'starting', 'streaming', {
        execId: 'exec_1',
        pgid: 42,
        seamRequestId: 'req_1',
      });
      expect(streaming.state).toBe('streaming');
      expect(streaming.execId).toBe('exec_1');
      expect(streaming.pgid).toBe(42);
      expect(streaming.seamRequestId).toBe('req_1');
      expect(streaming.startedAt).not.toBeNull();
      store.close();
    });

    it('rejects illegal transitions identically (I-3)', () => {
      const store = makeStore();
      const { run } = seedRun(store);
      expect(() => store.transitionRun(run.id, 'queued', 'streaming')).toThrow(
        IllegalTransitionError,
      );
      store.close();
    });

    it('rejects stale expected states loudly (guarded update, 09 §2)', () => {
      const store = makeStore();
      const { project, run } = seedRun(store);
      store.dispatchNextRun(project.id); // now 'starting'
      expect(() => store.transitionRun(run.id, 'queued', 'starting')).toThrow(StaleStateError);
      store.close();
    });

    it('refuses terminal targets outside finalizeRun', () => {
      const store = makeStore();
      const { run } = seedRun(store);
      expect(() => store.transitionRun(run.id, 'queued', 'cancelled')).toThrow(ValidationError);
      store.close();
    });

    // — finalize (I-5, I-11) —

    it('finalize writes state + assistant message + usage + summary atomically', () => {
      const store = makeStore();
      const { project, conv, run } = seedRun(store);
      store.dispatchNextRun(project.id);
      store.transitionRun(run.id, 'starting', 'streaming');
      const done = store.finalizeRun({
        runId: run.id,
        from: 'streaming',
        to: 'completed',
        assistantContent: 'the answer',
        usage: { totalCostUsd: 0.05, numTurns: 3, usage: { output_tokens: 10 }, source: 'result-event' },
        summary: summaryFor(run.id, 'completed'),
      });
      expect(done.state).toBe('completed');
      expect(done.endedAt).not.toBeNull();
      expect(store.getUsage(run.id)).toMatchObject({ totalCostUsd: 0.05, numTurns: 3, source: 'result-event' });
      expect(store.getSummary(run.id)?.outcome).toBe('completed');
      const msgs = store.listMessages(conv.id);
      expect(msgs.at(-1)).toMatchObject({ role: 'assistant', content: 'the answer', runId: run.id });
      store.close();
    });

    it('cancelling a queued run is a legal finalize; usage is unknown (FR-18/20)', () => {
      const store = makeStore();
      const { run } = seedRun(store);
      const cancelled = store.finalizeRun({
        runId: run.id,
        from: 'queued',
        to: 'cancelled',
        usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'cancelled-unknown' },
        summary: summaryFor(run.id, 'cancelled'),
      });
      expect(cancelled.state).toBe('cancelled');
      expect(store.getUsage(run.id)?.source).toBe('cancelled-unknown');
      expect(store.getUsage(run.id)?.totalCostUsd).toBeNull();
      expect(store.getSummary(run.id)).toBeDefined();
      store.close();
    });

    it('records killOutcome and sweepResult on cancelled runs (FR-20/21)', () => {
      const store = makeStore();
      const { project, run } = seedRun(store);
      store.dispatchNextRun(project.id);
      store.transitionRun(run.id, 'starting', 'streaming');
      const cancelled = store.finalizeRun({
        runId: run.id,
        from: 'streaming',
        to: 'cancelled',
        killOutcome: 'terminated',
        sweepResult: { scanned: 12, killed: ['4242'], survivors: [] },
        usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'cancelled-unknown' },
        summary: summaryFor(run.id, 'cancelled'),
      });
      expect(cancelled.killOutcome).toBe('terminated');
      expect(cancelled.sweepResult).toEqual({ scanned: 12, killed: ['4242'], survivors: [] });
      store.close();
    });

    it('a second finalize is a stale-state rejection (terminal states are final)', () => {
      const store = makeStore();
      const { run } = seedRun(store);
      store.finalizeRun({
        runId: run.id,
        from: 'queued',
        to: 'cancelled',
        usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'cancelled-unknown' },
        summary: summaryFor(run.id, 'cancelled'),
      });
      expect(() =>
        store.finalizeRun({
          runId: run.id,
          from: 'queued',
          to: 'cancelled',
          usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'cancelled-unknown' },
          summary: summaryFor(run.id, 'cancelled'),
        }),
      ).toThrow(StaleStateError);
      store.close();
    });

    // — init meta (I-8) —

    it('cliVersion/model are write-once with idempotent re-writes (I-8)', () => {
      const store = makeStore();
      const { run } = seedRun(store);
      store.setRunInitMeta(run.id, { cliVersion: '2.1.207', model: 'claude-sonnet-5' });
      expect(store.getRun(run.id)).toMatchObject({ cliVersion: '2.1.207', model: 'claude-sonnet-5' });
      // idempotent same-value (re-ingestion of the same init event)
      store.setRunInitMeta(run.id, { cliVersion: '2.1.207', model: 'claude-sonnet-5' });
      // different value = audit-trail violation
      expect(() => store.setRunInitMeta(run.id, { cliVersion: '9.9.9', model: 'other' })).toThrow(
        ValidationError,
      );
      store.close();
    });

    // — events (I-4, 08 §2) —

    it('ingestion is idempotent by id: replaying a batch twice changes nothing (13 §4)', () => {
      const store = makeStore();
      const { run } = seedRun(store);
      const batch = [
        ev('ev_1', 1, 'started', { execId: 'exec_1' }),
        ev('ev_2', 2, 'output', { text: 'hi' }),
        ev('ev_3', 3, 'tool_use', { name: 'Bash', input: { command: 'ls' } }),
      ];
      expect(store.ingestEvents(run.id, batch).inserted).toBe(3);
      expect(store.ingestEvents(run.id, batch).inserted).toBe(0);
      expect(store.getEvents(run.id)).toHaveLength(3);
      store.close();
    });

    it('a different id claiming an existing (runId, seq) is rejected (I-4)', () => {
      const store = makeStore();
      const { run } = seedRun(store);
      store.ingestEvents(run.id, [ev('ev_1', 1, 'output', { text: 'a' })]);
      expect(() => store.ingestEvents(run.id, [ev('ev_other', 1, 'output', { text: 'b' })])).toThrow(
        ValidationError,
      );
      store.close();
    });

    it('events come back in seq order with parsed payloads', () => {
      const store = makeStore();
      const { run } = seedRun(store);
      store.ingestEvents(run.id, [ev('ev_2', 2, 'output', { text: 'b' })]);
      store.ingestEvents(run.id, [ev('ev_1', 1, 'output', { text: 'a' })]);
      const events = store.getEvents(run.id);
      expect(events.map((e) => e.seq)).toEqual([1, 2]);
      expect(events[0]!.payload).toEqual({ text: 'a' });
      store.close();
    });

    it('oversized payloads are truncated at ingestion with the 08 §2 marker', () => {
      const store = makeStore();
      const { run } = seedRun(store);
      const big = 'x'.repeat(PAYLOAD_CAP_BYTES + 1024);
      store.ingestEvents(run.id, [ev('ev_big', 1, 'output', { text: big })]);
      const stored = store.getEvents(run.id)[0]!.payload as {
        truncated: boolean;
        originalBytes: number;
        head: string;
      };
      expect(stored.truncated).toBe(true);
      expect(stored.originalBytes).toBeGreaterThan(PAYLOAD_CAP_BYTES);
      expect(stored.head.length).toBeGreaterThan(0);
      store.close();
    });

    it('the sse cursor counts only replayable rows (08 §3, 09 §sse_cursor)', () => {
      const store = makeStore();
      const { conv, run } = seedRun(store);
      expect(store.getSseCursor(conv.id)).toBe(0);
      store.ingestEvents(run.id, [
        ev('ev_1', 1, 'started', {}), // not replayable
        ev('ev_2', 2, 'output', { text: 'a' }), // replayable
        ev('ev_3', 3, 'tool_use', { name: 'Bash', input: { command: 'ls' } }), // replayable
        ev('ev_4', 4, 'permission_denial', { tool: 'WebFetch' }), // replayable
        ev('ev_5', 5, 'exit', { code: 0 }), // not replayable
      ]);
      expect(store.getSseCursor(conv.id)).toBe(3);
      // re-ingestion must not double-count
      store.ingestEvents(run.id, [ev('ev_2', 2, 'output', { text: 'a' })]);
      expect(store.getSseCursor(conv.id)).toBe(3);
      store.close();
    });

    it('replayable events carry stable conversation-wide indices for Last-Event-ID (ADR-004)', () => {
      const store = makeStore();
      const { project, conv, run } = seedRun(store);
      store.ingestEvents(run.id, [
        ev('ev_1', 1, 'started', {}),
        ev('ev_2', 2, 'output', { text: 'a' }),
        ev('ev_3', 3, 'tool_use', { name: 'Bash', input: { command: 'ls' } }),
      ]);
      // a second run in the same conversation continues the ordering
      store.dispatchNextRun(project.id);
      store.transitionRun(run.id, 'starting', 'streaming');
      store.finalizeRun({
        runId: run.id,
        from: 'streaming',
        to: 'completed',
        usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'error-partial' },
        summary: summaryFor(run.id, 'completed'),
      });
      const second = store.sendMessage({
        conversationId: conv.id,
        content: 'again',
        caps: CAPS,
        policy: POLICY,
      }).run;
      store.ingestEvents(second.id, [ev('ev_b1', 1, 'output', { text: 'b' })]);

      const all = store.getReplayableEvents(conv.id);
      expect(all.map((r) => r.event.id)).toEqual(['ev_2', 'ev_3', 'ev_b1']);
      expect(all.map((r) => r.index)).toEqual([0, 1, 2]);
      expect(store.getReplayableEvents(conv.id, 1).map((r) => r.event.id)).toEqual(['ev_b1']);
      store.close();
    });

    // — messages paging —

    it('pages messages backwards with before/limit (08 §1)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev' });
      const c = store.createConversation({ projectId: p.id, title: 't', agentId: 'dev' });
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const { message, run } = store.sendMessage({
          conversationId: c.id,
          content: `m${i}`,
          caps: CAPS,
          policy: POLICY,
        });
        ids.push(message.id);
        store.finalizeRun({
          runId: run.id,
          from: 'queued',
          to: 'cancelled',
          usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'cancelled-unknown' },
          summary: summaryFor(run.id, 'cancelled'),
        });
      }
      const lastTwo = store.listMessages(c.id, { limit: 2 });
      expect(lastTwo.map((m) => m.content)).toEqual(['m3', 'm4']);
      const beforeThat = store.listMessages(c.id, { before: ids[3]!, limit: 2 });
      expect(beforeThat.map((m) => m.content)).toEqual(['m1', 'm2']);
      store.close();
    });
  });
}
