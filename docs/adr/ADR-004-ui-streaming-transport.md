# ADR-004 — Hub ↔ frontend streaming transport

Status: proposed
Date: 2026-07-14

Scope: how the browser receives live run events and assistant deltas
(FR-05, NFR-07). Framework choice stays with doc 11 (Q-06); every option
here is framework-agnostic.

## Context

The UI needs a one-way, resumable stream per conversation: assistant text
deltas, run state changes, activity items. All commands travel the other way
as plain HTTP (send message, cancel run) — enforcement lives in the backend
(SEC-01), so nothing needs a bidirectional channel. Persisted `RunEvent`s are
the source of truth (NFR-07): the transport is a delivery optimization, never
the record.

## Options

### WebSocket (rejected)

Bidirectional capability nobody needs (commands are POSTs with their own
auth/validation path); upgrade handling bypasses middleware (the substrate
carries CSWSH defence + upgrade rate limiting for exactly this reason — same
argument as ADR-001 option A); reconnection and replay are hand-rolled.

### Raw NDJSON over fetch streaming (rejected)

Works, and matches the seam (ADR-001) — but that choice was for a
*backend-to-backend* consumer. In a browser it means hand-rolled reconnect,
buffering, and lifecycle handling that `EventSource` gives for free.

### Server-Sent Events (chosen)

`GET /conversations/:id/events` as `text/event-stream`:

- **Native reconnection with `Last-Event-ID`** maps 1:1 onto the persisted
  `(runId, seq)` ordering — on reconnect the Hub replays from the store, so
  no in-memory replay buffer is needed and nothing is lost across Hub
  restarts either (the exact property the seam deliberately does NOT provide,
  ADR-001; the Hub can provide it because persistence is its job).
- One-way matches the actual data flow; commands stay on POST.
- Plain HTTP: existing middleware (auth, correlation ids, rate limits) and
  the Cloudflare tunnel path apply unchanged; `EventSource` is consumable
  from any framework doc 11 might pick.
- Single-replica broadcaster stays process-local; the *contract* (event ids +
  replay-from-store) is replica-agnostic (R-13/NFR-05).

## Decision

SSE per conversation, `Last-Event-ID` backed by the store, heartbeat comments
to keep intermediaries from idling the connection out. Event payloads on this
surface are the UI projection (deltas, state, activity), not raw `RunEvent`
rows — doc 08 defines the schema.

## Consequences

- Doc 08 specifies the SSE event names/payloads and the replay semantics;
  doc 13 tests reconnect-with-gap against the store.
- The in-process broadcaster is a plain pub/sub keyed by conversation —
  no new infrastructure (R-10).
- If Phase 5 (remote Agent Nodes) ever demands bidirectional server push,
  that is a new surface with its own ADR, not a retrofit of this one.
