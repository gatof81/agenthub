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
/**
 * A reusable professional identity (01 §1, ADR-008 calls it a **Specialist**):
 * stateless role config, no workspace of its own (ADR-006). `role` and
 * `capabilities` (N3, ADR-008) describe what it is and what it can do — the
 * inputs the future router (N4) selects on; both optional so pre-N3 configs
 * still load. Kept named `Agent` here to avoid a repo-wide rename mid-flight;
 * the API surfaces it as `/api/specialists`.
 */
export interface Agent {
  id: string;
  name: string;
  instructions: string;
  allowedTools: string[]; // mandatory, never empty-meaning-all (FR-11, SEC-02)
  runtime: 'claude-cli';
  defaultCaps: Caps;
  /** professional role, e.g. "Software Developer", "QA Specialist" (ADR-008). */
  role?: string;
  /** free-form capability tags the router selects on (ADR-008, N4). */
  capabilities?: string[];
}

/**
 * Who functionally owns the project's substrate session (ADR-007, N2).
 * `owner` — the owner's admin account: the Hub is only an execution identity
 * there and must never stop, start, or delete the session on its own accord.
 * `legacy-technical` — the Hub's own seam account (pre-correction estate, and
 * template-created sessions until shared-terminal#420 enables
 * create-on-behalf): the Hub owns the lifecycle, as before.
 */
export type SessionOwnership = 'owner' | 'legacy-technical';

/** How the project got its session (ADR-007, FR-49). */
export type BindingMode = 'existing' | 'created';

/** SessionBinding value object on Project (06 §2): the substrate seam reference. */
export interface SessionBinding {
  sessionId: string | null;
  templateId: string | null;
  /** UX cache only (FR-33) — never a basis for decisions the seam can answer live. */
  lastKnownState: string | null;
  /** `existing` = bound to a session the owner already had (FR-49). */
  bindingMode: BindingMode;
  /** Substrate account owning the session; null = unrecorded (legacy rows). */
  ownerAccountId: string | null;
  ownership: SessionOwnership;
}

/**
 * The repo credential (FR-47, SEC-11). Crosses the Hub in memory on the way
 * to the seam's encrypted session config and is never persisted here — the
 * Hub cannot leak what it does not hold. A fine-grained PAT scoped to this
 * one repository (owner decision, 2026-07-16), so a leak reaches one repo.
 */
export type RepoAuth = { kind: 'none' } | { kind: 'pat'; pat: string };

/** Where a project's work happens (ADR-006, FR-45) — the project's, never the agent's. */
export interface RepoSpec {
  url: string;
  ref?: string;
  /** workspace-relative clone target; empty/absent = workspace root */
  target?: string;
}

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  defaultAgentId: string;
  /**
   * The substrate template this project's session is created from. Lives
   * here, not on `Agent`: an agent is a stateless role reusable across
   * projects (18 §2), so it cannot own a workspace — one DEV-Agent must be
   * able to work on two different repos (ADR-006, FR-45).
   */
  sessionTemplateId: string | null;
  /**
   * The repository cloned into the workspace. `auth` is deliberately NOT
   * here: the PAT reaches the seam's encrypted session config directly and
   * is never stored by the Hub (FR-47, SEC-11).
   */
  repo: RepoSpec | null;
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
  /**
   * The agent's craft as it read when this run was queued (B5-04, I-8).
   * `null` ONLY for pre-B5-04 runs, where it was never recorded — never "the
   * role declared none", which config load forbids.
   *
   * Deployment-private (SEC-10) but not a credential: it rides the authed run
   * detail as one of that route's snapshots (08 §1), which is the audit surface
   * the snapshot exists for. It must still never reach a log or a run event —
   * the no-payload-logging rule already makes the first a compile error.
   */
  instructionsSnapshot: string | null;
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
