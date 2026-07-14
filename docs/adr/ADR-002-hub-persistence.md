# ADR-002 — Hub-owned persistence

Status: proposed — decision taken, acceptance gated on spike S-03
Date: 2026-07-14

Substrate evidence cited at [shared-terminal](https://github.com/gatof81/shared-terminal) `main` @ `36be2f2`
(`d1Query`: `backend/src/db.ts:81`; `DockerManager.reconcile()`: `backend/src/dockerManager.ts:2254`).

## Context

The Hub owns its data: conversations, messages, agents, runs, run events,
usage records. It never touches shared-terminal's D1 (separate repos, no
data-layer coupling). The write pattern is chat-shaped: every turn produces one
message row plus a burst of run events (tool_use activity, state transitions,
a usage record) — tens of writes per turn, read back immediately by the UI.

Deployment shape (decided with the owner, resolves Q-05): the Hub mirrors
shared-terminal's own topology — long-lived Node backend co-located on the
substrate's host behind the Cloudflare tunnel, frontend on Cloudflare Pages,
seam to the substrate over localhost. The owner's platform directive:
**stay on the Cloudflare stack (D1, R2, Workers ecosystem) for operational
consistency across projects.** A Workers-based *backend* was considered and
set aside: ADR-001's seam consumes long-lived NDJSON streams and keeps
process state (run queue, exec registry, boot reconciliation); on Workers
that requires Durable Objects + Queues — new moving parts against the
anti-over-architecture rule — and forces the seam onto the public tunnel
hostname. Revisit only at Agent Nodes time (Phase 5) if remote execution
changes the calculus.

## Options

### Do nothing — append-only JSON files, no database (rejected)

Chat history could be JSONL per conversation. Fails on first contact with the
product: the activity view queries across runs (files touched, commands, cost
per conversation), run state must survive crashes consistently
(half-written JSON lines corrupt silently), and every later phase (registry,
router, budgets) is relational. A database is the boring, justified piece.

### SQLite local (rejected — was the technical lean)

Real transactions, zero network round-trips, perfect fit for a single-replica
co-located backend. Rejected on the owner's operational-consistency directive,
whose costs are real but bounded (below), and whose benefits are also real:

- **Backup story comes free.** D1 has Time Travel (30-day point-in-time
  restore). SQLite on the host means designing and *operating* a
  snapshot/retention/restore pipeline for the Hub's only copy of every
  conversation — an ongoing operational liability for a solo owner, not a
  one-time design task.
- One platform's tooling, dashboards, and failure modes across projects.
- No irreplaceable state on the host beyond session workspaces.

### Postgres (rejected)

No failing constraint justifies it: one user, one replica, personal chat
volume. Operating a Postgres instance (or paying for a managed one) buys
nothing SQLite/D1 don't already provide at this scale. Anti-over-architecture
rule applies (risk R-10).

### Own D1 database (chosen)

A dedicated D1 database for the Hub, accessed from the co-located Node backend
over Cloudflare's HTTP API — the same access pattern shared-terminal's
`d1Query` uses today, with known, proven mitigations for its two structural
costs:

1. **Every query is a network round-trip.** Mitigations, all house patterns in
   the substrate: batch event writes per turn (no per-delta rows — one batch
   at run completion plus periodic checkpoints for long runs), keep hot-path
   query counts low and counted, cache reads the UI re-requests.
2. **No multi-statement transactions.** Mitigations: atomic
   `UPDATE … WHERE <expected-state>` + affected-rows check for run state
   transitions; idempotent event ingestion (event ids, `INSERT OR IGNORE`);
   reconcile-on-boot for runs, mirroring `DockerManager.reconcile()`'s
   pattern. Small inconsistency windows remain; reconciliation heals them.

## Decision

**A Hub-owned D1 database**, with the mitigations above as design requirements
for doc 09 (persistence). R2 is the designated blob store *when a blob need
appears* (exports, attachments, large fixtures); the MVP schema has none —
adding it now would be shelf-ware (R-10).

**Acceptance gate — spike S-03 (required by the kickoff for the D1 path):**
before this ADR flips to accepted, S-03 measures against a scratch D1
database:

- p50/p95 latency of a realistic turn commit (1 message + batched events +
  usage record) from the co-located host;
- practical value-size limits (event payloads, long assistant messages);
- quota math: writes/reads per simulated turn × expected personal volume vs
  D1 plan limits, with ≥10× headroom.

**Revert criteria** (agreed): if S-03 shows turn-commit p50 > 150 ms from the
host, or quota headroom < 10×, the decision reverts to SQLite local and this
ADR is superseded — the repository interface (below) makes that a contained
swap.

## Consequences

- **Repository interface from day 1**: all persistence behind a
  `HubStore`-style port; SQLite remains the documented fallback and the
  fake/in-memory implementation doubles as the test store. This was already
  required by R-13 (replica-agnostic contracts); D1 makes it non-negotiable.
- Risks revived from the discovery register (they were dropped when D1 was
  off the table): **R-14 (RTT/cost on chat volume)** and **R-15
  (non-transactionality → inconsistent run state)** — see
  [16-risk-register.md](../16-risk-register.md).
- S-03 moves from "conditional" to **required**; it needs a scratch D1
  database and a Cloudflare API token — owner-coordinated like S-01. No real
  database identifiers land in this repo (R-09).
- Doc 09 (persistence) inherits hard requirements: batching design, idempotent
  ingestion, reconcile-on-boot, query-count budget per endpoint.
- The Hub backend needs Cloudflare API credentials on the host (scoped token,
  D1-only) — threat-model input for doc 10.
- Q-05 (deployment) closes: shared-terminal shape. Q-06 (frontend framework)
  stays open but its deployment target (Pages) is now fixed.
