# 04 — Requirements (Phase 1)

**Status:** approved (owner, 2026-07-15) · **Last updated:** 2026-07-16

Scope: the Phase-1 MVP ([03-scope-and-phases.md](./03-scope-and-phases.md)).
Later phases contribute only constraints that would be expensive to retrofit
(marked `forward`). IDs are stable and never reused. Priority: `M` (must,
Phase-1 exit) / `S` (should, Phase-1 if cheap) / `F` (forward constraint).

Every requirement cites its source — an ADR, a spike finding, a risk, or an
open-question resolution — so the spec stays falsifiable. Sources:
[ADR-001](./adr/ADR-001-shared-terminal-exec-seam.md) ·
[ADR-002](./adr/ADR-002-hub-persistence.md) ·
[S-01](./spikes/S-01/RESULTS.md) · [S-03](./spikes/S-03/RESULTS.md) ·
[15-open-questions](./15-open-questions.md) · [16-risk-register](./16-risk-register.md).

## 1. Functional — conversations & messages

| ID | P | Requirement | Source |
| --- | --- | --- | --- |
| FR-01 | M | Create, list, rename, and archive conversations **within a project**. Each conversation is bound to exactly one agent in Phase 1 (defaulting from the project) | 03 §2, ADR-005 |
| FR-02 | M | Phase 1 agents are defined in configuration (identity, instructions, allowlist, session template binding) — no registry UI | 03 §2 (A4), Phase-2 boundary |
| FR-03 | M | Sending a message creates exactly one run (1 message = 1 run) | Q-03 |
| FR-04 | M | Messages sent while a run is active are queued and dispatched in order after it finishes; the queue survives cancellation of the active run | Q-03 |
| FR-05 | M | The assistant's answer streams into the conversation as it is produced | 03 §2 |
| FR-06 | M | Conversation history and run outcomes survive Hub restarts and substrate session recreates | 01 §9; substrate property (02 §1) |

## 1b. Functional — projects (ADR-005)

| ID | P | Requirement | Source |
| --- | --- | --- | --- |
| FR-40 | M | Create, list, rename, and archive projects. Creating a project provisions its substrate session (workspace); archiving stops it. Archive is reversible (FR-43), never a purge | ADR-005, UC-01 |
| FR-41 | M | Conversations belong to exactly one project (immutable) and share its workspace; project `defaultAgentId` and `instructions` seed new conversations and the session | ADR-005, I-10 |
| FR-42 | M | Every terminal run produces a persisted, **mechanically derived** `RunSummary` (objective excerpt, outcome, files, commands, denials, warnings, cost, duration, continuation handle) — written in the terminal transition's transaction | owner direction (2026-07-14), 06 §RunSummary |
| FR-43 | M | List archived projects and conversations, and **restore** them. Restoring a project **restarts its substrate session** — the symmetric inverse of FR-40's stop. The workspace survives the stop (it is a host directory, not container state), so restoring returns the same workspace and the CLI transcripts under it, and FR-24 `--resume` continuity is preserved | owner decision (2026-07-16), UC-11 |
| FR-44 | M | A restore whose substrate session no longer exists **fails with a typed error and leaves the project archived** — it never silently provisions a fresh workspace. A hard-deleted session takes its workspace with it; presenting an empty workspace as a restored project would misrepresent lost work, and the conversations' `runtimeSessionId` would dangle | owner decision (2026-07-16), UC-11, FR-33 |

## 2. Functional — runs & the runner

| ID | P | Requirement | Source |
| --- | --- | --- | --- |
| FR-10 | M | A run executes the agent's runtime as **one process per turn** (`claude -p --resume <session>` for the Claude runtime) via the exec seam | Q-01 (S-01: ~0.6 s to first event) |
| FR-11 | M | The runner always passes the agent's **curated `--allowedTools` allowlist**; no run may start without an explicit permission policy | Q-02, R-03 |
| FR-12 | M | Every run records: runtime CLI version, session id, model, start/end, exit status, and its permission policy | R-02, S-01 (iv) |
| FR-13 | M | Run events are ingested from the runtime's stream-json output and persisted **idempotently** (event ids; safe re-ingestion) | ADR-002; R-15 pattern kept as hygiene |
| FR-14 | M | Activity (commands run, files touched) derives from `tool_use` events (`input.command`, `input.file_path`), never from filesystem diffs | A2, S-01 (v) |
| FR-15 | M | **`permission_denials` is a first-class run outcome**: a run that "succeeds" with denials is shown as partially completed, with the denied tools and inputs visible | S-01 (i) — silent auto-denial |
| FR-16 | M | Unknown stream event types (e.g. `rate_limit_event`) are persisted and passed through without breaking ingestion | S-01 (v) |
| FR-17 | M | Every run enforces: max turns, budget cap, wall-clock timeout | 03 (hard limits), R-06 |
| FR-18 | M | A `UsageRecord` per run captures the result event's cost/usage fields; **cancelled runs record usage as `unknown`** (no result event exists) | A3, S-01 (iii/iv) |
| FR-19 | M | Runs are serialized per session — with ADR-005, that means **one active run per project** at a time | R-11, Q-03, Q-11 |

