/**
 * The seam-event → adapter-item loop shared by every RuntimeAdapter
 * implementation: drives one exec through the SubstrateExecPort, reassembles
 * NDJSON lines from stdout chunks, and maps them per ADR-003. Command
 * construction is the only per-runtime difference (fake vs claude-cli).
 */

import type {
  AdapterItem,
  ExecRequest,
  SubstrateExecPort,
} from '../domain/ports.js';
import { LineBuffer, mapStreamJsonLine } from './streamJsonMapping.js';

export async function* runExecThroughMapping(
  port: SubstrateExecPort,
  sessionId: string,
  req: ExecRequest,
): AsyncIterable<AdapterItem> {
  const lines = new LineBuffer();
  for await (const seamEvent of port.exec(sessionId, req)) {
    switch (seamEvent.type) {
      case 'started':
        yield {
          kind: 'started',
          execId: seamEvent.execId,
          pgid: seamEvent.pgid,
          requestId: seamEvent.requestId,
        };
        break;
      case 'output':
        if (seamEvent.stream === 'stdout') {
          for (const line of lines.push(seamEvent.data)) {
            yield* mapStreamJsonLine(line);
          }
        } else {
          yield { kind: 'stderr', data: seamEvent.data };
        }
        break;
      case 'dropped':
        // signaled, not silent (contract delta) — persisted per FR-16
        yield {
          kind: 'event',
          type: 'unknown',
          payload: { originalType: 'dropped', scope: seamEvent.scope, bytes: seamEvent.bytes },
        };
        break;
      case 'error':
        yield { kind: 'event', type: 'error', payload: { message: seamEvent.message } };
        break;
      case 'exit':
        for (const line of lines.flush()) {
          yield* mapStreamJsonLine(line);
        }
        yield {
          kind: 'exit',
          exitCode: seamEvent.exitCode,
          ...(seamEvent.reason !== undefined ? { reason: seamEvent.reason } : {}),
        };
        break;
    }
  }
}
