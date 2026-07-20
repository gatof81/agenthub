/**
 * HubStore port (06 §4): ALL persistence; transactions live here (09 §3).
 * Two implementations — SQLite (real) and in-memory (fake) — must pass the
 * identical contract suite, including guarded-update rejections (NFR-03,
 * 13 §2).
 */

import type {
  RepoSpec,
  Caps,
  Conversation,
  ConversationMode,
  ConversationStatus,
  ExecutionTargetDecision,
  KillOutcome,
  Message,
  Project,
  ProjectStatus,
  Run,
  RunErrorCode,
  RunEvent,
  RunEventType,
  RunState,
  RunSummary,
  SessionBinding,
  SpecialistSessionBinding,
  SweepResult,
  DelegatedWorkspaceAccess,
  Task,
  TaskState,
  TaskStep,
  TerminalRunState,
  UsageRecord,
  UsageSource,
  WorkProduct,
  ImplementationReport,
  QaReport,
} from '../domain/types.js';

export interface CreateProjectInput {
  name: string;
  defaultAgentId: string;
  /**
   * The project's workspace (ADR-006, FR-45) — never the agent's. Still a
   * required KEY (an optional field let a direct-store caller compile
   * without it and exercise the null path by accident); `null` is legal only
   * on the bind path (FR-49), where an existing session is the workspace and
   * there is no template to declare.
   */
  sessionTemplateId: string | null;
  /** `auth` is absent by design: the PAT goes to the seam, never here (FR-47, SEC-11) */
  repo?: RepoSpec | null;
  instructions?: string | null;
}

export interface CreateConversationInput {
  /** null = a direct conversation with a specialist (N3b-2), no project */
  projectId: string | null;
  title: string;
  agentId: string;
  /** defaults to 'direct' (N3b-2, ADR-008) */
  mode?: ConversationMode;
}

export interface SendMessageInput {
  conversationId: string;
  content: string;
  caps: Caps;
  /** Non-empty (I-7): a run without an explicit allowlist must be unrepresentable. */
  policy: string[];
  /**
   * The agent's craft at queue time (B5-04). Required, not optional: a role
   * always declares one (config load rejects a blank), so a run that does not
   * record what it ran under should be unrepresentable.
   * `Run.instructionsSnapshot` is nullable only to admit pre-B5-04 rows,
   * never new ones.
   */
  instructions: string;
  /**
   * Links this run to a task step (N5b, ADR-009) when the supervisor runs a
   * specialist turn as a step. `undefined`/absent for an ordinary chat run.
   * A step run skips routing — its specialist is already chosen (see
   * `resolveRunSession`).
   */
  taskStepId?: string;
}

/** Patch applied alongside a guarded non-terminal transition. */
export interface RunTransitionPatch {
  execId?: string;
  pgid?: number;
  seamRequestId?: string;
}

export interface FinalizeRunInput {
  runId: string;
  /** Guarded expected current state. */
  from: RunState;
  to: TerminalRunState;
  /** When present, the assistant message is inserted in the same transaction. */
  assistantContent?: string | null;
  usage: {
    totalCostUsd: number | null;
    numTurns: number | null;
    usage: unknown | null;
    source: UsageSource;
  };
  summary: RunSummary;
  errorCode?: RunErrorCode;
  errorDetail?: string;
  killOutcome?: KillOutcome;
  sweepResult?: SweepResult;
}

export interface NewRunEvent {
  id: string;
  seq: number;
  type: RunEventType;
  payload: unknown;
  ts: string;
}

/**
 * A run_event row in the conversation's stable replay order (run createdAt,
 * run id, seq) together with its zero-based position among the conversation's
 * REPLAYABLE rows (output / tool_use / permission_denial). Feeds the SSE
 * Last-Event-ID replay (ADR-004, 09 §sse_cursor).
 */
export interface ReplayableEvent {
  index: number;
  event: RunEvent;
}

export interface HubStore {
  close(): void;