## 3. Functional — cancellation & recovery

| ID | P | Requirement | Source |
| --- | --- | --- | --- |
| FR-20 | M | The user can cancel an in-flight run; cancellation maps to the seam's kill endpoint (TERM→poll→KILL) and the run is marked `cancelled` with the kill outcome recorded | ADR-001, S-01 (iii) |
| FR-21 | M | **Post-cancel sweep policy**: after a kill, the runner must handle Bash-tool children that escaped the process group (detect survivors; kill or record them; never assume the group kill was complete) | S-01 — tool-child escape finding |
| FR-22 | — | **RETIRED 2026-07-14 (never built).** Its sunset condition fired: shared-terminal#381 closed with `Init: true` (#387), so zombies are reaped and the cancel-count guard is moot. ID kept for traceability | Q-08 (resolved upstream) |
| FR-23 | M | On Hub boot, reconcile in-flight runs: query exec status via the seam; `exited` → finalize, `running` → re-attach or kill, `unknown` → mark `interrupted` | ADR-001 (status endpoint), 03 §2.10 |
| FR-24 | M | A run interrupted by stream loss or restart never corrupts the conversation: the next turn `--resume`s the runtime's own session state | ADR-001 (no-replay rationale) |
| FR-25 | M | Seam outage or exec failure produces a user-visible failed run with the error preserved — never a silent hang; per-run timeout is the backstop | R-03 re-scoped, 03 §2.10 |

## 4. Functional — sessions & terminal

| ID | P | Requirement | Source |
| --- | --- | --- | --- |
| FR-30 | M | The Hub provisions **one session per project** through the substrate's public API (template → create → bootstrap with agentSeed carrying project instructions → start/stop) | 02 §3, ADR-005 |
| FR-31 | M | The user can open the underlying terminal session of any conversation | 01 §2 |
| FR-32 | M | The UI signals "agent working" while a run is active in a session the user may also be typing into; manual-intervention races are documented behavior, not prevented | R-11 |
| FR-33 | S | Session lifecycle surfaces (stopped, bootstrapping, recreated) are reflected in **project** state rather than manifesting as opaque run failures | 02 §4 (constraint 4), ADR-005 |

## 5. Non-functional

| ID | P | Requirement | Source |
| --- | --- | --- | --- |
| NFR-01 | M | Persistence is **SQLite local (WAL)**; turn commits are transactional and sub-10 ms p95 on the deployment host | ADR-002, S-03 |
| NFR-02 | M | Event payloads are size-capped (generous but bounded; oversized tool output truncated with a marker) | S-03 (~100 KB statement ceiling as cautionary evidence), ADR-002 |
| NFR-03 | M | All persistence behind a `HubStore` port; an in-memory fake is the test double and the documented engine-swap seam | ADR-002, R-13 |
| NFR-04 | M | The substrate seam is behind a `SubstrateExecPort`; a **fake adapter with recorded S-01 fixtures** is the first implementation (Increment 1 runs with zero network and zero tokens) | A1, R-08, R-12 |
| NFR-05 | M | Contracts (ids, resumable streams) are replica-agnostic even though the implementation is single-replica and process-local | R-13 |
| NFR-06 | M | Turn overhead budget: Hub-added latency (persist + dispatch) ≤ 50 ms p95 on top of the runtime's own ~0.6 s startup | S-01 (ii), NFR-01 |
| NFR-07 | S | UI streaming transport chosen at doc 07/11 must support reconnection without losing already-persisted events (persistence, not the socket, is the source of truth) | ADR-001 pattern |
| NFR-08 | M | Every stream-json fixture used in tests is sanitized with the S-01 pipeline (provider ids, signatures) before committing | R-09, S-01 sanitizer |

## 6. Security

