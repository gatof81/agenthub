/**
 * Ports — domain boundaries (06 §4). Interfaces live here so consumers
 * (orchestrator, api) depend only on the domain; implementations live in
 * their own modules (substrate/, runtime/) and are wired at the composition
 * root, keeping the 07 §2 dependency arrows lint-enforceable.
 */

import type {
  Caps,
  RepoAuth,
  RepoSpec,
  KillOutcome,
  ProjectStatus,
  RunErrorCode,
  RunEvent,
  RunEventType,
  RunState,
  RunSummary,
  SweepResult,
  UsageRecord,
} from './types.js';

// — SubstrateExecPort (ADR-001, contracts/shared-terminal-exec-api.md) —

/** NDJSON events of the seam's exec stream (contract: v:1). */
export type SeamEvent =
  | { v: 1; type: 'started'; execId: string; pgid: number; requestId: string }
  | { v: 1; type: 'output'; stream: 'stdout' | 'stderr'; data: string }
  | { v: 1; type: 'dropped'; scope: 'pre-start'; bytes: number }
  | { v: 1; type: 'exit'; exitCode: number | null; reason: string }
  | { v: 1; type: 'error'; message: string };

export interface ExecRequest {
  argv: string[];
  stdin?: string;
  env?: Record<string, string>;
  /** Always bounded (FR-17); the seam's 1 h backstop sits behind it. */
  maxDurationMs: number;
}

export interface ExecStatus {
  /** `unknown` covers registry-lost and never-existed alike (contract delta). */
  state: 'running' | 'exited' | 'unknown';
  exitCode?: number | null;
}

export interface SessionSeed {
  /**
   * agentSeed material (02 §3): the PROJECT's instructions. Its craft, not any
   * agent's — the role travels per turn (B5-04, `TurnRequest.instructions`).
   */
  claudeMd?: string;
  /**
   * The project's repository, cloned into the workspace at bootstrap
   * (FR-45). The seam's session config owns the clone; the Hub declares it.
   */
  repo?: RepoSpec;
  /**
   * Repo credential (FR-46/47). Travels to the seam and is never persisted
   * Hub-side. Deliberately NOT a field of `repo`: keeping the stored half
   * and the secret half as separate values means no code path can pass them
   * around as one object and write them together (SEC-11).
   */
  repoAuth?: RepoAuth;
  /**
   * `settings` is absent by design (S-05), though the seam's agentSeed accepts
   * it. Seeding it wrote the provisioning agent's allowlist into the
   * workspace's user-level settings file — one role's tools baked into a
   * workspace every role shares (ADR-006), which is what B5-04 removed for
   * instructions. It was also redundant: tools travel per turn as
   * `--allowedTools` (I-7).
   *
   * S-05 measured the blast radius on CLI 2.1.207: a settings file DOES widen
   * a turn's tools past `--allowedTools` via `permissions.allow` — but the key
   * the Hub happened to write, `allowedTools`, that version ignores. The seed
   * was inert by luck, not by design, and a version that starts honoring it
   * would silently grant every conversation the provisioning role's tools.
   * The field is gone rather than merely unused so that re-seeding is a port
   * change with a spike behind it, not a one-line regression.
   *
   * Deployment-wide settings still have a home: the workspace TEMPLATE carries
   * its own agentSeed, which the seam preserves when the seed omits the field.
   * That is the right layer — the template is the project's (FR-45), so
   * nothing there wears an agent's identity.
   */
}

/**
 * The session a restore targets no longer exists upstream (FR-44). Lives in
 * domain, not substrate: it is part of the port's contract, and the
 * orchestrator must catch it — `orchestrator → substrate` is not a legal
 * dependency arrow (07 §2), `→ domain` is.
 *
 * Distinct from a transport failure: retrying never helps, and the workspace
 * is gone with it, so the project must stay archived rather than be handed a
 * fresh, empty session wearing its name.
 */
