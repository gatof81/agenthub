/**
 * The HubStore contract suite (13 §2): one suite, every implementation —
 * identical results INCLUDING guarded-update rejections (I-2/I-3). New store
 * behavior lands here first; both implementations must pass unchanged.
 */

import { describe, expect, it } from 'vitest';
import { IllegalTransitionError, StaleStateError } from '../src/domain/runStateMachine.js';
import {
  IllegalTaskTransitionError,
  StaleTaskStateError,
} from '../src/domain/taskStateMachine.js';
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
const INSTRUCTIONS = 'You are DEV. Write the code.';

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
  const project = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
  const conv = store.createConversation({ projectId: project.id, title: 't', agentId: 'dev' });
  const { message, run } = store.sendMessage({
    conversationId: conv.id,
    content: 'hello',
    caps: CAPS,
    policy: POLICY,
    instructions: INSTRUCTIONS,
  });
  return { project, conv, message, run };
}

export function storeContractSuite(name: string, makeStore: () => HubStore): void {
  describe(`HubStore contract — ${name}`, () => {
    // — projects & conversations —

    it('creates a project in provisioning status with an empty session binding (UC-01)', () => {
      const store = makeStore();
      const p = store.createProject({
        name: 'agent hub',
        defaultAgentId: 'dev',
        sessionTemplateId: 'tpl',
        repo: { url: 'https://github.com/o/r', ref: 'main' },
      });
      expect(p.status).toBe('provisioning');
      expect(p.sessionBinding).toEqual({
        sessionId: null,
        templateId: null,
        lastKnownState: null,
        // N2 defaults (migration 004 semantics): a template-created session
        // lives in the Hub's technical account until shared-terminal#420
        bindingMode: 'created',
        ownerAccountId: null,
        ownership: 'legacy-technical',
      });
      // The workspace DECLARATION is present from create; the BINDING is not.
      // Two different questions that once shared a column (ADR-006, migration
      // 002) — asserting both here is what keeps them from being merged again.
      expect(p.sessionTemplateId).toBe('tpl');
      expect(p.repo).toEqual({ url: 'https://github.com/o/r', ref: 'main' });
      // and it must survive a round-trip: on SQLite this is the only cover for
      // the workspace_template_id → sessionTemplateId column mapping, which a
      // typo would otherwise null out with every test still green
      const read = store.getProject(p.id)!;
      expect(read.name).toBe('agent hub');
      expect(read.sessionTemplateId).toBe('tpl');
      expect(read.repo).toEqual({ url: 'https://github.com/o/r', ref: 'main' });
      store.close();
    });

    it('archived projects are filtered by default (08 §1)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      store.updateProject(p.id, { status: 'archived' });
      expect(store.listProjects().map((x) => x.id)).not.toContain(p.id);
      expect(store.listProjects({ includeArchived: true }).map((x) => x.id)).toContain(p.id);
      store.close();
    });

    it('updates the session binding partially', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      store.setProjectSession(p.id, { sessionId: 'sess_1', templateId: 'tpl_1' });
      const after = store.setProjectSession(p.id, { lastKnownState: 'running' });
      expect(after.sessionBinding).toEqual({
        sessionId: 'sess_1',
        templateId: 'tpl_1',
        lastKnownState: 'running',
        bindingMode: 'created',
        ownerAccountId: null,
        ownership: 'legacy-technical',
      });
      store.close();
    });

    it('round-trips an owner binding (N2, FR-49) — the column mapping has no other cover', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: null });
      store.setProjectSession(p.id, {
        sessionId: 's_owned',
        lastKnownState: 'running',
        bindingMode: 'existing',
        ownerAccountId: 'owner-admin',
        ownership: 'owner',
      });
      const read = store.getProject(p.id)!;
      expect(read.sessionBinding).toEqual({
        sessionId: 's_owned',
        templateId: null,
        lastKnownState: 'running',
        bindingMode: 'existing',
        ownerAccountId: 'owner-admin',
        ownership: 'owner',
      });
      store.close();
    });

    it('conversations require an existing project and expose no agentId/projectId update path (I-6/I-10)', () => {
      const store = makeStore();
      expect(() =>
        store.createConversation({ projectId: 'proj_missing', title: 't', agentId: 'dev' }),
      ).toThrow(NotFoundError);
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
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
      // The role is snapshotted alongside caps and policy (B5-04, I-8), and
      // must survive a READ-BACK: on SQLite this is the only cover for the
      // instructions_snapshot → instructionsSnapshot column mapping, which a
      // typo would null out with every other assertion still green (the same
      // trap migration 002 sprang on workspace_template_id).
      expect(run.instructionsSnapshot).toBe(INSTRUCTIONS);
      expect(store.getRun(run.id)!.instructionsSnapshot).toBe(INSTRUCTIONS);
      expect(store.getRunByMessage(message.id)?.id).toBe(run.id);
      store.close();
    });

    it('rejects an empty allowlist — a run without an explicit policy is unrepresentable (I-7)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const c = store.createConversation({ projectId: p.id, title: 't', agentId: 'dev' });
      expect(() =>
        store.sendMessage({
          conversationId: c.id,
          content: 'x',
          caps: CAPS,
          policy: [],
          instructions: INSTRUCTIONS,
        }),
      ).toThrow(ValidationError);
      expect(() =>
        store.sendMessage({
          conversationId: c.id,
          content: 'x',
          caps: CAPS,
          policy: [' '],
          instructions: INSTRUCTIONS,
        }),
      ).toThrow(ValidationError);
      store.close();
    });

    it('rejects non-positive caps (FR-17 hard limits from day 1)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const c = store.createConversation({ projectId: p.id, title: 't', agentId: 'dev' });
      expect(() =>
        store.sendMessage({
          conversationId: c.id,
          content: 'x',
          caps: { maxTurns: 0, budgetUsd: 1, timeoutMs: 1 },
          policy: POLICY,
          instructions: INSTRUCTIONS,
        }),
      ).toThrow(ValidationError);
      store.close();
    });

    it('accepts a null budget (no cap, off by default, ADR-003); rejects a negative one', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const c = store.createConversation({ projectId: p.id, title: 't', agentId: 'dev' });
      const { run } = store.sendMessage({
        conversationId: c.id,
        content: 'x',
        caps: { maxTurns: 10, budgetUsd: null, timeoutMs: 1000 },
        policy: POLICY,
        instructions: INSTRUCTIONS,
      });
      expect(run.capsSnapshot.budgetUsd).toBeNull(); // round-trips as "no cap"
      // a provided budget must still be positive
      expect(() =>
        store.sendMessage({
          conversationId: c.id,
          content: 'x',
          caps: { maxTurns: 10, budgetUsd: -1, timeoutMs: 1000 },
          policy: POLICY,
          instructions: INSTRUCTIONS,
        }),
      ).toThrow(ValidationError);
      store.close();
    });

    it('caps oversized message content with a truncation marker (09 §6)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const c = store.createConversation({ projectId: p.id, title: 't', agentId: 'dev' });
      const { message } = store.sendMessage({
        conversationId: c.id,
        content: 'x'.repeat(300 * 1024),
        caps: CAPS,
        policy: POLICY,
        instructions: INSTRUCTIONS,
      });
      expect(message.content.length).toBeLessThan(300 * 1024);
      expect(message.content).toContain('[truncated: original');
      store.close();
    });

    // — dispatch & serialization (I-2, FR-04/19) —

    it('dispatches FIFO per project and refuses a second active run (I-2)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const c1 = store.createConversation({ projectId: p.id, title: 'a', agentId: 'dev' });
      const c2 = store.createConversation({ projectId: p.id, title: 'b', agentId: 'dev' });
      const send = (conversationId: string, content: string) =>
        store.sendMessage({ conversationId, content, caps: CAPS, policy: POLICY, instructions: INSTRUCTIONS }).run;
      const r1 = send(c1.id, '1');
      const r2 = send(c2.id, '2');

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
        sweepResult: { matched: 12, killed: ['4242'], survivors: [] },
        usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'cancelled-unknown' },
        summary: summaryFor(run.id, 'cancelled'),
      });
      expect(cancelled.killOutcome).toBe('terminated');
      expect(cancelled.sweepResult).toEqual({ matched: 12, killed: ['4242'], survivors: [] });
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

    // — execution-target decision (ADR-008, N4a, migration 007) —

    it('a freshly seeded run has no execution-target decision (NULL, not a fabricated default)', () => {
      const store = makeStore();
      const { run } = seedRun(store);
      expect(store.getRun(run.id)).toMatchObject({ targetSessionId: null, targetDecision: null });
      store.close();
    });

    it('records and round-trips the selector decision on a run (automatic mode)', () => {
      const store = makeStore();
      const { run } = seedRun(store);
      const decision = {
        specialistId: 'dev',
        selectedSessionId: 'sess_primary',
        reason: 'work belongs to the project — runs in its primary session',
        alternativesConsidered: ['specialist session sess_dev'],
        workspaceStrategy: 'project-primary',
      };
      store.recordRunTarget(run.id, 'sess_primary', decision);
      const persisted = store.getRun(run.id);
      expect(persisted?.targetSessionId).toBe('sess_primary');
      expect(persisted?.targetDecision).toEqual(decision);
      // last-write-wins: the deterministic selector re-decides identically on a
      // re-dispatch, so re-recording is harmless, not an error
      store.recordRunTarget(run.id, 'sess_primary', decision);
      expect(store.getRun(run.id)?.targetDecision).toEqual(decision);
      store.close();
    });

    it('recording a target on a missing run is rejected', () => {
      const store = makeStore();
      expect(() =>
        store.recordRunTarget('run_missing', 'sess', {
          specialistId: 'dev',
          selectedSessionId: 'sess',
          reason: 'x',
          alternativesConsidered: [],
          workspaceStrategy: 'project-primary',
        }),
      ).toThrow();
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

    it('getEventsByRunIds batches events per run in seq order; unknown runs are absent', () => {
      const store = makeStore();
      const a = seedRun(store);
      const b = seedRun(store);
      store.ingestEvents(a.run.id, [
        ev('a2', 2, 'output', { text: 'a-two' }),
        ev('a1', 1, 'output', { text: 'a-one' }),
      ]);
      store.ingestEvents(b.run.id, [ev('b1', 1, 'tool_use', { name: 'Bash', input: { command: 'ls' } })]);
      const byRun = store.getEventsByRunIds([a.run.id, b.run.id, 'run_absent']);
      expect(byRun.get(a.run.id)!.map((e) => e.seq)).toEqual([1, 2]);
      expect(byRun.get(a.run.id)!.map((e) => e.payload)).toEqual([{ text: 'a-one' }, { text: 'a-two' }]);
      expect(byRun.get(b.run.id)!.map((e) => e.seq)).toEqual([1]);
      expect(byRun.has('run_absent')).toBe(false);
      // the batch is exactly what per-run getEvents would return
      expect(byRun.get(a.run.id)).toEqual(store.getEvents(a.run.id));
      expect(store.getEventsByRunIds([]).size).toBe(0);
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
        instructions: INSTRUCTIONS,
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
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const c = store.createConversation({ projectId: p.id, title: 't', agentId: 'dev' });
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const { message, run } = store.sendMessage({
          conversationId: c.id,
          content: `m${i}`,
          caps: CAPS,
          policy: POLICY,
          instructions: INSTRUCTIONS,
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

    it('getLastMessagesByConversationIds batches the newest message per conversation; empty conversations are absent', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const c1 = store.createConversation({ projectId: p.id, title: 't1', agentId: 'dev' });
      const c2 = store.createConversation({ projectId: p.id, title: 't2', agentId: 'dev' });
      const empty = store.createConversation({ projectId: p.id, title: 'empty', agentId: 'dev' });

      const c1First = store.sendMessage({
        conversationId: c1.id,
        content: 'c1-first',
        caps: CAPS,
        policy: POLICY,
        instructions: INSTRUCTIONS,
      });
      store.finalizeRun({
        runId: c1First.run.id,
        from: 'queued',
        to: 'cancelled',
        usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'cancelled-unknown' },
        summary: summaryFor(c1First.run.id, 'cancelled'),
      });
      const c1Second = store.sendMessage({
        conversationId: c1.id,
        content: 'c1-second',
        caps: CAPS,
        policy: POLICY,
        instructions: INSTRUCTIONS,
      });
      store.dispatchNextRun(p.id);
      store.transitionRun(c1Second.run.id, 'starting', 'streaming');
      store.finalizeRun({
        runId: c1Second.run.id,
        from: 'streaming',
        to: 'completed',
        assistantContent: 'c1-reply',
        usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'cancelled-unknown' },
        summary: summaryFor(c1Second.run.id, 'completed'),
      });
      store.sendMessage({
        conversationId: c2.id,
        content: 'c2-only',
        caps: CAPS,
        policy: POLICY,
        instructions: INSTRUCTIONS,
      });

      const byConversation = store.getLastMessagesByConversationIds([c1.id, c2.id, empty.id]);
      expect(byConversation.get(c1.id)).toMatchObject({ content: 'c1-reply', role: 'assistant' });
      expect(byConversation.get(c2.id)).toMatchObject({ content: 'c2-only', role: 'user' });
      expect(byConversation.has(empty.id)).toBe(false);

      expect(store.getLastMessagesByConversationIds([]).size).toBe(0);
      store.close();
    });

    it('queues and drains owner steering on a task, in order and atomically (ADR-014, I-14)', () => {
      const store = makeStore();
      const { project, conv } = seedRun(store);
      const task = store.createTask({ projectId: project.id, sourceConversationId: conv.id });
      expect(task.pendingFeedback).toEqual([]);

      store.appendTaskFeedback(task.id, 'also rename the button');
      const after = store.appendTaskFeedback(task.id, 'and add a test');
      // arrival order kept; read back through getTask — on SQLite this is the
      // only cover for the pending_feedback column mapping
      expect(after.pendingFeedback).toEqual(['also rename the button', 'and add a test']);
      expect(store.getTask(task.id)!.pendingFeedback).toEqual([
        'also rename the button',
        'and add a test',
      ]);

      // drain = read-and-clear: each note folds into exactly one prompt
      expect(store.drainTaskFeedback(task.id)).toEqual([
        'also rename the button',
        'and add a test',
      ]);
      expect(store.getTask(task.id)!.pendingFeedback).toEqual([]);
      expect(store.drainTaskFeedback(task.id)).toEqual([]);

      expect(() => store.appendTaskFeedback('task_missing', 'x')).toThrow(NotFoundError);
      expect(() => store.drainTaskFeedback('task_missing')).toThrow(NotFoundError);
      store.close();
    });

    it('records a task step runtime handle on the STEP, round-tripped, never touching the conversation (#123)', () => {
      const store = makeStore();
      const { project, conv } = seedRun(store);
      const task = store.createTask({ projectId: project.id, sourceConversationId: conv.id });
      const step = store.createTaskStep({ taskId: task.id, kind: 'implementation', specialistId: 'dev' });
      expect(step.runtimeSessionId).toBeNull();

      store.setTaskStepRuntimeSessionId(step.id, 'cli-step-1');
      // read back through BOTH read paths: on SQLite this is the only cover
      // for the runtime_session_id → runtimeSessionId column mapping
      expect(store.getTaskStep(step.id)!.runtimeSessionId).toBe('cli-step-1');
      expect(store.listTaskSteps(task.id)[0]!.runtimeSessionId).toBe('cli-step-1');
      // the conversation's continuation handle is untouched
      expect(store.getConversation(conv.id)!.runtimeSessionId).toBeNull();

      // overwrite is allowed — drift is captured (FR-24 policy)
      store.setTaskStepRuntimeSessionId(step.id, 'cli-step-2');
      expect(store.getTaskStep(step.id)!.runtimeSessionId).toBe('cli-step-2');

      expect(() => store.setTaskStepRuntimeSessionId('step_missing', 'x')).toThrow(NotFoundError);
      store.close();
    });

    // — run history (activity panel) —

    it('listRunsByConversation returns the conversation runs newest-first, scoped and limited', () => {
      const store = makeStore();
      const { project, conv, run: r1 } = seedRun(store);
      // r1 must be terminal before a second run can matter for ordering; a
      // queued pile-up is also legal, but finalize exercises more of the row
      store.finalizeRun({
        runId: r1.id,
        from: 'queued',
        to: 'cancelled',
        usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'cancelled-unknown' },
        summary: summaryFor(r1.id, 'cancelled'),
      });
      const r2 = store.sendMessage({
        conversationId: conv.id,
        content: 'second',
        caps: CAPS,
        policy: POLICY,
        instructions: INSTRUCTIONS,
      }).run;
      const r3 = store.sendMessage({
        conversationId: conv.id,
        content: 'third',
        caps: CAPS,
        policy: POLICY,
        instructions: INSTRUCTIONS,
      }).run;
      // a run in a DIFFERENT conversation must not leak in
      const otherConv = store.createConversation({ projectId: project.id, title: 'o', agentId: 'dev' });
      store.sendMessage({
        conversationId: otherConv.id,
        content: 'other',
        caps: CAPS,
        policy: POLICY,
        instructions: INSTRUCTIONS,
      });

      expect(store.listRunsByConversation(conv.id).map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
      // limit keeps the NEWEST entries
      expect(store.listRunsByConversation(conv.id, { limit: 2 }).map((r) => r.id)).toEqual([
        r3.id,
        r2.id,
      ]);
      expect(() => store.listRunsByConversation('conv_missing')).toThrow(NotFoundError);
      store.close();
    });

    it('getSummariesByRunIds batches summaries; runs without one are absent', () => {
      const store = makeStore();
      const { conv, run: r1 } = seedRun(store);
      store.finalizeRun({
        runId: r1.id,
        from: 'queued',
        to: 'cancelled',
        usage: { totalCostUsd: null, numTurns: null, usage: null, source: 'cancelled-unknown' },
        summary: summaryFor(r1.id, 'cancelled'),
      });
      // still queued — non-terminal, so it has no summary yet
      const r2 = store.sendMessage({
        conversationId: conv.id,
        content: 'second',
        caps: CAPS,
        policy: POLICY,
        instructions: INSTRUCTIONS,
      }).run;

      const byRun = store.getSummariesByRunIds([r1.id, r2.id]);
      expect(byRun.get(r1.id)).toMatchObject({ runId: r1.id, outcome: 'cancelled' });
      expect(byRun.has(r2.id)).toBe(false);
      expect(store.getSummariesByRunIds([]).size).toBe(0);
      store.close();
    });

    it('upserts, reads, and lists specialist sessions (N3b-1)', () => {
      const store = makeStore();
      expect(store.getSpecialistSession('claudio')).toBeUndefined();
      expect(store.listSpecialistSessions()).toEqual([]);

      const bound = store.setSpecialistSession({
        specialistId: 'claudio',
        sessionId: 's_owned',
        ownerAccountId: 'owner-admin',
        ownership: 'owner',
        bindingMode: 'existing',
        lastKnownState: 'running',
        status: 'available',
      });
      expect(bound.sessionId).toBe('s_owned');
      expect(store.getSpecialistSession('claudio')).toEqual({
        specialistId: 'claudio',
        sessionId: 's_owned',
        ownerAccountId: 'owner-admin',
        ownership: 'owner',
        bindingMode: 'existing',
        lastKnownState: 'running',
        status: 'available',
      });

      // upsert by specialistId (1:1): rebinding replaces, never duplicates
      store.setSpecialistSession({
        specialistId: 'claudio',
        sessionId: 's_new',
        ownerAccountId: null,
        ownership: 'legacy-technical',
        bindingMode: 'created',
        lastKnownState: 'ready',
        status: 'available',
      });
      store.setSpecialistSession({
        specialistId: 'claudia',
        sessionId: 's_qa',
        ownerAccountId: 'owner-admin',
        ownership: 'owner',
        bindingMode: 'existing',
        lastKnownState: 'stopped',
        status: 'offline',
      });
      const all = store.listSpecialistSessions();
      expect(all.map((b) => b.specialistId)).toEqual(['claudia', 'claudio']); // sorted
      expect(store.getSpecialistSession('claudio')!.sessionId).toBe('s_new');
      expect(store.getSpecialistSession('claudia')!.status).toBe('offline');
      store.close();
    });

    it('creates a project-less specialist conversation and serializes runs per workspace (N3b-2)', () => {
      const store = makeStore();
      const conv = store.createConversation({ projectId: null, title: 'c', agentId: 'claudio', mode: 'direct' });
      expect(conv.projectId).toBeNull();
      expect(conv.mode).toBe('direct');
      const read = store.getConversation(conv.id)!;
      expect(read.projectId).toBeNull();
      // dispatch by the specialist workspace key
      const msg = store.sendMessage({
        conversationId: conv.id, content: 'hi', caps: CAPS, policy: POLICY, instructions: INSTRUCTIONS,
      });
      expect(msg.run.state).toBe('queued');
      const dispatched = store.dispatchNextRun('specialist:claudio');
      expect(dispatched?.id).toBe(msg.run.id);
      expect(dispatched?.state).toBe('starting');
      // a second queued run in the same specialist workspace does NOT dispatch
      store.createConversation({ projectId: null, title: 'c2', agentId: 'claudio', mode: 'direct' });
      const conv2 = store.listConversations().find((c) => c.title === 'c2')!;
      store.sendMessage({ conversationId: conv2.id, content: 'x', caps: CAPS, policy: POLICY, instructions: INSTRUCTIONS });
      expect(store.dispatchNextRun('specialist:claudio')).toBeUndefined();
      store.close();
    });

    // — tasks: dev → QA → human-approval lifecycle (N5a, ADR-009/010) —

    it('creates a task in planning, scoped to its project', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const conv = store.createConversation({ projectId: p.id, title: 't', agentId: 'dev' });
      const task = store.createTask({ projectId: p.id, sourceConversationId: conv.id, sourceMessageId: 'msg_x' });
      expect(task).toMatchObject({ state: 'planning', projectId: p.id, sourceConversationId: conv.id });
      expect(store.getTask(task.id)).toMatchObject({ state: 'planning' });
      expect(store.listTasks({ projectId: p.id }).map((t) => t.id)).toEqual([task.id]);
      expect(store.listTasks({ projectId: 'other' })).toEqual([]);
      expect(() => store.createTask({ projectId: 'ghost' })).toThrow();
      // the approval PR url (N6b) starts null and round-trips once recorded
      expect(task.pullRequestUrl).toBeNull();
      expect(store.setTaskPullRequestUrl(task.id, 'https://github.com/o/r/pull/3').pullRequestUrl).toBe(
        'https://github.com/o/r/pull/3',
      );
      expect(store.getTask(task.id)!.pullRequestUrl).toBe('https://github.com/o/r/pull/3');
      expect(() => store.setTaskPullRequestUrl('ghost', 'x')).toThrow();
      store.close();
    });

    it('lists tasks by state, filtered to the requested states (boot reconcile — ADR-009 "Boot reconciliation of tasks")', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const inflight = store.createTask({ projectId: p.id });
      store.transitionTask(inflight.id, 'planning', 'implementing');
      const fresh = store.createTask({ projectId: p.id }); // stays in planning
      const done = store.createTask({ projectId: p.id });
      store.transitionTask(done.id, 'planning', 'implementing');
      store.transitionTask(done.id, 'implementing', 'failed');

      expect(store.listTasksByState(['implementing']).map((t) => t.id)).toEqual([inflight.id]);
      expect(
        store.listTasksByState(['planning', 'implementing']).map((t) => t.id).sort(),
      ).toEqual([inflight.id, fresh.id].sort());
      expect(store.listTasksByState(['failed']).map((t) => t.id)).toEqual([done.id]);
      expect(store.listTasksByState([])).toEqual([]); // empty states → empty, no full-table scan
      store.close();
    });

    it('guards task transitions: legal walk, illegal jump, and stale-from all enforced (I-13)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const task = store.createTask({ projectId: p.id });
      // legal walk to QA rejection loop and back
      expect(store.transitionTask(task.id, 'planning', 'implementing').state).toBe('implementing');
      store.transitionTask(task.id, 'implementing', 'qa_pending');
      store.transitionTask(task.id, 'qa_pending', 'qa_running');
      store.transitionTask(task.id, 'qa_running', 'changes_requested_by_qa');
      expect(store.transitionTask(task.id, 'changes_requested_by_qa', 'implementing').state).toBe('implementing');
      // illegal jump rejected (skipping QA + approval)
      expect(() => store.transitionTask(task.id, 'implementing', 'approved')).toThrow(IllegalTaskTransitionError);
      // stale-from rejected (row is in `implementing`, not `qa_running`)
      expect(() => store.transitionTask(task.id, 'qa_running', 'awaiting_human_approval')).toThrow(
        StaleTaskStateError,
      );
      store.close();
    });

    it('appends steps with an auto-incrementing seq, ordered', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const task = store.createTask({ projectId: p.id });
      const s0 = store.createTaskStep({ taskId: task.id, kind: 'implementation', specialistId: 'dev' });
      const s1 = store.createTaskStep({ taskId: task.id, kind: 'qa', specialistId: 'qa' });
      expect(s0.seq).toBe(0);
      expect(s1.seq).toBe(1);
      expect(store.listTaskSteps(task.id).map((s) => [s.seq, s.kind, s.specialistId])).toEqual([
        [0, 'implementation', 'dev'],
        [1, 'qa', 'qa'],
      ]);
      expect(() => store.createTaskStep({ taskId: 'ghost', kind: 'qa', specialistId: 'qa' })).toThrow();
      store.close();
    });

    it('round-trips a step, with and without a DelegatedWorkspaceAccess grant (N5b-2)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const task = store.createTask({ projectId: p.id });
      const withGrant = store.createTaskStep({
        taskId: task.id,
        kind: 'implementation',
        specialistId: 'dev',
        workspaceAccess: {
          accessMode: 'worktree-write',
          branch: 'hub/task/t1',
          path: '.hub-task-worktrees/t1',
          pathBounds: [],
          expiresAt: null,
        },
      });
      const noGrant = store.createTaskStep({ taskId: task.id, kind: 'qa', specialistId: 'qa' });

      // fetched by id and in the list, the grant survives the JSON round-trip;
      // a step created without one reads back null (an ordinary strategy-A step)
      expect(store.getTaskStep(withGrant.id)!.workspaceAccess).toEqual({
        accessMode: 'worktree-write',
        branch: 'hub/task/t1',
        path: '.hub-task-worktrees/t1',
        pathBounds: [],
        expiresAt: null,
      });
      expect(store.getTaskStep(noGrant.id)!.workspaceAccess).toBeNull();
      expect(store.getTaskStep('ghost')).toBeUndefined();
      expect(store.listTaskSteps(task.id).map((s) => s.workspaceAccess?.accessMode ?? null)).toEqual([
        'worktree-write',
        null,
      ]);
      store.close();
    });

    it('records and round-trips both work-product kinds by their typed body (18 §4)', () => {
      const store = makeStore();
      const p = store.createProject({ name: 'p', defaultAgentId: 'dev', sessionTemplateId: 'tpl' });
      const task = store.createTask({ projectId: p.id });
      const step = store.createTaskStep({ taskId: task.id, kind: 'implementation', specialistId: 'dev' });
      const impl = store.addWorkProduct({
        taskId: task.id,
        taskStepId: step.id,
        producerSpecialistId: 'dev',
        runId: 'run_x',
        kind: 'implementation_report',
        body: {
          objective: 'add feature',
          summary: 'did it',
          filesChanged: ['a.ts'],
          commandsRun: ['npm test'],
          testsRun: ['unit'],
          knownRisks: [],
          commitOrPatch: 'abc123',
        },
      });
      const qa = store.addWorkProduct({
        taskId: task.id,
        producerSpecialistId: 'qa',
        kind: 'qa_report',
        body: {
          requirementsReviewed: ['R1'],
          testsRun: ['unit'],
          passed: ['unit'],
          failed: [],
          regressions: [],
          verdict: 'passed',
        },
      });
      const products = store.listWorkProducts(task.id);
      expect(products.map((w) => w.kind).sort()).toEqual(['implementation_report', 'qa_report']);
      const implBack = products.find((w) => w.id === impl.id)!;
      expect(implBack.kind).toBe('implementation_report');
      if (implBack.kind === 'implementation_report') {
        expect(implBack.body.filesChanged).toEqual(['a.ts']);
        expect(implBack.taskStepId).toBe(step.id);
        expect(implBack.runId).toBe('run_x');
      }
      const qaBack = products.find((w) => w.id === qa.id)!;
      if (qaBack.kind === 'qa_report') expect(qaBack.body.verdict).toBe('passed');
      expect(() =>
        store.addWorkProduct({
          taskId: 'ghost',
          producerSpecialistId: 'dev',
          kind: 'qa_report',
          body: { requirementsReviewed: [], testsRun: [], passed: [], failed: [], regressions: [], verdict: 'passed' },
        }),
      ).toThrow();
      store.close();
    });

    it('an ordinary run has a null taskStepId (migration 008 column)', () => {
      const store = makeStore();
      const { run } = seedRun(store);
      expect(store.getRun(run.id)?.taskStepId).toBeNull();
      store.close();
    });
  });
}
