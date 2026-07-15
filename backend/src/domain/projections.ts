/**
 * Pure projections over persisted run data (06 §2: "Activity is a
 * projection, not an entity" — derived on read, nothing double-written; A2)
 * and the mechanical RunSummary derivation (FR-42: never model-generated,
 * deterministic, available even for cancelled runs).
 */

import type {
  Run,
  RunEvent,
  RunSummary,
  TerminalRunState,
  UsageRecord,
} from './types.js';

export interface ActivityItem {
  kind: 'command' | 'file' | 'denial';
  detail: string;
  seq: number;
}

export interface Activity {
  commands: string[];
  files: string[];
  denials: string[];
  items: ActivityItem[];
}

interface ToolUsePayload {
  name?: string;
  input?: { command?: string; file_path?: string };
}

interface DenialPayload {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
}

/** Commands and files touched derive from tool_use events (A2, FR-14). */
export function deriveActivity(events: RunEvent[]): Activity {
  const items: ActivityItem[] = [];
  for (const ev of events) {
    if (ev.type === 'tool_use') {
      const p = ev.payload as ToolUsePayload;
      const command = p?.input?.command;
      const filePath = p?.input?.file_path;
      if (typeof command === 'string' && command.length > 0) {
        items.push({ kind: 'command', detail: command, seq: ev.seq });
      } else if (typeof filePath === 'string' && filePath.length > 0) {
        items.push({ kind: 'file', detail: filePath, seq: ev.seq });
      }
    } else if (ev.type === 'permission_denial') {
      const p = ev.payload as DenialPayload;
      items.push({ kind: 'denial', detail: p?.tool_name ?? 'unknown-tool', seq: ev.seq });
    }
  }
  return {
    commands: items.filter((i) => i.kind === 'command').map((i) => i.detail),
    files: [...new Set(items.filter((i) => i.kind === 'file').map((i) => i.detail))],
    denials: items.filter((i) => i.kind === 'denial').map((i) => i.detail),
    items,
  };
}

const OBJECTIVE_MAX = 280;
const WARNING_MAX = 500;
const WARNINGS_CAP = 5;

export interface SummaryInputs {
  run: Run;
  outcome: TerminalRunState;
  events: RunEvent[];
  usage: Pick<UsageRecord, 'totalCostUsd' | 'numTurns'>;
  userMessageContent: string;
  /** capped stderr excerpts collected during the run */
  warnings: string[];
  runtimeSessionId: string | null;
  endedAt: string;
}

/** Mechanical derivation (FR-42) — the first Work Product (18 §4). */
export function deriveRunSummary(inputs: SummaryInputs): RunSummary {
  const activity = deriveActivity(inputs.events);
  const startedAt = inputs.run.startedAt;
  const durationMs = startedAt
    ? Math.max(0, Date.parse(inputs.endedAt) - Date.parse(startedAt))
    : null;
  const objective =
    inputs.userMessageContent.length > OBJECTIVE_MAX
      ? `${inputs.userMessageContent.slice(0, OBJECTIVE_MAX)}…`
      : inputs.userMessageContent;
  return {
    runId: inputs.run.id,
    objective,
    outcome: inputs.outcome,
    filesTouched: activity.files,
    commandsRun: activity.commands,
    denialCount: activity.denials.length,
    warnings: inputs.warnings.slice(0, WARNINGS_CAP).map((w) => w.slice(0, WARNING_MAX)),
    costUsd: inputs.usage.totalCostUsd,
    numTurns: inputs.usage.numTurns,
    durationMs,
    runtimeSessionId: inputs.runtimeSessionId,
  };
}

/**
 * SSE wire events derivable from ONE replayable run_event row (08 §3).
 * Used identically by the live path and the Last-Event-ID replay path so
 * both produce the same projection (ADR-004).
 */
export type SseWireEvent =
  | { event: 'message.delta'; data: { runId: string; messageId: string; text: string } }
  | {
      event: 'activity.item';
      data: { runId: string; kind: 'command' | 'file' | 'denial'; detail: string };
    };

export function sseFromRunEvent(messageId: string, ev: RunEvent): SseWireEvent[] {
  if (ev.type === 'output') {
    const p = ev.payload as OutputPayload;
    if (p?.blockType === 'text' && typeof p.text === 'string' && p.text.length > 0) {
      return [{ event: 'message.delta', data: { runId: ev.runId, messageId, text: p.text } }];
    }
    return [];
  }
  const items = deriveActivity([ev]).items;
  return items.map((i) => ({
    event: 'activity.item' as const,
    data: { runId: ev.runId, kind: i.kind, detail: i.detail },
  }));
}

interface OutputPayload {
  blockType?: string;
  text?: string;
}

/** Assistant text assembled from the run's stream (06 §Message). */
export function assembleAssistantText(events: RunEvent[]): string {
  return events
    .filter((e) => e.type === 'output')
    .map((e) => e.payload as OutputPayload)
    .filter((p) => p?.blockType === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}