  // — projects —
  createProject(input: CreateProjectInput): Project;
  getProject(id: string): Project | undefined;
  listProjects(opts?: { includeArchived?: boolean }): Project[];
  /** Rename / archive / provisioning lifecycle (UC-01, FR-40). */
  updateProject(
    id: string,
    patch: { name?: string; status?: ProjectStatus; instructions?: string | null },
  ): Project;
  setProjectSession(id: string, binding: Partial<SessionBinding>): Project;

  // — specialist sessions (N3b-1, ADR-008) — the specialist is config; only
  // its optional personal-session binding is state. Upsert by specialistId.
  setSpecialistSession(binding: SpecialistSessionBinding): SpecialistSessionBinding;
  getSpecialistSession(specialistId: string): SpecialistSessionBinding | undefined;
  listSpecialistSessions(): SpecialistSessionBinding[];

  // — conversations —
  createConversation(input: CreateConversationInput): Conversation;
  getConversation(id: string): Conversation | undefined;
  listConversations(opts?: { projectId?: string; includeArchived?: boolean }): Conversation[];
  /** Title/status only — projectId (I-10) and agentId (I-6) have no update path. */
  updateConversation(
    id: string,
    patch: { title?: string; status?: ConversationStatus },
  ): Conversation;
  setRuntimeSessionId(conversationId: string, runtimeSessionId: string): void;

  // — messages —
  getMessage(id: string): Message | undefined;
  listMessages(conversationId: string, opts?: { before?: string; limit?: number }): Message[];
  /**
   * Batch variant: the most recent message of each conversation in one query,
   * keyed by conversationId (a conversation with no messages is absent from
   * the map). Avoids the N+1 when the conversation list (sidebar) attaches a
   * preview to every row — one query instead of one per conversation.
   */
  getLastMessagesByConversationIds(conversationIds: string[]): Map<string, Message>;

  // — run lifecycle (the 09 §3 transactions) —
  /** One tx: insert user message + insert run(queued) (UC-02). */
  sendMessage(input: SendMessageInput): { message: Message; run: Run };
  /**
   * One tx: promote the oldest queued run of the project to `starting` IFF no
   * run of the project is active (I-2 per-project serialization, FIFO FR-04).
   * Returns undefined when nothing is dispatchable.
   */
  /**
   * Dispatch the next queued run for a WORKSPACE (I-2 serialized, FIFO).
   * The key is the project id for a project conversation, or
   * `specialist:<agentId>` for a direct specialist conversation (N3b-2) —
   * `workspaceKeyFor` computes it. One active run per workspace.
   */
  dispatchNextRun(workspaceKey: string): Run | undefined;
  /**
   * Guarded non-terminal transition (I-3): asserts legality against the 05
   * machine and that the row is currently in `from` (StaleStateError
   * otherwise). Transition to `streaming` stamps startedAt.
   */
  transitionRun(runId: string, from: RunState, to: RunState, patch?: RunTransitionPatch): Run;
  /**
   * One tx (09 §3 terminal transition): guarded state change + optional
   * assistant message + usage record (I-5) + summary (I-11) + endedAt.
   */
  finalizeRun(input: FinalizeRunInput): Run;
  /** Write-once (I-8): rejects overwrite of an already-recorded value. */
  setRunInitMeta(runId: string, meta: { cliVersion: string; model: string }): void;
  /**
   * Record the execution-target selector's decision on a run (ADR-008,
   * automatic mode, N4a; migration 007). Called once at dispatch, before the
   * turn executes, so the run inspector shows who ran, where, and why —
   * durably, not only in flight. Direct runs never call this (their session is
   * derived, not selected), so `targetSessionId`/`targetDecision` stay null.
   */
  recordRunTarget(runId: string, targetSessionId: string, decision: ExecutionTargetDecision): void;
  getRun(id: string): Run | undefined;
  getRunByMessage(messageId: string): Run | undefined;
  /** Reconciler + queue rebuild (09 §2 partial index). */
  listRunsByState(states: RunState[]): Run[];
  getQueuedRuns(projectId: string): Run[];
  getActiveRun(projectId: string): Run | undefined;

