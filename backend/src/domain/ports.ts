/**
 * Ports — domain boundaries (06 §4). Interfaces live here so consumers
 * (orchestrator, api) depend only on the domain; implementations live in
 * their own modules (substrate/, runtime/) and are wired at the composition
 * root, keeping the 07 §2 dependency arrows lint-enforceable.
 */

import type {
  Caps,
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
  /** agentSeed material (02 §3): agent settings + project instructions. */
  settings?: unknown;
  claudeMd?: string;
}

export interface SubstrateExecPort {
  /** UC-01: provision the project's substrate session from a template. */
  createSession(templateId: string, seed: SessionSeed): Promise<{ sessionId: string }>;
  /** Archiving a project stops its session (08 §1 PATCH semantics, FR-30). */
  stopSession(sessionId: string): Promise<void>;
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
