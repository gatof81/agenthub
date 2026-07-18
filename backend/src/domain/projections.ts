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
  kind: 'command' | 'file' | 'denial' | 'tool';
  detail: string;
  /** the tool that produced this step (e.g. 'Bash', 'Edit', 'Grep'); for a
   *  denial it is the blocked tool. Absent only on legacy rows. */
  tool?: string;
  seq: number;
}

export interface Activity {
  commands: string[];
  files: string[];
  denials: string[];
  items: ActivityItem[];
}

/** The placeholder title a conversation is born with, until its first message
 * or an explicit rename earns it a real one (11 §9). Shared so the create
 * default and the auto-title guard can never drift apart. */
export const DEFAULT_CONVERSATION_TITLE = 'New conversation';

/**
 * A short, human title derived from a conversation's first user message, so the
 * sidebar reads as distinct threads instead of a wall of the default (11 §9).
 * Collapsed to one line and cut on a word boundary near 48 chars
 * with an ellipsis when trimmed. Returns '' when there is no titleable text, so
 * the caller keeps the default.
 */
export function deriveConversationTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return '';
  const MAX = 48;
  if (oneLine.length <= MAX) return oneLine;
  const cut = oneLine.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

interface ToolUsePayload {
  name?: string;
  input?: Record<string, unknown>;
}

interface DenialPayload {
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
}

const HINT_MAX = 80;

/**
 * A short, best-effort descriptor for a tool that is neither a shell command
 * nor a file edit — Grep, Glob, WebFetch, Task, an MCP tool. Reads the first
 * present of a handful of common input fields (a pattern, a url, a query…) so a
 * step reads as "Grep: TODO" rather than a bare "Grep". Returns '' when nothing
 * legible is present; the tool name alone still carries the step.
 */
function toolHint(input: Record<string, unknown> | undefined): string {
  for (const key of ['pattern', 'query', 'url', 'description', 'path', 'prompt']) {
    const v = input?.[key];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > HINT_MAX ? `${v.slice(0, HINT_MAX)}…` : v;
    }
  }
  return '';
}

/**
 * Activity derives from tool_use events (A2, FR-14). Every tool surfaces: a
 * shell command and a file edit keep their dedicated kinds (they feed the
 * RunSummary's commandsRun/filesTouched), and every OTHER tool becomes a
 * generic `tool` step carrying its name — so a turn that ran Grep/Glob/WebFetch
 * is no longer invisible between the text and the command list.
 */
export function deriveActivity(events: RunEvent[]): Activity {
  const items: ActivityItem[] = [];
  for (const ev of events) {
    if (ev.type === 'tool_use') {
      const p = ev.payload as ToolUsePayload;
      const name = typeof p?.name === 'string' && p.name.length > 0 ? p.name : 'tool';
      const command = p?.input?.['command'];
      const filePath = p?.input?.['file_path'];
      if (typeof command === 'string' && command.length > 0) {
        items.push({ kind: 'command', detail: command, tool: name, seq: ev.seq });
      } else if (typeof filePath === 'string' && filePath.length > 0) {
        items.push({ kind: 'file', detail: filePath, tool: name, seq: ev.seq });
      } else {
        items.push({ kind: 'tool', detail: toolHint(p?.input), tool: name, seq: ev.seq });
      }
    } else if (ev.type === 'permission_denial') {
      const p = ev.payload as DenialPayload;
      const name = p?.tool_name ?? 'unknown-tool';
      items.push({ kind: 'denial', detail: name, tool: name, seq: ev.seq });
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
      data: {
        runId: string;
        kind: 'command' | 'file' | 'denial' | 'tool';
        detail: string;
        tool?: string;
      };
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
    data: { runId: ev.runId, kind: i.kind, detail: i.detail, ...(i.tool ? { tool: i.tool } : {}) },
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