export class SessionGoneError extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} no longer exists upstream — its workspace is gone (FR-44)`);
    this.name = 'SessionGoneError';
  }
}

/**
 * One substrate session as discovery sees it (N1, FR-48, ADR-007). Deliberately
 * NOT the seam's full wire row: `envVars` is excluded — session env can carry
 * secrets, and this shape flows to the Hub API and UI (SEC-04/05); `cols`/
 * `rows`/container details are terminal concerns the Hub has no use for.
 */
export interface SessionInfo {
  sessionId: string;
  name: string;
  /** substrate authority (FR-33): running | stopped | terminated | failed */
  status: string;
  /**
   * Substrate account that owns the session (ADR-007). Attribution comes from
   * the admin-wide listing; in `own` scope it is the execution identity
   * itself. `null` only when the seam offered no attribution.
   */
  ownerUsername: string | null;
  createdAt: string | null;
  lastConnectedAt: string | null;
}

export interface SessionListing {
  /**
   * `all` — admin-wide listing with per-row owner attribution (the ADR-007
   * target: the execution identity is admin-flagged and sees the owner's
   * sessions). `own` — the execution identity lacks the admin flag and can
   * see only its own sessions (the legacy-technical estate); surfaced so the
   * UI can say what it is NOT seeing instead of presenting a partial list as
   * the whole (FR-48).
   */
  scope: 'all' | 'own';
  sessions: SessionInfo[];
}

export interface SubstrateExecPort {
  /** UC-01: provision the project's substrate session from a template. */
  createSession(templateId: string, seed: SessionSeed): Promise<{ sessionId: string }>;
  /**
   * Session discovery (N1, FR-48): list the sessions the Hub can see, with
   * ownership and state. Read-only; the substrate stays the authority.
   */
  listSessions(): Promise<SessionListing>;
  /**
   * Single-session metadata; `null` when the session no longer exists
   * upstream (a state to surface, never to repair — ADR-007, FR-44).
   */
  getSession(sessionId: string): Promise<SessionInfo | null>;
  /** Archiving a project stops its session (08 §1 PATCH semantics, FR-30). */
  stopSession(sessionId: string): Promise<void>;
  /**
   * Restoring a project restarts its session — the inverse of `stopSession`
   * (FR-43). The workspace is a host directory, so it survived the stop: the
   * session comes back with the same files and the same CLI transcripts
   * under them, which is what preserves FR-24 `--resume` continuity.
   *
   * Rejects with `SessionGoneError` when the session no longer exists
   * upstream (hard-deleted, taking its workspace). That is a distinct
   * outcome from a transport failure, and callers must not paper over it by
   * provisioning a replacement (FR-44).
   */
  startSession(sessionId: string): Promise<void>;
  exec(sessionId: string, req: ExecRequest): AsyncIterable<SeamEvent>;
  status(sessionId: string, execId: string): Promise<ExecStatus>;
  kill(sessionId: string, execId: string, graceMs: number): Promise<{ outcome: KillOutcome }>;
}

// — RuntimeAdapter (ADR-003) —

export interface TurnRequest {
  prompt: string;
  /** The run's policy snapshot — never absent (I-7). */
  policy: string[];
  caps: Caps;
  /** --resume handle; null on a conversation's first turn (FR-24). */
  runtimeSessionId: string | null;
  env: Record<string, string>;
  /**
   * The agent's craft, carried per turn (B5-04, ADR-006). `null` ONLY for a
   * pre-B5-04 run whose role was never recorded — unrecorded, not absent: a
   * role cannot declare an empty craft, because config load rejects a blank
   * one. There is no legitimate declared-none case to open a path for; such a
   * run omits `--append-system-prompt` and relies on the baked CLAUDE.md its
   * pre-B5-04 workspace still carries.
   *
   * Per turn rather than baked into the workspace at provisioning: several
   * roles share one project's workspace (ADR-006), so a CLAUDE.md written
   * once would run every conversation under the provisioning agent's
   * instructions — a QA conversation under DEV's craft. The project's own
   * instructions still belong in the workspace; they are the project's, and
   * every role in it shares them.
   */
  instructions: string | null;
}

/**
 * What an adapter yields while running a turn. `event` items are persisted
 * as RunEvents by the orchestrator (seq assigned there); the rest are
 * control metadata (ADR-003 mapping).
 */
export type AdapterItem =
  | { kind: 'started'; execId: string; pgid: number; requestId: string }
  | { kind: 'event'; type: RunEventType; payload: unknown }
  | { kind: 'init'; cliVersion: string; model: string; runtimeSessionId: string }
  /**
   * Per-assistant-message token usage (B3-06). Surfaced mid-stream so the
   * orchestrator's lagging budget estimate (ADR-003, R-06) can trip before
   * the terminal result event. The estimate lags by up to one model call.
   */
  | {
      kind: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  | {
      kind: 'result';
      resultText: string;
      totalCostUsd: number | null;
      numTurns: number | null;
      usage: unknown;
      permissionDenialCount: number;
      runtimeSessionId: string | null;
      isError: boolean;
    }
  | { kind: 'stderr'; data: string }
  | { kind: 'exit'; exitCode: number | null; reason?: string };

export interface RuntimeAdapter {
  /** Drives one exec through the substrate port and maps its stream. */
  runTurn(sessionId: string, turn: TurnRequest): AsyncIterable<AdapterItem>;
  kill(sessionId: string, execId: string, graceMs: number): Promise<{ outcome: KillOutcome }>;
  status(sessionId: string, execId: string): Promise<ExecStatus>;
  /**
   * Resolves once this runtime can actually run a turn in `sessionId`, or
   * rejects when it cannot within the adapter's deadline (B3-08).
   *
   * A provisioned session is NOT the same as a runnable one: the seam's
   * readiness signals (bootstrap log persisted, status not `failed`) say the
   * Hub's own bootstrap finished, not that the runtime's binary resolves.
   * Only the adapter knows what its runtime needs, so the check lives here
   * rather than in the substrate port.
   */
  awaitReady(sessionId: string): Promise<void>;
}

// — HubNotifier (ADR-004 delivery projection; the store stays the truth) —

export interface RunStateNotification {
  runId: string;
  state: RunState;
  errorCode?: RunErrorCode | null;
  killOutcome?: KillOutcome | null;
  sweepResult?: SweepResult | null;
}

/** A persisted replayable run_event row with its conversation-wide index. */
export interface IndexedRunEvent {
  index: number;
  event: RunEvent;
}

/**
 * One-way, in-process notifications the orchestrator emits so the SSE layer
 * (ADR-004) can deliver live projections. Losing a notification loses
 * nothing: every payload is recomputable from the store (NFR-07).
 */
export interface HubNotifier {
  runState(conversationId: string, n: RunStateNotification): void;
  replayable(conversationId: string, runMessageId: string, rows: IndexedRunEvent[]): void;
  usage(conversationId: string, usage: UsageRecord): void;
  summary(conversationId: string, summary: RunSummary): void;
  projectState(projectId: string, status: ProjectStatus): void;
}

export const NOOP_NOTIFIER: HubNotifier = {
  runState: () => {},
  replayable: () => {},
  usage: () => {},
  summary: () => {},
  projectState: () => {},
};

// — Observability (B3-07, OPS-04, 14 §1/§2) —

/**
 * Structured logger. Fields are ids/types/counts ONLY — never run-event
 * payloads, secrets, or tokens (SEC-04/05, 13 §5). Implementations attach
 * the request correlation id from ambient context.
 */
export interface Logger {
  info(event: string, fields?: Record<string, string | number | boolean | null>): void;
  warn(event: string, fields?: Record<string, string | number | boolean | null>): void;
  error(event: string, fields?: Record<string, string | number | boolean | null>): void;
}

/** Process-local counters (14 §2); gauges are computed on read from the store. */
export interface Metrics {
  runTransition(to: RunState): void;
  seamError(): void;
}

export const NOOP_LOGGER: Logger = { info: () => {}, warn: () => {}, error: () => {} };
export const NOOP_METRICS: Metrics = { runTransition: () => {}, seamError: () => {} };
