/**
 * SQLite HubStore (ADR-002, 09): better-sqlite3, WAL, guarded updates that
 * make illegal transitions loud (09 §2), every 09 §3 operation one
 * transaction.
 */

import DatabaseCtor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { randomIds, systemClock, type Clock, type IdGen } from '../domain/ids.js';
import {
  assertLegalTransition,
  isTerminal,
  StaleStateError,
} from '../domain/runStateMachine.js';
import { assertLegalTaskTransition, StaleTaskStateError } from '../domain/taskStateMachine.js';
import type {
  Conversation,
  ExecutionTargetDecision,
  Message,
  DelegatedWorkspaceAccess,
  Project,
  Run,
  RunEvent,
  RunState,
  RunSummary,
  SessionBinding,
  SpecialistSessionBinding,
  Task,
  TaskState,
  TaskStep,
  UsageRecord,
  WorkProduct,
} from '../domain/types.js';
import { migrate } from './migrations.js';
import { capMessageContent, serializePayloadCapped, validateSendMessage } from './shared.js';
import {
  NotFoundError,
  REPLAYABLE_EVENT_TYPES,
  ValidationError,
  type CreateConversationInput,
  type CreateProjectInput,
  type CreateTaskInput,
  type CreateTaskStepInput,
  type FinalizeRunInput,
  type HubStore,
  type NewRunEvent,
  type NewWorkProduct,
  type ReplayableEvent,
  type RunTransitionPatch,
  type SendMessageInput,
} from './types.js';

export interface SqliteStoreOptions {
  idGen?: IdGen;
  clock?: Clock;
}

interface ProjectRow {
  id: string;
  name: string;
  status: Project['status'];
  default_agent_id: string;
  instructions: string | null;
  session_id: string | null;
  session_template_id: string | null;
  workspace_template_id: string | null;
  repo_url: string | null;
  repo_ref: string | null;
  repo_target: string | null;
  session_last_state: string | null;
  binding_mode: string | null;
  owner_account_id: string | null;
  session_ownership: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  id: string;
  project_id: string | null;
  title: string;
  agent_id: string;
  mode: Conversation['mode'];
  status: Conversation['status'];
  runtime_session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: Message['role'];
  content: string;
  run_id: string | null;
  created_at: string;
}

