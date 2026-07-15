/**
 * Integration: the Increment-1 spine end-to-end on the FAKE substrate +
 * runtime (13 §3) — zero network, zero tokens, deterministic. Runs against
 * both HubStore implementations, because the store is the source of truth.
 */

import { describe, expect, it } from 'vitest';
import type { Agent, Project } from '../src/domain/types.js';
import { deriveActivity } from '../src/domain/projections.js';
import { Orchestrator, OrchestratorError } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { SqliteHubStore } from '../src/store/sqlite.js';
import type { HubStore } from '../src/store/types.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { FIXTURES, fixtureStreamLines } from './fixtures.js';

const DEV_AGENT: Agent = {
  id: 'dev',
  name: 'Developer',
  instructions: 'You are the dev agent.',
  allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
  sessionTemplateId: 'tpl_default',
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
};

interface Harness {
  store: HubStore;
  port: FakeSubstrateExecPort;
  orch: Orchestrator;
  /** create a project and await provisioning (UC-01 fake = instant) */
  readyProject: () => Promise<Project>;
}

function makeHarness(store: HubStore, gate?: () => Promise<void>): Harness {
  const port = new FakeSubstrateExecPort(gate ? { gate } : {});
  const orch = new Orchestrator({
    store,
    adapter: new FakeRuntimeAdapter(port),
    execPort: port,
    agents: new Map([[DEV_AGENT.id, DEV_AGENT]]),
  });
  const readyProject = async (): Promise<Project> => {
    const p = orch.createProject({ name: 'p', defaultAgentId: 'dev' });
    await orch.idle();
    return store.getProject(p.id)!;
  };
  return { store, port, orch, readyProject };
}

