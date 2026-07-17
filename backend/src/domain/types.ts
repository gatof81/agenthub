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

/** Reusable professional identity (FR-02, 18 §2, ADR-008); named `Agent` to avoid a mid-flight rename — surfaced as `/api/specialists`. */
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

/** A specialist's personal-session usability (ADR-008). `busy` is unused: I-2 serialization is enforced by the dispatch transaction, not a cached status. */
export type SpecialistSessionStatus = 'available' | 'busy' | 'offline' | 'error';

/**
 * A specialist's optional personal session (ADR-008, N3b): a standing session
 * in the owner's account for the specialist's general, project-less work.
 * Bound or created exactly like a project's (ADR-007) — reusing the N2
 * machinery — so `ownership`/`bindingMode` mean the same thing. At most one
 * per specialist (specialistId is the key). Project work does NOT run here
 * (18 §2 knowledge-isolation): it uses the project's session or a worktree.
 */
export interface SpecialistSessionBinding {
  /** the config specialist's id (agents.yaml) — not a stored entity */
  specialistId: string;
  sessionId: string;
  ownerAccountId: string | null;
  ownership: SessionOwnership;
  bindingMode: BindingMode;
  /** seam status cache (FR-33); the substrate stays the authority */
  lastKnownState: string | null;
  status: SpecialistSessionStatus;
}

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

/**
 * How the conversation picks its specialist (ADR-008). N3b-2 uses only
 * `direct` (a pinned specialist, or a project's agent); `automatic` and
 * `preferred-specialist` arrive with the N4 router.
 */
export type ConversationMode = 'direct' | 'preferred-specialist' | 'automatic';

export interface Conversation {
  id: string;
  /**
   * The project this conversation belongs to, or `null` for a direct
   * conversation with a specialist (N3b-2, ADR-008) — which runs in the
   * specialist's personal session, not a project's. Never changes once set
   * (I-10 relaxed to "immutable once set").
   */
  projectId: string | null;
  title: string;
  agentId: string; // the agent (project) or specialist (direct); immutable in direct mode (I-6)
  mode: ConversationMode;
  status: ConversationStatus;
  /** The CLI's own session id used for --resume (FR-24) — a runtime session, NOT a substrate session (06 §1). */
  runtimeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The workspace a conversation's runs serialize on (I-2, N3b-2): the project
 * id for a project conversation, or `specialist:<agentId>` for a direct
 * specialist conversation (which runs in the specialist's personal session).
 * "The lock follows the workspace" (18 §2).
 */
export function workspaceKeyFor(c: Pick<Conversation, 'projectId' | 'agentId'>): string {
  return c.projectId ?? `specialist:${c.agentId}`;
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