interface RunRow {
  id: string;
  conversation_id: string;
  message_id: string;
  state: RunState;
  exec_id: string | null;
  pgid: number | null;
  seam_request_id: string | null;
  caps_snapshot: string;
  policy_snapshot: string;
  instructions_snapshot: string | null;
  cli_version: string | null;
  model: string | null;
  kill_outcome: Run['killOutcome'];
  sweep_result: string | null;
  error_code: Run['errorCode'];
  error_detail: string | null;
  target_session_id: string | null;
  target_decision: string | null;
  task_step_id: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

interface EventRow {
  id: string;
  run_id: string;
  seq: number;
  type: RunEvent['type'];
  payload: string;
  ts: string;
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    defaultAgentId: r.default_agent_id,
    // the workspace is the project's (ADR-006). `sessionBinding.templateId`
    // mirrors it for the seam reference; this is the declaration.
    sessionTemplateId: r.workspace_template_id,
    repo: r.repo_url === null ? null : {
      url: r.repo_url,
      ...(r.repo_ref !== null ? { ref: r.repo_ref } : {}),
      ...(r.repo_target !== null ? { target: r.repo_target } : {}),
    },
    instructions: r.instructions,
    sessionBinding: {
      sessionId: r.session_id,
      templateId: r.session_template_id,
      lastKnownState: r.session_last_state,
      // migration 004 backfills these; the ?? guards only a row written by
      // a pre-004 binary against a post-004 schema (defensive, same values)
      bindingMode: (r.binding_mode ?? 'created') as Project['sessionBinding']['bindingMode'],
      ownerAccountId: r.owner_account_id,
      ownership: (r.session_ownership ?? 'legacy-technical') as Project['sessionBinding']['ownership'],
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface SpecialistSessionRow {
  specialist_id: string;
  session_id: string;
  owner_account_id: string | null;
  session_ownership: string;
  binding_mode: string;
  last_known_state: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function toSpecialistSession(r: SpecialistSessionRow): SpecialistSessionBinding {
  return {
    specialistId: r.specialist_id,
    sessionId: r.session_id,
    ownerAccountId: r.owner_account_id,
    ownership: r.session_ownership as SpecialistSessionBinding['ownership'],
    bindingMode: r.binding_mode as SpecialistSessionBinding['bindingMode'],
    lastKnownState: r.last_known_state,
    status: r.status as SpecialistSessionBinding['status'],
  };
}

function toConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    agentId: r.agent_id,
    // migration 006 backfills 'direct'; the ?? guards a pre-006 row read by a
    // post-006 binary (defensive, same value)
    mode: (r.mode ?? 'direct') as Conversation['mode'],
    status: r.status,
    runtimeSessionId: r.runtime_session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    runId: r.run_id,
    createdAt: r.created_at,
  };
}

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    state: r.state,
    execId: r.exec_id,
    pgid: r.pgid,
    seamRequestId: r.seam_request_id,
    capsSnapshot: JSON.parse(r.caps_snapshot),
    policySnapshot: JSON.parse(r.policy_snapshot),
    instructionsSnapshot: r.instructions_snapshot,
    cliVersion: r.cli_version,
    model: r.model,
    killOutcome: r.kill_outcome,
    sweepResult: r.sweep_result ? JSON.parse(r.sweep_result) : null,
    errorCode: r.error_code,
    errorDetail: r.error_detail,
    targetSessionId: r.target_session_id,
    targetDecision: r.target_decision ? JSON.parse(r.target_decision) : null,
    taskStepId: r.task_step_id,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function toEvent(r: EventRow): RunEvent {
  return {
    id: r.id,
    runId: r.run_id,
    seq: r.seq,
    type: r.type,
    payload: JSON.parse(r.payload),
    ts: r.ts,
  };
}

interface TaskRow {
  id: string;
  project_id: string;
  source_conversation_id: string | null;
  source_message_id: string | null;
  state: TaskState;
  pull_request_url: string | null;
  pending_feedback: string | null;
  created_at: string;
  updated_at: string;
}
function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    projectId: r.project_id,
    sourceConversationId: r.source_conversation_id,
    sourceMessageId: r.source_message_id,
    state: r.state,
    pullRequestUrl: r.pull_request_url,
    // NULL and '[]' both mean "no pending steering" (migration 012)
    pendingFeedback: r.pending_feedback ? (JSON.parse(r.pending_feedback) as string[]) : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface TaskStepRow {
  id: string;
  task_id: string;
  seq: number;
  kind: TaskStep['kind'];
  specialist_id: string;
  workspace_access: string | null;
  runtime_session_id: string | null;
  created_at: string;
}
function toTaskStep(r: TaskStepRow): TaskStep {
  return {
    id: r.id,
    taskId: r.task_id,
    seq: r.seq,
    kind: r.kind,
    specialistId: r.specialist_id,
    workspaceAccess: r.workspace_access
      ? (JSON.parse(r.workspace_access) as DelegatedWorkspaceAccess)
      : null,
    runtimeSessionId: r.runtime_session_id,
    createdAt: r.created_at,
  };
}

interface WorkProductRow {
  id: string;
  task_id: string;
  task_step_id: string | null;
  kind: WorkProduct['kind'];
  producer_specialist_id: string;
  run_id: string | null;
  body: string;
  created_at: string;
}
function toWorkProduct(r: WorkProductRow): WorkProduct {
  const envelope = {
    id: r.id,
    taskId: r.task_id,
    taskStepId: r.task_step_id,
    producerSpecialistId: r.producer_specialist_id,
    runId: r.run_id,
    createdAt: r.created_at,
  };
  // `kind` discriminates the body; the JSON shape is trusted (written by
  // addWorkProduct from the typed NewWorkProduct).
  return { ...envelope, kind: r.kind, body: JSON.parse(r.body) } as WorkProduct;
}

export class SqliteHubStore implements HubStore {
  private readonly db: Database;
  private readonly id: IdGen;
  private readonly now: Clock;