function suite(name: string, makeStore: () => HubStore): void {
  describe(`spine on fake runtime — ${name}`, () => {
    it('project → conversation → send → stream → activity → summary (UC-01/02)', async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      expect(project.status).toBe('ready'); // fake session provisions instantly
      expect(project.sessionBinding.sessionId).toBe('fakesess_1');
      // agentSeed carried agent instructions (FR-30)
      expect(port.seededSessions[0]!.seed.claudeMd).toContain('dev agent');

      const conv = orch.createConversation({ projectId: project.id });
      expect(conv.agentId).toBe('dev'); // defaults from the project

      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline), splitChunks: true });
      const { run } = orch.send(conv.id, 'hello there');
      await orch.idle();

      const final = store.getRun(run.id)!;
      expect(final.state).toBe('completed');
      expect(final.cliVersion).not.toBeNull(); // FR-12 from init event
      expect(final.model).toBe('claude-sonnet-5');
      expect(final.execId).toBe('fakeexec_1');
      expect(final.seamRequestId).toBe('fakereq_1'); // OPS-04

      // usage from the result event (A3)
      expect(store.getUsage(run.id)).toMatchObject({
        totalCostUsd: 0.0101426,
        numTurns: 1,
        source: 'result-event',
      });

      // summary present, mechanical (FR-42, I-11)
      const summary = store.getSummary(run.id)!;
      expect(summary.outcome).toBe('completed');
      expect(summary.objective).toBe('hello there');
      expect(summary.costUsd).toBeCloseTo(0.0101426, 6);
      expect(summary.runtimeSessionId).toBe('S01-SESSION-C');

      // continuity: --resume handle captured (FR-24)
      expect(store.getConversation(conv.id)!.runtimeSessionId).toBe('S01-SESSION-C');

      // assistant message assembled into the thread
      const messages = store.listMessages(conv.id);
      expect(messages.at(-1)!.role).toBe('assistant');
      expect(messages.at(-1)!.content.length).toBeGreaterThan(0);

      // unknown types preserved (FR-16: the fixture's rate_limit_event)
      const events = store.getEvents(run.id);
      expect(events.some((e) => e.type === 'unknown')).toBe(true);
      store.close();
    });

    it('second turn passes --resume with the captured runtime session (FR-24)', async () => {
      const { port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      const conv = orch.createConversation({ projectId: project.id });
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      orch.send(conv.id, 'first');
      await orch.idle();
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.resume1) });
      orch.send(conv.id, 'second');
      await orch.idle();
      const [first, second] = port.execRequests;
      expect(first!.req.argv).not.toContain('--resume');
      expect(second!.req.argv).toContain('--resume');
      expect(second!.req.argv).toContain('S01-SESSION-C');
      // policy snapshot always present (I-7 → ADR-003 "never absent")
      expect(second!.req.argv).toContain('--allowedTools');
      // sweep marker env (SEC-07/ADR-003)
      expect(second!.req.env).toMatchObject({ HUB_RUN_ID: expect.stringMatching(/^run_/) });
    });

    it('tool_use activity projects from the toolshape fixture (A2, FR-14)', async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      const conv = orch.createConversation({ projectId: project.id });
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.toolshape) });
      const { run } = orch.send(conv.id, 'use some tools');
      await orch.idle();
      const activity = deriveActivity(store.getEvents(run.id));
      expect(activity.commands.length + activity.files.length).toBeGreaterThan(0);
      const summary = store.getSummary(run.id)!;
      expect(summary.commandsRun).toEqual(activity.commands);
      expect(summary.filesTouched).toEqual(activity.files);
      store.close();
    });

    it('queued message dispatches after the active run completes — FIFO across conversations (UC-03, I-2)', async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      const c1 = orch.createConversation({ projectId: project.id, title: 'a' });
      const c2 = orch.createConversation({ projectId: project.id, title: 'b' });
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      const r1 = orch.send(c1.id, 'one').run;
      const r2 = orch.send(c2.id, 'two').run;
      await orch.idle();
      const f1 = store.getRun(r1.id)!;
      const f2 = store.getRun(r2.id)!;
      expect(f1.state).toBe('completed');
      expect(f2.state).toBe('completed');
      // serialized: second started only after first ended
      expect(Date.parse(f2.startedAt!)).toBeGreaterThanOrEqual(Date.parse(f1.endedAt!));
      store.close();
    });

    it('cancel mid-stream → cancelled, kill outcome recorded, cost unknown, summary present (UC-04)', async () => {
      // gate pauses the fixture stream so the cancel lands mid-flight
      let release: (() => void) | null = null;
      let paused = false;
      const gate = (): Promise<void> => {
        if (!paused) {
          paused = true;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve();
      };
      const { store, port, orch, readyProject } = makeHarness(makeStore(), gate);
      const project = await readyProject();
      const conv = orch.createConversation({ projectId: project.id });
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.cancel) });
      const { run } = orch.send(conv.id, 'long task');

      // wait until the run is streaming (started consumed before first gate)
      await new Promise((r) => setTimeout(r, 0));
      expect(store.getRun(run.id)!.state).toBe('streaming');

      await orch.cancelRun(run.id);
      release!();
      await orch.idle();

      const final = store.getRun(run.id)!;
      expect(final.state).toBe('cancelled');
      expect(final.killOutcome).toBe('terminated'); // authoritative outcome (FR-20)
      expect(store.getUsage(run.id)).toMatchObject({ totalCostUsd: null, source: 'cancelled-unknown' });
      expect(store.getSummary(run.id)!.outcome).toBe('cancelled'); // summary even when cancelled (FR-42)
      store.close();
    });

    it('cancelling a queued run cancels it and the queue moves on (UC-03 step 4)', async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      const conv = orch.createConversation({ projectId: project.id });
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      const r1 = orch.send(conv.id, 'one').run;
      const r2 = orch.send(conv.id, 'two').run;
      const r3 = orch.send(conv.id, 'three').run;
      await orch.cancelRun(r2.id); // still queued
      await orch.idle();
      expect(store.getRun(r1.id)!.state).toBe('completed');
      expect(store.getRun(r2.id)!.state).toBe('cancelled');
      expect(store.getRun(r3.id)!.state).toBe('completed');
      store.close();
    });

    it('send is refused while the project is provisioning/error (409 semantics, 08 §1)', () => {
      const { store, orch } = makeHarness(makeStore());
      // store-level project without provisioning (simulates in-progress UC-01)
      const project = store.createProject({ name: 'p', defaultAgentId: 'dev' });
      const conv = store.createConversation({ projectId: project.id, title: 't', agentId: 'dev' });
      expect(() => orch.send(conv.id, 'x')).toThrow(OrchestratorError);
      try {
        orch.send(conv.id, 'x');
      } catch (e) {
        expect((e as OrchestratorError).code).toBe('project_not_ready');
      }
      store.close();
    });

    it('re-running the same fixture ingestion is idempotent at the store (13 §4)', async () => {
      const { store, port, orch, readyProject } = makeHarness(makeStore());
      const project = await readyProject();
      const conv = orch.createConversation({ projectId: project.id });
      port.enqueueFixture({ streamLines: fixtureStreamLines(FIXTURES.baseline) });
      const { run } = orch.send(conv.id, 'hello');
      await orch.idle();
      const events = store.getEvents(run.id);
      const replay = store.ingestEvents(
        run.id,
        events.map(({ id, seq, type, payload, ts }) => ({ id, seq, type, payload, ts })),
      );
      expect(replay.inserted).toBe(0);
      expect(store.getEvents(run.id)).toHaveLength(events.length);
      store.close();
    });
  });
}

suite('sqlite (:memory:)', () => new SqliteHubStore(':memory:'));
suite('in-memory fake', () => new MemoryHubStore());
