/**
 * In-memory HubStore fake (NFR-03): first-class peer of the SQLite store —
 * same interface, same guarded-update semantics, same validation, so the
 * contract suite (13 §2) yields identical results including rejections.
 */

import { randomIds, systemClock, type Clock, type IdGen } from '../domain/ids.js';
import {
  assertLegalTransition,
  isTerminal,
  StaleStateError,
} from '../domain/runStateMachine.js';
import type {
  Conversation,
  Message,
  Project,
  Run,
  RunEvent,
  RunState,
  RunSummary,
  SessionBinding,
  UsageRecord,
} from '../domain/types.js';
import { capMessageContent, serializePayloadCapped, validateSendMessage } from './shared.js';
import {
  NotFoundError,
  REPLAYABLE_EVENT_TYPES,
  ValidationError,
  type CreateConversationInput,
  type CreateProjectInput,
  type FinalizeRunInput,
  type HubStore,
  type NewRunEvent,
  type ReplayableEvent,
  type RunTransitionPatch,
  type SendMessageInput,
} from './types.js';

const clone = <T>(v: T): T => structuredClone(v);

interface StoredEvent extends RunEvent {
  /** serialized, capped payload — what SQLite persists; parsed on read */
  payloadJson: string;
}

export interface MemoryStoreOptions {
  idGen?: IdGen;
  clock?: Clock;
}

export class MemoryHubStore implements HubStore {
  private readonly id: IdGen;
  private readonly now: Clock;

  private projects: Project[] = [];
  private conversations: Conversation[] = [];
  private messages: Message[] = [];
  private runs: Run[] = [];
  private events: StoredEvent[] = [];
  private usage = new Map<string, UsageRecord>();
  private summaries = new Map<string, RunSummary>();
  private sseCursors = new Map<string, number>();

  constructor(opts: MemoryStoreOptions = {}) {
    this.id = opts.idGen ?? randomIds;
    this.now = opts.clock ?? systemClock;
  }

  close(): void {
    // nothing to release
  }

  // — projects —

  createProject(input: CreateProjectInput): Project {
    if (!input.name?.trim()) throw new ValidationError('project name required');
    if (!input.defaultAgentId?.trim()) throw new ValidationError('defaultAgentId required');
    const now = this.now();
    const project: Project = {
      id: this.id('proj'),
      name: input.name,
      status: 'provisioning',
      defaultAgentId: input.defaultAgentId,
      sessionTemplateId: input.sessionTemplateId ?? null,
      repo: input.repo ?? null,
      instructions: input.instructions ?? null,
      sessionBinding: {
        sessionId: null,
        templateId: null,
        lastKnownState: null,
        // same defaults the SQLite insert writes (migration 004 semantics):
        // template-created sessions live in the Hub's technical account
        // until shared-terminal#420 enables create-on-behalf (ADR-007)
        bindingMode: 'created',
        ownerAccountId: null,
        ownership: 'legacy-technical',
      },
      createdAt: now,
      updatedAt: now,
    };
    this.projects.push(project);
    return clone(project);
  }

  getProject(id: string): Project | undefined {
    const p = this.projects.find((x) => x.id === id);
    return p ? clone(p) : undefined;
  }

  listProjects(opts: { includeArchived?: boolean } = {}): Project[] {
    return this.projects
      .filter((p) => opts.includeArchived || p.status !== 'archived')
      .map(clone);
  }