  constructor(path: string, opts: SqliteStoreOptions = {}) {
    this.db = new DatabaseCtor(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    // migrate() toggles FK enforcement off around table rebuilds and checks
    // integrity after (migration 006), so runtime writes stay FK-enforced.
    migrate(this.db);
    this.id = opts.idGen ?? randomIds;
    this.now = opts.clock ?? systemClock;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Consistent snapshot via `VACUUM INTO` (B3-04, 09 §5) — a clean copy
   * without WAL/SHM sidecars, safe while writers are active (never a raw
   * file copy of a live WAL database). `destPath` must not already exist.
   */
  snapshotTo(destPath: string): void {
    this.db.prepare('VACUUM INTO ?').run(destPath);
  }

  // — projects —

  createProject(input: CreateProjectInput): Project {
    if (!input.name?.trim()) throw new ValidationError('project name required');
    if (!input.defaultAgentId?.trim()) throw new ValidationError('defaultAgentId required');
    const now = this.now();
    const id = this.id('proj');
    this.db
      .prepare(
        `INSERT INTO projects (id, name, status, default_agent_id, workspace_template_id,
                               repo_url, repo_ref, repo_target, instructions,
                               binding_mode, session_ownership, created_at, updated_at)
         VALUES (?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, 'created', 'legacy-technical', ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.defaultAgentId,
        input.sessionTemplateId ?? null,
        input.repo?.url ?? null,
        input.repo?.ref ?? null,
        input.repo?.target ?? null,
        input.instructions ?? null,
        now,
        now,
      );
    return this.mustProject(id);
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as
      | ProjectRow
      | undefined;
    return row ? toProject(row) : undefined;
  }

  listProjects(opts: { includeArchived?: boolean } = {}): Project[] {
    const rows = (
      opts.includeArchived
        ? this.db.prepare(`SELECT * FROM projects ORDER BY rowid`).all()
        : this.db.prepare(`SELECT * FROM projects WHERE status != 'archived' ORDER BY rowid`).all()
    ) as ProjectRow[];
    return rows.map(toProject);
  }

  updateProject(
    id: string,
    patch: { name?: string; status?: Project['status']; instructions?: string | null },
  ): Project {
    const existing = this.mustProject(id);
    this.db
      .prepare(`UPDATE projects SET name = ?, status = ?, instructions = ?, updated_at = ? WHERE id = ?`)
      .run(
        patch.name ?? existing.name,
        patch.status ?? existing.status,
        patch.instructions === undefined ? existing.instructions : patch.instructions,
        this.now(),
        id,
      );
    return this.mustProject(id);
  }

  setProjectSession(id: string, binding: Partial<SessionBinding>): Project {
    const existing = this.mustProject(id);
    this.db
      .prepare(
        `UPDATE projects SET session_id = ?, session_template_id = ?, session_last_state = ?,
                             binding_mode = ?, owner_account_id = ?, session_ownership = ?,
                             updated_at = ? WHERE id = ?`,
      )
      .run(
        binding.sessionId === undefined ? existing.sessionBinding.sessionId : binding.sessionId,
        binding.templateId === undefined ? existing.sessionBinding.templateId : binding.templateId,
        binding.lastKnownState === undefined
          ? existing.sessionBinding.lastKnownState
          : binding.lastKnownState,
        binding.bindingMode ?? existing.sessionBinding.bindingMode,
        binding.ownerAccountId === undefined
          ? existing.sessionBinding.ownerAccountId
          : binding.ownerAccountId,
        binding.ownership ?? existing.sessionBinding.ownership,
        this.now(),
        id,
      );
    return this.mustProject(id);
  }

  // — specialist sessions (N3b-1, ADR-008) — upsert by specialistId (1:1) —

  setSpecialistSession(b: SpecialistSessionBinding): SpecialistSessionBinding {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO specialist_sessions
           (specialist_id, session_id, owner_account_id, session_ownership,
            binding_mode, last_known_state, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(specialist_id) DO UPDATE SET
           session_id = excluded.session_id,
           owner_account_id = excluded.owner_account_id,
           session_ownership = excluded.session_ownership,
           binding_mode = excluded.binding_mode,
           last_known_state = excluded.last_known_state,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        b.specialistId,
        b.sessionId,
        b.ownerAccountId,
        b.ownership,
        b.bindingMode,
        b.lastKnownState,
        b.status,
        now,
        now,
      );
    return this.getSpecialistSession(b.specialistId)!;
  }

  getSpecialistSession(specialistId: string): SpecialistSessionBinding | undefined {
    const row = this.db
      .prepare(`SELECT * FROM specialist_sessions WHERE specialist_id = ?`)
      .get(specialistId) as SpecialistSessionRow | undefined;
    return row ? toSpecialistSession(row) : undefined;
  }

  listSpecialistSessions(): SpecialistSessionBinding[] {
    const rows = this.db
      .prepare(`SELECT * FROM specialist_sessions ORDER BY specialist_id`)
      .all() as SpecialistSessionRow[];
    return rows.map(toSpecialistSession);
  }

  // — conversations —

  createConversation(input: CreateConversationInput): Conversation {
    if (input.projectId !== null) this.mustProject(input.projectId);
    if (!input.agentId?.trim()) throw new ValidationError('agentId required');
    const now = this.now();
    const id = this.id('conv');
    this.db
      .prepare(
        `INSERT INTO conversations (id, project_id, title, agent_id, mode, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, input.projectId, input.title, input.agentId, input.mode ?? 'direct', now, now);
    return this.mustConversation(id);
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as
      | ConversationRow
      | undefined;
    return row ? toConversation(row) : undefined;
  }

  listConversations(opts: { projectId?: string; includeArchived?: boolean } = {}): Conversation[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (opts.projectId) {
      clauses.push(`project_id = ?`);
      params.push(opts.projectId);
    }
    if (!opts.includeArchived) clauses.push(`status != 'archived'`);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM conversations ${where} ORDER BY rowid`)
      .all(...params) as ConversationRow[];
    return rows.map(toConversation);
  }

  updateConversation(
    id: string,
    patch: { title?: string; status?: Conversation['status'] },
  ): Conversation {
    const existing = this.mustConversation(id);
    this.db
      .prepare(`UPDATE conversations SET title = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(patch.title ?? existing.title, patch.status ?? existing.status, this.now(), id);
    return this.mustConversation(id);
  }

  setRuntimeSessionId(conversationId: string, runtimeSessionId: string): void {
    const res = this.db
      .prepare(`UPDATE conversations SET runtime_session_id = ?, updated_at = ? WHERE id = ?`)
      .run(runtimeSessionId, this.now(), conversationId);
    if (res.changes !== 1) throw new NotFoundError('conversation', conversationId);
  }

  // — messages —

  getMessage(id: string): Message | undefined {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
      | MessageRow
      | undefined;
    return row ? toMessage(row) : undefined;
  }

  listMessages(
    conversationId: string,
    opts: { before?: string; limit?: number } = {},
  ): Message[] {
    this.mustConversation(conversationId);
    const limit = opts.limit ?? 100;
    let beforeRowid = Number.MAX_SAFE_INTEGER;
    if (opts.before) {
      const anchor = this.db
        .prepare(`SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?`)
        .get(opts.before, conversationId) as { rowid: number } | undefined;
      if (!anchor) throw new NotFoundError('message', opts.before);
      beforeRowid = anchor.rowid;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ? AND rowid < ?
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(conversationId, beforeRowid, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  getLastMessagesByConversationIds(conversationIds: string[]): Map<string, Message> {
    const result = new Map<string, Message>();
    if (conversationIds.length === 0) return result;
    const placeholders = conversationIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         JOIN (
           SELECT conversation_id, MAX(rowid) AS rowid FROM messages
           WHERE conversation_id IN (${placeholders})
           GROUP BY conversation_id
         ) last ON last.conversation_id = m.conversation_id AND last.rowid = m.rowid`,
      )
      .all(...conversationIds) as MessageRow[];
    for (const row of rows) result.set(row.conversation_id, toMessage(row));
    return result;
  }

  // — run lifecycle —

  appendAssistantMessage(conversationId: string, content: string): Message {
    this.mustConversation(conversationId);
    const message: Message = {
      id: this.id('msg'),
      conversationId,
      role: 'assistant',
      content: capMessageContent(content),
      runId: null,
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, run_id, created_at)
         VALUES (?, ?, 'assistant', ?, NULL, ?)`,
      )
      .run(message.id, conversationId, message.content, message.createdAt);
    return message;
  }

  sendMessage(input: SendMessageInput): { message: Message; run: Run } {
    validateSendMessage(input);
    this.mustConversation(input.conversationId);
    const now = this.now();
    const messageId = this.id('msg');
    const runId = this.id('run');
    const content = capMessageContent(input.content);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, content, run_id, created_at)
           VALUES (?, ?, 'user', ?, ?, ?)`,
        )
        .run(messageId, input.conversationId, content, runId, now);
      this.db
        .prepare(
          `INSERT INTO runs (id, conversation_id, message_id, state, caps_snapshot, policy_snapshot,
                             instructions_snapshot, task_step_id, created_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          input.conversationId,
          messageId,
          JSON.stringify(input.caps),
          JSON.stringify(input.policy),
          input.instructions,
          input.taskStepId ?? null,
          now,
        );
    });
    tx();
    return { message: this.getMessage(messageId)!, run: this.mustRun(runId) };
  }

  dispatchNextRun(workspaceKey: string): Run | undefined {
    // I-2 per workspace (N3b-2): a project conversation's key is its
    // project_id; a direct specialist conversation's is `specialist:<agentId>`
    // — COALESCE mirrors `workspaceKeyFor`. No `mustProject`: a specialist
    // workspace has no project row.
    const KEY = `COALESCE(c.project_id, 'specialist:' || c.agent_id)`;
    const tx = this.db.transaction((): Run | undefined => {
      const active = this.db
        .prepare(
          `SELECT r.id FROM runs r JOIN conversations c ON r.conversation_id = c.id
           WHERE ${KEY} = ? AND r.state IN ('starting','streaming') LIMIT 1`,
        )
        .get(workspaceKey) as { id: string } | undefined;
      if (active) return undefined;
      const next = this.db
        .prepare(
          `SELECT r.id FROM runs r JOIN conversations c ON r.conversation_id = c.id
           WHERE ${KEY} = ? AND r.state = 'queued' ORDER BY r.rowid LIMIT 1`,
        )
        .get(workspaceKey) as { id: string } | undefined;
      if (!next) return undefined;
      const res = this.db
        .prepare(`UPDATE runs SET state = 'starting' WHERE id = ? AND state = 'queued'`)
        .run(next.id);
      if (res.changes !== 1) throw new StaleStateError(next.id, 'queued');
      return this.mustRun(next.id);
    });
    return tx();
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
    const existing = this.mustRun(runId);
    const startedAt = to === 'streaming' ? this.now() : existing.startedAt;
    const res = this.db
      .prepare(
        `UPDATE runs SET state = ?, exec_id = ?, pgid = ?, seam_request_id = ?, started_at = ?
         WHERE id = ? AND state = ?`,
      )
      .run(
        to,
        patch.execId ?? existing.execId,
        patch.pgid ?? existing.pgid,
        patch.seamRequestId ?? existing.seamRequestId,
        startedAt,
        runId,
        from,
      );
    if (res.changes !== 1) throw new StaleStateError(runId, from);
    return this.mustRun(runId);
  }

  finalizeRun(input: FinalizeRunInput): Run {
    assertLegalTransition(input.runId, input.from, input.to);
    const existing = this.mustRun(input.runId);
    const now = this.now();
    const tx = this.db.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE runs SET state = ?, kill_outcome = ?, sweep_result = ?, error_code = ?, error_detail = ?, ended_at = ?
           WHERE id = ? AND state = ?`,
        )
        .run(
          input.to,
          input.killOutcome ?? existing.killOutcome,
          input.sweepResult ? JSON.stringify(input.sweepResult) : existing.sweepResult ? JSON.stringify(existing.sweepResult) : null,
          input.errorCode ?? null,
          input.errorDetail ?? null,
          now,
          input.runId,
          input.from,
        );
      if (res.changes !== 1) throw new StaleStateError(input.runId, input.from);
      if (input.assistantContent != null) {
        this.db
          .prepare(
            `INSERT INTO messages (id, conversation_id, role, content, run_id, created_at)
             VALUES (?, ?, 'assistant', ?, ?, ?)`,
          )
          .run(
            this.id('msg'),
            existing.conversationId,
            capMessageContent(input.assistantContent),
            input.runId,
            now,
          );
      }
      this.db
        .prepare(
          `INSERT INTO usage_records (run_id, total_cost_usd, num_turns, usage, source)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.usage.totalCostUsd,
          input.usage.numTurns,
          input.usage.usage == null ? null : JSON.stringify(input.usage.usage),
          input.usage.source,
        );
      this.db
        .prepare(`INSERT INTO run_summaries (run_id, summary) VALUES (?, ?)`)
        .run(input.runId, JSON.stringify(input.summary));
    });
    tx();
    return this.mustRun(input.runId);
  }

