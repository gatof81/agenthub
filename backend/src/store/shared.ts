/**
 * Validation and capping shared by both HubStore implementations so the fake
 * and SQLite cannot drift on input semantics (NFR-03).
 */

import { Buffer } from 'node:buffer';
import {
  MESSAGE_CONTENT_CAP_BYTES,
  PAYLOAD_CAP_BYTES,
  ValidationError,
  type SendMessageInput,
} from './types.js';

/**
 * 08 §2: oversized payloads are truncated to the cap with `truncated: true`
 * and the original byte count. A `head` excerpt keeps the payload useful.
 * Returns the JSON string to persist (always ≤ PAYLOAD_CAP_BYTES).
 */
export function serializePayloadCapped(payload: unknown): string {
  const raw = JSON.stringify(payload) ?? 'null';
  if (Buffer.byteLength(raw, 'utf8') <= PAYLOAD_CAP_BYTES) return raw;

  const overheadProbe = JSON.stringify({
    truncated: true,
    originalBytes: Buffer.byteLength(raw, 'utf8'),
    head: '',
  });
  const budget = PAYLOAD_CAP_BYTES - Buffer.byteLength(overheadProbe, 'utf8') - 64;
  let head = raw.slice(0, budget);
  // JSON-escaping can inflate the head; shrink until the envelope fits.
  let out = JSON.stringify({
    truncated: true,
    originalBytes: Buffer.byteLength(raw, 'utf8'),
    head,
  });
  while (Buffer.byteLength(out, 'utf8') > PAYLOAD_CAP_BYTES && head.length > 0) {
    head = head.slice(0, Math.floor(head.length / 2));
    out = JSON.stringify({
      truncated: true,
      originalBytes: Buffer.byteLength(raw, 'utf8'),
      head,
    });
  }
  return out;
}

/** 09 §6: message content capped at 256 KiB — truncate with marker. */
export function capMessageContent(content: string): string {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes <= MESSAGE_CONTENT_CAP_BYTES) return content;
  let head = content.slice(0, MESSAGE_CONTENT_CAP_BYTES);
  while (Buffer.byteLength(head, 'utf8') > MESSAGE_CONTENT_CAP_BYTES - 128) {
    head = head.slice(0, Math.floor(head.length * 0.9));
  }
  return `${head}\n…[truncated: original ${bytes} bytes]`;
}

/** I-7 (SEC-01/02): a run without an explicit, non-empty allowlist must be unrepresentable. */
export function validateSendMessage(input: SendMessageInput): void {
  if (!Array.isArray(input.policy) || input.policy.length === 0) {
    throw new ValidationError('policy snapshot must be a non-empty allowlist (I-7)');
  }
  if (input.policy.some((t) => typeof t !== 'string' || t.trim() === '')) {
    throw new ValidationError('policy snapshot entries must be non-empty strings (I-7)');
  }
  if (typeof input.content !== 'string' || input.content.length === 0) {
    throw new ValidationError('message content must be a non-empty string');
  }
  const { maxTurns, budgetUsd, timeoutMs } = input.caps;
  // maxTurns + timeoutMs are the always-on bounds; budgetUsd is optional (null =
  // no cap, ADR-003) and only validated when set.
  if (!(maxTurns > 0) || !(timeoutMs > 0) || (budgetUsd !== null && !(budgetUsd > 0))) {
    throw new ValidationError(
      'caps: maxTurns and timeoutMs must be positive; budgetUsd, if set, must be positive (FR-17)',
    );
  }
}