  updateProject(
    id: string,
    patch: { name?: string; status?: Project['status']; instructions?: string | null },
  ): Project {
    const p = this.mustProjectRef(id);
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.status !== undefined) p.status = patch.status;
    if (patch.instructions !== undefined) p.instructions = patch.instructions;
    p.updatedAt = this.now();
    return clone(p);
  }

  setProjectSession(id: string, binding: Partial<SessionBinding>): Project {
    const p = this.mustProjectRef(id);
    if (binding.sessionId !== undefined) p.sessionBinding.sessionId = binding.sessionId;
    if (binding.templateId !== undefined) p.sessionBinding.templateId = binding.templateId;
    if (binding.lastKnownState !== undefined)
      p.sessionBinding.lastKnownState = binding.lastKnownState;
    if (binding.bindingMode !== undefined) p.sessionBinding.bindingMode = binding.bindingMode;
    if (binding.ownerAccountId !== undefined)
      p.sessionBinding.ownerAccountId = binding.ownerAccountId;
    if (binding.ownership !== undefined) p.sessionBinding.ownership = binding.ownership;
    p.updatedAt = this.now();
    return clone(p);
  }

  // — conversations —

  createConversation(input: CreateConversationInput): Conversation {
    this.mustProjectRef(input.projectId);
    if (!input.agentId?.trim()) throw new ValidationError('agentId required');
    const now = this.now();
    const conv: Conversation = {
      id: this.id('conv'),
      projectId: input.projectId,
      title: input.title,
      agentId: input.agentId,
      status: 'active',
      runtimeSessionId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.push(conv);
    return clone(conv);
  }

  getConversation(id: string): Conversation | undefined {
    const c = this.conversations.find((x) => x.id === id);
    return c ? clone(c) : undefined;
  }

  listConversations(opts: { projectId?: string; includeArchived?: boolean } = {}): Conversation[] {
    return this.conversations
      .filter((c) => !opts.projectId || c.projectId === opts.projectId)
      .filter((c) => opts.includeArchived || c.status !== 'archived')
      .map(clone);
  }

  updateConversation(
    id: string,
    patch: { title?: string; status?: Conversation['status'] },
  ): Conversation {
    const c = this.mustConversationRef(id);
    if (patch.title !== undefined) c.title = patch.title;
    if (patch.status !== undefined) c.status = patch.status;
    c.updatedAt = this.now();
    return clone(c);
  }

  setRuntimeSessionId(conversationId: string, runtimeSessionId: string): void {
    const c = this.mustConversationRef(conversationId);
    c.runtimeSessionId = runtimeSessionId;
    c.updatedAt = this.now();
  }

  // — messages —

  getMessage(id: string): Message | undefined {
    const m = this.messages.find((x) => x.id === id);
    return m ? clone(m) : undefined;
  }

  listMessages(
    conversationId: string,
    opts: { before?: string; limit?: number } = {},
  ): Message[] {
    this.mustConversationRef(conversationId);
    const limit = opts.limit ?? 100;
    const all = this.messages.filter((m) => m.conversationId === conversationId);
    let end = all.length;
    if (opts.before) {
      const idx = all.findIndex((m) => m.id === opts.before);
      if (idx === -1) throw new NotFoundError('message', opts.before);
      end = idx;
    }
    return all.slice(Math.max(0, end - limit), end).map(clone);
  }

  // — run lifecycle —

  sendMessage(input: SendMessageInput): { message: Message; run: Run } {
    validateSendMessage(input);
    this.mustConversationRef(input.conversationId);
    const now = this.now();
    const message: Message = {
      id: this.id('msg'),
      conversationId: input.conversationId,
      role: 'user',
      content: capMessageContent(input.content),
      runId: null,
      createdAt: now,
    };
    const run: Run = {
      id: this.id('run'),
      conversationId: input.conversationId,
      messageId: message.id,
      state: 'queued',
      execId: null,
      pgid: null,
      seamRequestId: null,
      capsSnapshot: clone(input.caps),
      policySnapshot: [...input.policy],
      instructionsSnapshot: input.instructions,
      cliVersion: null,
      model: null,
      killOutcome: null,
      sweepResult: null,
      errorCode: null,
      errorDetail: null,
      createdAt: now,
      startedAt: null,
      endedAt: null,
    };
    message.runId = run.id;
    if (this.runs.some((r) => r.messageId === message.id)) {
      throw new ValidationError(`run already exists for message ${message.id} (I-1)`);
    }
    this.messages.push(message);
    this.runs.push(run);
    return { message: clone(message), run: clone(run) };
  }

  dispatchNextRun(projectId: string): Run | undefined {
    this.mustProjectRef(projectId);
    const projectRuns = this.projectRuns(projectId);
    if (projectRuns.some((r) => r.state === 'starting' || r.state === 'streaming')) {
      return undefined;
    }
    const next = projectRuns.find((r) => r.state === 'queued');
    if (!next) return undefined;
    // find+mutate is atomic in single-threaded JS — the in-memory analog of
    // the SQLite guarded `UPDATE … WHERE state = 'queued'`.
    next.state = 'starting';
    return clone(next);
  }

  transitionRun(
    runId: string,
    from: RunState,
    to: RunState,
    patch: RunTransitionPatch = {},
  ): Run {
    if (isTerminal(to)) {
      throw new ValidationError(
        `terminal transitions go through finalizeRun (I-5/I-11), got ${to}`,
      );
    }
    assertLegalTransition(runId, from, to);
    const run = this.mustRunRef(runId);
    if (run.state !== from) throw new StaleStateError(runId, from);
    run.state = to;
    if (patch.execId !== undefined) run.execId = patch.execId;
    if (patch.pgid !== undefined) run.pgid = patch.pgid;
    if (patch.seamRequestId !== undefined) run.seamRequestId = patch.seamRequestId;
    if (to === 'streaming') run.startedAt = this.now();
    return clone(run);
  }

  finalizeRun(input: FinalizeRunInput): Run {
    assertLegalTransition(input.runId, input.from, input.to);
    const run = this.mustRunRef(input.runId);
    if (run.state !== input.from) throw new StaleStateError(input.runId, input.from);
    const now = this.now();
    run.state = input.to;
    if (input.killOutcome !== undefined) run.killOutcome = input.killOutcome;
    if (input.sweepResult !== undefined) run.sweepResult = clone(input.sweepResult);
    run.errorCode = input.errorCode ?? null;
    run.errorDetail = input.errorDetail ?? null;
    run.endedAt = now;
    if (input.assistantContent != null) {
      this.messages.push({
        id: this.id('msg'),
        conversationId: run.conversationId,
        role: 'assistant',
        content: capMessageContent(input.assistantContent),
        runId: run.id,
        createdAt: now,
      });
    }
    this.usage.set(run.id, {
      runId: run.id,
      totalCostUsd: input.usage.totalCostUsd,
      numTurns: input.usage.numTurns,
      usage: input.usage.usage == null ? null : clone(input.usage.usage),
      source: input.usage.source,
    });
    this.summaries.set(run.id, clone(input.summary));
    return clone(run);
  }

  setRunInitMeta(runId: string, meta: { cliVersion: string; model: string }): void {
    const run = this.mustRunRef(runId);
    if (run.cliVersion !== null) {
      if (run.cliVersion === meta.cliVersion && run.model === meta.model) return;
      throw new ValidationError(`cliVersion/model are write-once (I-8) for run ${runId}`);
    }
    run.cliVersion = meta.cliVersion;
    run.model = meta.model;
  }

  getRun(id: string): Run | undefined {
    const r = this.runs.find((x) => x.id === id);
    return r ? clone(r) : undefined;
  }

  getRunByMessage(messageId: string): Run | undefined {
    const r = this.runs.find((x) => x.messageId === messageId);
    return r ? clone(r) : undefined;
  }

  listRunsByState(states: RunState[]): Run[] {
    return this.runs.filter((r) => states.includes(r.state)).map(clone);
  }

  getQueuedRuns(projectId: string): Run[] {
    return this.projectRuns(projectId)
      .filter((r) => r.state === 'queued')
      .map(clone);
  }

  getActiveRun(projectId: string): Run | undefined {
    const r = this.projectRuns(projectId).find(
      (x) => x.state === 'starting' || x.state === 'streaming',
    );
    return r ? clone(r) : undefined;
  }

  // — events —

  ingestEvents(runId: string, events: NewRunEvent[]): { inserted: number } {
    const run = this.mustRunRef(runId);
    // simulate one transaction: validate the whole batch before applying
    const staged: StoredEvent[] = [];
    let replayableInserted = 0;
    const existingIds = new Set(this.events.map((e) => e.id));
    const existingSeqs = new Set(
      this.events.filter((e) => e.runId === runId).map((e) => e.seq),
    );
    for (const ev of events) {
      if (existingIds.has(ev.id) || staged.some((s) => s.id === ev.id)) continue; // idempotent (I-4)
      if (existingSeqs.has(ev.seq) || staged.some((s) => s.seq === ev.seq)) {
        throw new ValidationError(
          `run_event seq collision: (${runId}, ${ev.seq}) already taken by a different id (I-4)`,
        );
      }
      const payloadJson = serializePayloadCapped(ev.payload);
      staged.push({
        id: ev.id,
        runId,
        seq: ev.seq,
        type: ev.type,
        payload: JSON.parse(payloadJson),
        payloadJson,
        ts: ev.ts,
      });
      if ((REPLAYABLE_EVENT_TYPES as readonly string[]).includes(ev.type)) {
        replayableInserted += 1;
      }
    }
    this.events.push(...staged);
    if (replayableInserted > 0) {
      this.sseCursors.set(
        run.conversationId,
        (this.sseCursors.get(run.conversationId) ?? 0) + replayableInserted,
      );
    }
    return { inserted: staged.length };
  }

  getEvents(runId: string): RunEvent[] {
    this.mustRunRef(runId);
    return this.events
      .filter((e) => e.runId === runId)
      .sort((a, b) => a.seq - b.seq)
      .map(({ payloadJson: _p, ...ev }) => clone(ev));
  }

  getReplayableEvents(conversationId: string, afterIndex = -1): ReplayableEvent[] {
    this.mustConversationRef(conversationId);
    const runOrder = new Map(this.runs.map((r, i) => [r.id, i]));
    const rows = this.events
      .filter(
        (e) =>
          (REPLAYABLE_EVENT_TYPES as readonly string[]).includes(e.type) &&
          this.runs.find((r) => r.id === e.runId)?.conversationId === conversationId,
      )
      .sort((a, b) => {
        const ra = runOrder.get(a.runId)!;
        const rb = runOrder.get(b.runId)!;
        return ra === rb ? a.seq - b.seq : ra - rb;
      });
    return rows
      .map((row, index) => ({
        index,
        event: clone({
          id: row.id,
          runId: row.runId,
          seq: row.seq,
          type: row.type,
          payload: row.payload,
          ts: row.ts,
        }),
      }))
      .filter((r) => r.index > afterIndex);
  }

  getSseCursor(conversationId: string): number {
    return this.sseCursors.get(conversationId) ?? 0;
  }

  // — usage & summary —

  getUsage(runId: string): UsageRecord | undefined {
    const u = this.usage.get(runId);
    return u ? clone(u) : undefined;
  }

  getSummary(runId: string): RunSummary | undefined {
    const s = this.summaries.get(runId);
    return s ? clone(s) : undefined;
  }

  // — internals —

  private projectRuns(projectId: string): Run[] {
    const convIds = new Set(
      this.conversations.filter((c) => c.projectId === projectId).map((c) => c.id),
    );
    return this.runs.filter((r) => convIds.has(r.conversationId));
  }

  private mustProjectRef(id: string): Project {
    const p = this.projects.find((x) => x.id === id);
    if (!p) throw new NotFoundError('project', id);
    return p;
  }

  private mustConversationRef(id: string): Conversation {
    const c = this.conversations.find((x) => x.id === id);
    if (!c) throw new NotFoundError('conversation', id);
    return c;
  }

  private mustRunRef(id: string): Run {
    const r = this.runs.find((x) => x.id === id);
    if (!r) throw new NotFoundError('run', id);
    return r;
  }
}