  setRunInitMeta(runId: string, meta: { cliVersion: string; model: string }): void {
    const existing = this.mustRun(runId);
    if (existing.cliVersion !== null) {
      if (existing.cliVersion === meta.cliVersion && existing.model === meta.model) return; // idempotent re-ingestion
      throw new ValidationError(`cliVersion/model are write-once (I-8) for run ${runId}`);
    }
    this.db
      .prepare(`UPDATE runs SET cli_version = ?, model = ? WHERE id = ? AND cli_version IS NULL`)
      .run(meta.cliVersion, meta.model, runId);
  }

  recordRunTarget(runId: string, targetSessionId: string, decision: ExecutionTargetDecision): void {
    const res = this.db
      .prepare(`UPDATE runs SET target_session_id = ?, target_decision = ? WHERE id = ?`)
      .run(targetSessionId, JSON.stringify(decision), runId);
    if (res.changes !== 1) throw new ValidationError(`no run ${runId} to record target on`);
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  getRunByMessage(messageId: string): Run | undefined {
    const row = this.db.prepare(`SELECT * FROM runs WHERE message_id = ?`).get(messageId) as
      | RunRow
      | undefined;
    return row ? toRun(row) : undefined;
  }

  listRunsByConversation(conversationId: string, opts: { limit?: number } = {}): Run[] {
    this.mustConversation(conversationId);
    const limit = opts.limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE conversation_id = ?
         ORDER BY rowid DESC LIMIT ?`,
      )
      .all(conversationId, limit) as RunRow[];
    return rows.map(toRun);
  }

  listRunsByState(states: RunState[]): Run[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM runs WHERE state IN (${placeholders}) ORDER BY rowid`)
      .all(...states) as RunRow[];
    return rows.map(toRun);
  }