  // — events —
  /**
   * One tx: batched idempotent ingestion (INSERT OR IGNORE on id, I-4) +
   * sse_cursor bump by the number of newly inserted REPLAYABLE rows.
   * Oversized payloads are truncated at ingestion (08 §2, 64 KiB cap).
   */
  ingestEvents(runId: string, events: NewRunEvent[]): { inserted: number };
  getEvents(runId: string): RunEvent[];
  /**
   * Batch variant of getEvents: the events for many runs in one query, keyed by
   * runId (a runId with no events is absent from the map). Avoids the N+1 when a
   * conversation read segments every assistant turn (A) — one query instead of
   * one per message.
   */
  getEventsByRunIds(runIds: string[]): Map<string, RunEvent[]>;
  /** Replayable rows of a conversation after a cursor position (SSE replay). */
  getReplayableEvents(conversationId: string, afterIndex?: number): ReplayableEvent[];
  getSseCursor(conversationId: string): number;

  // — usage & summary —
  getUsage(runId: string): UsageRecord | undefined;
  getSummary(runId: string): RunSummary | undefined;

  // — tasks: developer → QA → human-approval lifecycle (N5a, ADR-009/010) —
  /** Create a task in `planning` — coordinated work born from a routed message. */
  createTask(input: CreateTaskInput): Task;
  getTask(id: string): Task | undefined;
  listTasks(opts?: { projectId?: string; sourceConversationId?: string }): Task[];
  /** Tasks currently in any of `states` (boot reconcile — ADR-009 "Boot reconciliation of tasks"; UC-06 covers runs). Empty `states` → []. */
  listTasksByState(states: TaskState[]): Task[];
  /**
   * Guarded transition (I-13) against the task state machine: asserts legality
   * and that the row is currently in `from` (StaleTaskStateError otherwise),
   * one tx, stamps updatedAt. Terminal transitions are legal here (a task ends
   * in `approved`/`rejected`/`failed`); there is no separate finalize.
   */
  transitionTask(taskId: string, from: TaskState, to: TaskState): Task;
  /** Record the PR opened on approval (N6b). */
  setTaskPullRequestUrl(taskId: string, url: string): Task;
  /** Append a step; its `seq` is the next in the task's order. */
  createTaskStep(input: CreateTaskStepInput): TaskStep;
  getTaskStep(id: string): TaskStep | undefined;
  listTaskSteps(taskId: string): TaskStep[];
  /** Record a work product (ImplementationReport/QaReport, 18 §4 envelope). */
  addWorkProduct(input: NewWorkProduct): WorkProduct;
  listWorkProducts(taskId: string): WorkProduct[];
}

export interface CreateTaskInput {
  projectId: string;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
}

export interface CreateTaskStepInput {
  taskId: string;
  kind: TaskStep['kind'];
  specialistId: string;
  /** the audited workspace grant for this step (ADR-010 §71, N5b-2); absent → NULL. */
  workspaceAccess?: DelegatedWorkspaceAccess | null;
}

/** A work product to record; the id/createdAt are assigned by the store. */
export type NewWorkProduct = {
  taskId: string;
  taskStepId?: string | null;
  producerSpecialistId: string;
  runId?: string | null;
} & (
  | { kind: 'implementation_report'; body: ImplementationReport }
  | { kind: 'qa_report'; body: QaReport }
);

/** Event types that participate in SSE Last-Event-ID replay (08 §3). */
export const REPLAYABLE_EVENT_TYPES: readonly RunEventType[] = [
  'output',
  'tool_use',
  'permission_denial',
];

/** 08 §2: RunEvent payload cap. */
export const PAYLOAD_CAP_BYTES = 64 * 1024;
/** 09 §6: message content cap. */
export const MESSAGE_CONTENT_CAP_BYTES = 256 * 1024;

export class NotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
