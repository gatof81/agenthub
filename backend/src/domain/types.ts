/**
 * Domain types — canonical names from docs/06-domain-model.md.
 * The domain module depends on nothing (07 §2: dependencies point inward).
 */

export type ProjectStatus = 'provisioning' | 'ready' | 'error' | 'archived';
export type ConversationStatus = 'active' | 'archived';
export type MessageRole = 'user' | 'assistant';

export type RunState =
  | 'queued'
  | 'starting'
  | 'streaming'
  | 'completed'
  | 'completed_with_denials'
  | 'cancelled'
  | 'interrupted'
  | 'failed';

export type TerminalRunState =
  | 'completed'
  | 'completed_with_denials'
  | 'cancelled'
  | 'failed';

export type RunEventType =
  | 'started'
  | 'output'
  | 'tool_use'
  | 'permission_denial'
  | 'exit'
  | 'error'
  | 'unknown';

export type UsageSource = 'result-event' | 'cancelled-unknown' | 'error-partial';
export type KillOutcome = 'already-exited' | 'terminated' | 'killed';

/** Error taxonomy (08 §6). */
export type RunErrorCode =
  | 'provisioning_failed'
  | 'seam_unavailable'
  | 'exec_refused'
  | 'run_timeout'
  | 'budget_exceeded'
  | 'cancelled'
  | 'runtime_error'
  | 'internal';

/** Per-run caps snapshot (FR-17); every run gets one (I-8: immutable after queued). */
export interface Caps {
  maxTurns: number;
  budgetUsd: number;
  timeoutMs: number;
}

/** Agent = professional role, config-defined in Phase 1 (FR-02); stateless template (18 §2). */
export interface Agent {
  id: string;
  name: string;
  instructions: string;
  allowedTools: string[]; // mandatory, never empty-meaning-all (FR-11, SEC-02)
  sessionTemplateId: string;
  runtime: 'claude-cli';
  defaultCaps: Caps;
}

/** SessionBinding value object on Project (06 §2): the substrate seam reference. */
export interface SessionBinding {
  sessionId: string | null;
  templateId: string | null;
  /** UX cache only (FR-33) — never a basis for decisions the seam can answer live. */
  lastKnownState: string | null;
}

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  defaultAgentId: string;
  instructions: string | null; // sensitive: seeded via agentSeed, never logged
  sessionBinding: SessionBinding;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  projectId: string; // immutable (I-10)
  title: string;
  agentId: string; // immutable in Phase 1 (I-6)
  status: ConversationStatus;
  /** The CLI's own session id used for --resume (FR-24) — a runtime session, NOT a substrate session (06 §1). */
  runtimeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  runId: string | null;
  createdAt: string;
}

/** Post-cancel sweep outcome (FR-21, ADR-003). */
export interface SweepResult {
  matched: number;
  killed: string[];
  survivors: string[];
}

export interface Run {
  id: string;
  conversationId: string;
  messageId: string; // the triggering user message (I-1)
  state: RunState;
  execId: string | null; // seam handles, set by the started event
  pgid: number | null;
  seamRequestId: string | null; // X-Request-Id join (OPS-04)
  capsSnapshot: Caps;
  policySnapshot: string[]; // non-empty (I-7)
  cliVersion: string | null; // write-once at init event (I-8)
  model: string | null;
  killOutcome: KillOutcome | null;
  sweepResult: SweepResult | null;
  errorCode: RunErrorCode | null;
  errorDetail: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface RunEvent {
  id: string; // idempotency key (I-4)
  runId: string;
  seq: number; // (runId, seq) unique, ordering key (I-4)
  type: RunEventType;
  payload: unknown; // capped at 64 KiB post-truncation (08 §2)
  ts: string;
}

export interface UsageRecord {
  runId: string;
  totalCostUsd: number | null; // all null when source = cancelled-unknown (FR-18)
  numTurns: number | null;
  usage: unknown | null;
  source: UsageSource;
}

/**
 * RunSummary (FR-42): mechanically derived, never model-generated; 1:1 with
 * terminal runs, written in the terminal transition's transaction (I-11).
 * The first Work Product — carries the family envelope (18 §4).
 */
export interface RunSummary {
  runId: string;
  objective: string; // user-message excerpt
  outcome: TerminalRunState;
  filesTouched: string[];
  commandsRun: string[];
  denialCount: number;
  warnings: string[]; // capped stderr excerpts
  costUsd: number | null; // null = unknown (UX-06)
  numTurns: number | null;
  durationMs: number | null;
  runtimeSessionId: string | null; // continuation handle
}