  getQueuedRuns(projectId: string): Run[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM runs r JOIN conversations c ON r.conversation_id = c.id
         WHERE c.project_id = ? AND r.state = 'queued' ORDER BY r.rowid`,
      )
      .all(projectId) as RunRow[];
    return rows.map(toRun);
  }

  getActiveRun(projectId: string): Run | undefined {
    const row = this.db
      .prepare(
        `SELECT r.* FROM runs r JOIN conversations c ON r.conversation_id = c.id
         WHERE c.project_id = ? AND r.state IN ('starting','streaming') LIMIT 1`,
      )
      .get(projectId) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  // — events —

  ingestEvents(runId: string, events: NewRunEvent[]): { inserted: number } {
    const run = this.mustRun(runId);
    const tx = this.db.transaction((): number => {
      let inserted = 0;
      let replayableInserted = 0;
      for (const ev of events) {
        const res = this.db
          .prepare(
            `INSERT OR IGNORE INTO run_events (id, run_id, seq, type, payload, ts)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(ev.id, runId, ev.seq, ev.type, serializePayloadCapped(ev.payload), ev.ts);
        if (res.changes === 1) {
          inserted += 1;
          if ((REPLAYABLE_EVENT_TYPES as readonly string[]).includes(ev.type)) {
            replayableInserted += 1;
          }
        } else {
          const byId = this.db
            .prepare(`SELECT id FROM run_events WHERE id = ?`)
            .get(ev.id) as { id: string } | undefined;
          if (!byId) {
            throw new ValidationError(
              `run_event seq collision: (${runId}, ${ev.seq}) already taken by a different id (I-4)`,
            );
          }
          // duplicate id: idempotent no-op (I-4)
        }
      }
      if (replayableInserted > 0) {
        this.db
          .prepare(
            `INSERT INTO sse_cursor (conversation_id, next_seq) VALUES (?, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET next_seq = next_seq + excluded.next_seq`,
          )
          .run(run.conversationId, replayableInserted);
      }
      return inserted;
    });
    return { inserted: tx() };
  }

  getEvents(runId: string): RunEvent[] {
    this.mustRun(runId);
    const rows = this.db
      .prepare(`SELECT * FROM run_events WHERE run_id = ? ORDER BY seq`)
      .all(runId) as EventRow[];
    return rows.map(toEvent);
  }

  getEventsByRunIds(runIds: string[]): Map<string, RunEvent[]> {
    const result = new Map<string, RunEvent[]>();
    if (runIds.length === 0) return result;
    const placeholders = runIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM run_events WHERE run_id IN (${placeholders}) ORDER BY run_id, seq`)
      .all(...runIds) as EventRow[];
    for (const row of rows) {
      const ev = toEvent(row);
      const list = result.get(ev.runId);
      if (list) list.push(ev);
      else result.set(ev.runId, [ev]);
    }
    return result;
  }

  getReplayableEvents(conversationId: string, afterIndex = -1): ReplayableEvent[] {
    this.mustConversation(conversationId);
    const placeholders = REPLAYABLE_EVENT_TYPES.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT e.* FROM run_events e JOIN runs r ON e.run_id = r.id
         WHERE r.conversation_id = ? AND e.type IN (${placeholders})
         ORDER BY r.created_at, r.rowid, e.seq`,
      )
      .all(conversationId, ...REPLAYABLE_EVENT_TYPES) as EventRow[];
    return rows
      .map((row, index) => ({ index, event: toEvent(row) }))
      .filter((r) => r.index > afterIndex);
  }

  getSseCursor(conversationId: string): number {
    const row = this.db
      .prepare(`SELECT next_seq FROM sse_cursor WHERE conversation_id = ?`)
      .get(conversationId) as { next_seq: number } | undefined;
    return row?.next_seq ?? 0;
  }

  // — usage & summary —

  getUsage(runId: string): UsageRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM usage_records WHERE run_id = ?`).get(runId) as
      | {
          run_id: string;
          total_cost_usd: number | null;
          num_turns: number | null;
          usage: string | null;
          source: UsageRecord['source'];
        }
      | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id,
      totalCostUsd: row.total_cost_usd,
      numTurns: row.num_turns,
      usage: row.usage ? JSON.parse(row.usage) : null,
      source: row.source,
    };
  }

  getSummary(runId: string): RunSummary | undefined {
    const row = this.db.prepare(`SELECT summary FROM run_summaries WHERE run_id = ?`).get(runId) as
      | { summary: string }
      | undefined;
    return row ? (JSON.parse(row.summary) as RunSummary) : undefined;
  }

  getSummariesByRunIds(runIds: string[]): Map<string, RunSummary> {
    const result = new Map<string, RunSummary>();
    if (runIds.length === 0) return result;
    const placeholders = runIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT run_id, summary FROM run_summaries WHERE run_id IN (${placeholders})`)
      .all(...runIds) as Array<{ run_id: string; summary: string }>;
    for (const row of rows) result.set(row.run_id, JSON.parse(row.summary) as RunSummary);
    return result;
  }

  // — tasks (N5a, ADR-009/010) —

  createTask(input: CreateTaskInput): Task {
    this.mustProject(input.projectId);
    const now = this.now();
    const id = this.id('task');
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, source_conversation_id, source_message_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'planning', ?, ?)`,
      )
      .run(id, input.projectId, input.sourceConversationId ?? null, input.sourceMessageId ?? null, now, now);
    return this.getTask(id)!;
  }

  getTask(id: string): Task | undefined {
    const r = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
    return r ? toTask(r) : undefined;
  }

  listTasks(opts: { projectId?: string; sourceConversationId?: string } = {}): Task[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.projectId) {
      where.push('project_id = ?');
      params.push(opts.projectId);
    }
    if (opts.sourceConversationId) {
      where.push('source_conversation_id = ?');
      params.push(opts.sourceConversationId);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM tasks${clause} ORDER BY rowid`)
      .all(...params) as TaskRow[];
    return rows.map(toTask);
  }

  listTasksByState(states: TaskState[]): Task[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE state IN (${placeholders}) ORDER BY rowid`)
      .all(...states) as TaskRow[];
    return rows.map(toTask);
  }

  transitionTask(taskId: string, from: TaskState, to: TaskState): Task {
    assertLegalTaskTransition(taskId, from, to);
    const res = this.db
      .prepare(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND state = ?`)
      .run(to, this.now(), taskId, from);
    if (res.changes !== 1) throw new StaleTaskStateError(taskId, from);
    return this.getTask(taskId)!;
  }

  setTaskPullRequestUrl(taskId: string, url: string): Task {
    const res = this.db
      .prepare(`UPDATE tasks SET pull_request_url = ?, updated_at = ? WHERE id = ?`)
      .run(url, this.now(), taskId);
    if (res.changes !== 1) throw new NotFoundError('task', taskId);
    return this.getTask(taskId)!;
  }

  appendTaskFeedback(taskId: string, note: string): Task {
    const tx = this.db.transaction((): void => {
      const row = this.db.prepare(`SELECT pending_feedback FROM tasks WHERE id = ?`).get(taskId) as
        | { pending_feedback: string | null }
        | undefined;
      if (!row) throw new NotFoundError('task', taskId);
      const queue = row.pending_feedback ? (JSON.parse(row.pending_feedback) as string[]) : [];
      queue.push(note);
      this.db
        .prepare(`UPDATE tasks SET pending_feedback = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(queue), this.now(), taskId);
    });
    tx();
    return this.getTask(taskId)!;
  }

  drainTaskFeedback(taskId: string): string[] {
    let drained: string[] = [];
    const tx = this.db.transaction((): void => {
      const row = this.db.prepare(`SELECT pending_feedback FROM tasks WHERE id = ?`).get(taskId) as
        | { pending_feedback: string | null }
        | undefined;
      if (!row) throw new NotFoundError('task', taskId);
      drained = row.pending_feedback ? (JSON.parse(row.pending_feedback) as string[]) : [];
      if (drained.length > 0) {
        this.db.prepare(`UPDATE tasks SET pending_feedback = NULL WHERE id = ?`).run(taskId);
      }
    });
    tx();
    return drained;
  }

  createTaskStep(input: CreateTaskStepInput): TaskStep {
    if (!this.getTask(input.taskId)) throw new NotFoundError('task', input.taskId);
    const now = this.now();
    const id = this.id('step');
    const access = input.workspaceAccess ? JSON.stringify(input.workspaceAccess) : null;
    const tx = this.db.transaction((): string => {
      const seq =
        (this.db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM task_steps WHERE task_id = ?`).get(
          input.taskId,
        ) as { n: number }).n;
      this.db
        .prepare(
          `INSERT INTO task_steps (id, task_id, seq, kind, specialist_id, workspace_access, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.taskId, seq, input.kind, input.specialistId, access, now);
      return id;
    });
    tx();
    return toTaskStep(this.db.prepare(`SELECT * FROM task_steps WHERE id = ?`).get(id) as TaskStepRow);
  }

  getTaskStep(id: string): TaskStep | undefined {
    const row = this.db.prepare(`SELECT * FROM task_steps WHERE id = ?`).get(id) as
      | TaskStepRow
      | undefined;
    return row ? toTaskStep(row) : undefined;
  }

  listTaskSteps(taskId: string): TaskStep[] {
    const rows = this.db
      .prepare(`SELECT * FROM task_steps WHERE task_id = ? ORDER BY seq`)
      .all(taskId) as TaskStepRow[];
    return rows.map(toTaskStep);
  }

  setTaskStepRuntimeSessionId(taskStepId: string, runtimeSessionId: string): void {
    const res = this.db
      .prepare(`UPDATE task_steps SET runtime_session_id = ? WHERE id = ?`)
      .run(runtimeSessionId, taskStepId);
    if (res.changes !== 1) throw new NotFoundError('task step', taskStepId);
  }

  addWorkProduct(input: NewWorkProduct): WorkProduct {
    if (!this.getTask(input.taskId)) throw new NotFoundError('task', input.taskId);
    const now = this.now();
    const id = this.id('wp');
    this.db
      .prepare(
        `INSERT INTO work_products (id, task_id, task_step_id, kind, producer_specialist_id, run_id, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.taskStepId ?? null,
        input.kind,
        input.producerSpecialistId,
        input.runId ?? null,
        JSON.stringify(input.body),
        now,
      );
    return toWorkProduct(this.db.prepare(`SELECT * FROM work_products WHERE id = ?`).get(id) as WorkProductRow);
  }

  listWorkProducts(taskId: string): WorkProduct[] {
    const rows = this.db
      .prepare(`SELECT * FROM work_products WHERE task_id = ? ORDER BY rowid`)
      .all(taskId) as WorkProductRow[];
    return rows.map(toWorkProduct);
  }

  // — internals —

  private mustProject(id: string): Project {
    const p = this.getProject(id);
    if (!p) throw new NotFoundError('project', id);
    return p;
  }

  private mustConversation(id: string): Conversation {
    const c = this.getConversation(id);
    if (!c) throw new NotFoundError('conversation', id);
    return c;
  }

  private mustRun(id: string): Run {
    const r = this.getRun(id);
    if (!r) throw new NotFoundError('run', id);
    return r;
  }
}
