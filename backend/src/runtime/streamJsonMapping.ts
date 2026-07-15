/**
 * The ADR-003 stream-json → RunEvent mapping, as pure logic. This module is
 * the ONLY place that understands the CLI's stream-json (07 §2); the fake
 * adapter replays fixtures through it and the real claude-cli adapter (
 * Increment 2) must produce identical streams from the same fixtures — the
 * R-12 contract test hangs off this file.
 */

import type { AdapterItem } from '../domain/ports.js';

interface StreamJsonEnvelope {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  claude_code_version?: string;
  message?: { content?: Array<Record<string, unknown>> };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: unknown;
  permission_denials?: Array<Record<string, unknown>>;
}

const RAW_CAP = 16 * 1024;

function capRaw(line: string): string {
  return line.length > RAW_CAP ? line.slice(0, RAW_CAP) : line;
}

/** Maps one CLI stream-json line to adapter items (ADR-003 event mapping). */
export function mapStreamJsonLine(line: string): AdapterItem[] {
  const trimmed = line.trim();
  if (trimmed === '') return [];

  let parsed: StreamJsonEnvelope;
  try {
    parsed = JSON.parse(trimmed) as StreamJsonEnvelope;
  } catch {
    // Not JSON at all — preserve verbatim (FR-16), capped.
    return [
      { kind: 'event', type: 'unknown', payload: { originalType: 'unparseable', raw: capRaw(trimmed) } },
    ];
  }

  switch (parsed.type) {
    case 'system': {
      if (parsed.subtype === 'init') {
        return [
          {
            kind: 'init',
            cliVersion: parsed.claude_code_version ?? 'unknown',
            model: parsed.model ?? 'unknown',
            runtimeSessionId: parsed.session_id ?? '',
          },
        ];
      }
      return [
        {
          kind: 'event',
          type: 'unknown',
          payload: { originalType: `system/${parsed.subtype ?? '?'}`, raw: capRaw(trimmed) },
        },
      ];
    }

    case 'assistant': {
      const items: AdapterItem[] = [];
      for (const block of parsed.message?.content ?? []) {
        const blockType = block['type'];
        if (blockType === 'text') {
          items.push({
            kind: 'event',
            type: 'output',
            payload: { blockType: 'text', text: String(block['text'] ?? '') },
          });
        } else if (blockType === 'tool_use') {
          items.push({
            kind: 'event',
            type: 'tool_use',
            payload: { name: block['name'], input: block['input'], id: block['id'] },
          });
        } else if (blockType === 'thinking') {
          // internal reasoning: persisted but never part of the answer text
          items.push({
            kind: 'event',
            type: 'output',
            payload: { blockType: 'thinking' },
          });
        } else {
          items.push({
            kind: 'event',
            type: 'unknown',
            payload: { originalType: `assistant/${String(blockType)}`, raw: capRaw(trimmed) },
          });
        }
      }
      return items;
    }

    case 'user':
      // tool results echoed back into the transcript (ADR-003: user turns → output)
      return [
        {
          kind: 'event',
          type: 'output',
          payload: { blockType: 'tool_result' },
        },
      ];

    case 'result': {
      const items: AdapterItem[] = [];
      const denials = parsed.permission_denials ?? [];
      for (const d of denials) {
        items.push({ kind: 'event', type: 'permission_denial', payload: d });
      }
      items.push({
        kind: 'result',
        resultText: parsed.result ?? '',
        totalCostUsd: parsed.total_cost_usd ?? null,
        numTurns: parsed.num_turns ?? null,
        usage: parsed.usage ?? null,
        permissionDenialCount: denials.length,
        runtimeSessionId: parsed.session_id ?? null,
        isError: parsed.is_error === true,
      });
      return items;
    }

    default:
      // rate_limit_event, future types … (FR-16: preserved verbatim, capped)
      return [
        {
          kind: 'event',
          type: 'unknown',
          payload: { originalType: parsed.type ?? '?', raw: capRaw(trimmed) },
        },
      ];
  }
}

/** Reassembles NDJSON lines from arbitrarily-split stream chunks. */
export class LineBuffer {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.filter((l) => l.trim() !== '');
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest === '' ? [] : [rest];
  }
}