| ID | P | Requirement | Source |
| --- | --- | --- | --- |
| SEC-01 | M | Backend as authority: permission policies, caps, and cancellation are enforced in Hub code; nothing model-emitted is trusted for enforcement | 01 §3 |
| SEC-02 | M | Default runner posture is the curated allowlist; `--dangerously-skip-permissions` is forbidden while containers have open egress (enforced by code review + config validation, not convention) | Q-02 |
| SEC-03 | M | Denials arrive from two layers (CLI built-in policy + allowlist); both are captured in run events and neither is retried automatically | S-01 (CLI Bash policy finding) |
| SEC-04 | M | Secrets (substrate credentials, Claude OAuth token, Cloudflare tokens) live in Hub config/env, never in prompts, run events, logs, or the database | R-07, R-05 |
| SEC-05 | M | Run-event payloads are classified before persisting; known secret values are scrubbed; payloads are never written to logs by default | R-07 |
| SEC-06 | M | The Hub authenticates to the substrate as a **dedicated account** that owns only Hub-created sessions (blast radius = those sessions) | Q-04 / ADR-001 |
| SEC-07 | M | The Claude subscription OAuth token is provided to sessions as env at exec time; it must not be committed to session workspaces or echoed by seeded config | Q-10, 02 §4 (constraint 1) |
| SEC-08 | M | Audit trail from day 1: every run's commands, files, denials, cancellations, and approvals are queryable per conversation | 01 §2, R-05 |
| SEC-09 | F | Autonomy levels 0–3 map to allowlist tiers at doc-07/08 time; the Phase-1 single allowlist must be expressible as one of those tiers (no redesign) | Q-02 path, 01 §3 |
| SEC-10 | M | Agent and project configuration containing personal context (instructions, project names, infrastructure details) lives in gitignored deployment config — only a generic `agents.example.yaml` ships in the public repo | owner direction (2026-07-14), R-09 |

## 7. Operations

| ID | P | Requirement | Source |
| --- | --- | --- | --- |
| OPS-01 | M | Scheduled SQLite snapshots (`VACUUM INTO` / online backup API — never raw file copy of a live WAL db) uploaded to R2 with retention | ADR-002, R-16 |
| OPS-02 | M | Backup freshness is monitored; a stale backup raises a visible alert (silent failure is data-loss risk R-16) | R-16 |
| OPS-03 | M | Restore procedure documented and exercised at least once before Phase-1 exit | ADR-002 |
| OPS-04 | M | Logs carry a request/run correlation id end-to-end and record the seam's `X-Request-Id` per exec | ADR-001 |
| OPS-05 | M | Disk usage of the SQLite file + WAL is monitored (state now lives outside `WORKSPACE_ROOT`) | ADR-002 |
| OPS-06 | S | Per-conversation and per-day usage rollups from UsageRecords (visibility only; budgets stay per-run in Phase 1) | R-06 |

## 8. UX (floor for doc 11 — not a UI spec)

| ID | P | Requirement | Source |
| --- | --- | --- | --- |
| UX-01 | M | One conversational answer per message; internal complexity never imposed | 01 §2 |
| UX-02 | M | Expandable activity view per run: tools, commands, files, denials, errors, duration, cost | 01 §2, FR-14/15 |
| UX-03 | M | Queued, running, cancelled, interrupted, failed, and partially-completed (denials) states are visually distinct | FR-04/15/20/23 |
| UX-04 | M | Cancellation is available whenever a run is active and reflects the real kill outcome | FR-20 |
| UX-05 | M | The terminal is reachable from the conversation without losing chat context | FR-31 |
| UX-06 | S | Cost per run visible in the activity view; `unknown` shown honestly for cancelled runs | FR-18 |
| UX-08 | M | Archived projects and conversations stay **reachable and restorable** from the UI, and the archive confirmation states what actually happens (the session stops; the item can be restored). "Reversible" must be true on screen, not only in the database — and the wording must never claim more permanence, or less, than the system delivers | FR-43, 11 §3 |
| UX-07 | M | Primary devices are **Mac and iPhone**: the full API is usable without a terminal or desktop session; the iPhone experience never requires one (FR-31 stays optional). Approvals/notifications arrive with autonomy levels ≥ 2 (Phase 2+; the run state machine reserves `awaiting_approval` for it) | owner direction (2026-07-14) |

## 9. Traceability notes

- Q-03 (queue semantics) and Q-09 (TS/Node) remain provisional; FR-04 and the
  stack assumption inherit that status and are revisited at doc 07 if
  challenged.
- The original long-form brief (Spanish) has still not been supplied; if it
  surfaces, its requirement list is reconciled into this document (gaps become
  new IDs, never renumbering).
- Requirements deliberately absent because their phase is later: agent
  registry UI (2), routing (3), multi-agent (4), remote nodes (5), advanced
  memory (6), Hub multi-user auth (Q-07 keeps Phase 1 single-user).
