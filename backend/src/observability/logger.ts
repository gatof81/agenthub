/**
 * Structured JSON logger (B3-07, 14 §1). One line per event, machine-
 * readable, carrying the request correlation id from ambient async context
 * (AsyncLocalStorage) so a log emitted deep in a run traces back to the
 * inbound request (OPS-04). Fields are ids/types/counts only — the type
 * signature (Logger) forbids arbitrary objects, and this module never
 * stringifies payloads (SEC-04/05, 13 §5).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from '../domain/ports.js';

type Fields = Record<string, string | number | boolean | null>;

const correlationStore = new AsyncLocalStorage<string>();

/** Run `fn` with `id` as the ambient correlation id for every nested log. */
export function withCorrelation<T>(id: string, fn: () => T): T {
  return correlationStore.run(id, fn);
}

/** The current ambient correlation id, if inside a withCorrelation scope. */
export function currentCorrelationId(): string | undefined {
  return correlationStore.getStore();
}

export interface JsonLoggerOptions {
  /** sink; defaults to process.stdout. Tests inject a capture. */
  write?: (line: string) => void;
  /** clock for the ts field; injectable for deterministic tests. */
  now?: () => Date;
}

export class JsonLogger implements Logger {
  private readonly write: (line: string) => void;
  private readonly now: () => Date;

  constructor(opts: JsonLoggerOptions = {}) {
    this.write = opts.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = opts.now ?? (() => new Date());
  }

  private emit(level: 'info' | 'warn' | 'error', event: string, fields?: Fields): void {
    const record: Record<string, unknown> = {
      ts: this.now().toISOString(),
      level,
      event,
    };
    const cid = currentCorrelationId();
    if (cid !== undefined) record['cid'] = cid;
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        // reserved keys never overwritten by caller fields
        if (k !== 'ts' && k !== 'level' && k !== 'event' && k !== 'cid') record[k] = v;
      }
    }
    this.write(JSON.stringify(record));
  }

  info(event: string, fields?: Fields): void {
    this.emit('info', event, fields);
  }
  warn(event: string, fields?: Fields): void {
    this.emit('warn', event, fields);
  }
  error(event: string, fields?: Fields): void {
    this.emit('error', event, fields);
  }
}
