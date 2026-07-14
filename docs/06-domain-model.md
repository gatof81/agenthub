# 06 — Domain Model (Phase 1)

**Status:** draft — review · **Last updated:** 2026-07-14

The entities, relationships, and invariants behind
[04-requirements.md](./04-requirements.md) and the flows in
[05-use-cases-and-flows.md](./05-use-cases-and-flows.md). Storage mapping
(tables, indexes) is doc 09's job; wire contracts are doc 08's. Names here are
canonical for both.

## 1. Overview

```mermaid
erDiagram
    PROJECT ||--o{ CONVERSATION : contains
    PROJECT ||--|| SESSION_BINDING : "owns the workspace"
    AGENT ||--o{ CONVERSATION : "handles (1 per conversation in P1)"
    CONVERSATION ||--o{ MESSAGE : contains
    CONVERSATION ||--o{ RUN : owns
    MESSAGE ||--o| RUN : "user message triggers ≤1"
    RUN ||--o{ RUN_EVENT : emits
    RUN ||--o| USAGE_RECORD : "exactly 1 when terminal"
    RUN ||--o| RUN_SUMMARY : "exactly 1 when terminal"
```

Two aggregates, one configuration entity, one value object:

| Element | Kind | Why it exists |
| --- | --- | --- |
| `Project` | aggregate root (owns `SessionBinding` and its `Conversation`s) | The organizing unit — matches how the owner works ([ADR-005](./adr/ADR-005-project-aggregate.md)); one workspace/container per project |
| `Agent` | configuration entity (file/env-defined in P1, FR-02) | A **professional role** (architect, QA, security reviewer…) decoupled from the runtime that executes it (01 §1); the runtime is an execution detail |
| `Conversation` | entity under `Project` (owns `Message`s, runtime continuity state) | The dialogue unit; inherits the project's workspace |
| `Run` | aggregate root (owns `RunEvent`s, `UsageRecord`, `RunSummary`) | The execution unit; heaviest write path |
| `SessionBinding` | value object on `Project` | The substrate seam reference |

## 2. Entities

### Agent (config-defined in Phase 1)

| Field | Notes |
| --- | --- |
| `id`, `name` | stable slug; referenced by conversations |
| `instructions` | seeded into the session via agentSeed at provisioning (FR-30) |
| `allowedTools` | the curated allowlist — **mandatory, never empty-meaning-all** (FR-11, SEC-02) |
| `sessionTemplateId` | substrate template the agent's sessions are created from |
| `runtime` | `claude-cli` (only value in P1); the discriminator for the `RuntimeAdapter` |
| `defaultCaps` | `{maxTurns, budgetUsd, timeoutMs}` — every run gets a caps snapshot (FR-17) |

Phase-2 forward constraint: this shape must survive becoming a stored,
user-editable entity (Agent Registry) without field renames.

### Project

| Field | Notes |
| --- | --- |
| `id`, `name`, `status` | status: `provisioning \| ready \| error \| archived` — session provisioning lives here (UC-01) |
| `sessionBinding` | see below — one workspace/container per project (ADR-005) |
| `defaultAgentId` | seeds new conversations; overridable per conversation |
| `instructions?` | project-level context seeded into the session (agentSeed) |

Deferred to Phase 2+ (ADR-005, guarded by R-17): project memory, document
library, multiple repos/workspaces, multiple terminals, per-project
permission overrides.

### Conversation

| Field | Notes |
| --- | --- |
| `id`, `title`, `status` | status: `active \| archived` — provisioning belongs to the project |
| `projectId` | immutable (I-10) |
| `agentId` | immutable in Phase 1 (agent switching is Phase-2 scope); defaults from the project |
| `runtimeSessionId` | the CLI's own session id used for `--resume`; updated from each result event (S-01: stable across resumes, but drift is captured, FR-24). Many CLI sessions coexist in one workspace — directly verified by S-01's published run (five distinct sessions in one container, one resumed by id while the others coexisted; see the [S-01 fixtures](./spikes/S-01/fixtures/run-20260714T142930Z/)) — which is what lets conversations share the project's container |

### SessionBinding (value object on Project)

`{sessionId, templateId, lastKnownState}` — everything the Hub knows about
the project's substrate session. The substrate remains the authority on
session state; `lastKnownState` is a cache for UX (FR-33), never a basis for
decisions the seam can answer live.

### Message

| Field | Notes |
| --- | --- |
| `id`, `conversationId`, `role` | role: `user \| assistant` |
| `content` | assistant content is assembled from the run's stream; user content is verbatim |
| `runId?` | user messages: the run they triggered (FR-03); assistant messages: the run that produced them |
| `createdAt` | — |

### Run

| Field | Notes |
| --- | --- |
| `id`, `conversationId`, `messageId` | the triggering user message |
| `state` | exactly the 05 state machine: `queued \| starting \| streaming \| completed \| completed_with_denials \| cancelled \| interrupted \| failed` |
| `execId?`, `pgid?` | seam handles (ADR-001), set by the `started` event — absent through `queued` and `starting`; `pgid` informational |
| `capsSnapshot`, `policySnapshot` | the caps and allowlist the run actually ran with — snapshots, not references, so later agent edits never rewrite history (SEC-08) |
| `cliVersion`, `model` | recorded from the init event (FR-12, R-02) |
| `killOutcome?` | `already-exited \| terminated \| killed` when cancelled (FR-20) |
| `sweepResult?` | post-cancel survivor sweep outcome (FR-21) |
| `error?` | terminal error detail for `failed` (FR-25) |
| `createdAt`, `startedAt?`, `endedAt?` | `startedAt` set by the `started` event (absent through `queued`/`starting`); `endedAt` absent until terminal |

### RunEvent

| Field | Notes |
| --- | --- |
| `id` | **idempotency key** — re-ingesting the same event is a no-op (FR-13) |
| `runId`, `seq` | `(runId, seq)` unique, ordering key |
| `type` | `started \| output \| tool_use \| permission_denial \| exit \| error \| unknown` — `unknown` preserves unrecognized stream types verbatim (FR-16) |
| `payload` | capped (NFR-02); oversized content truncated with a marker |
| `ts` | — |

**Activity is a projection, not an entity**: commands and files touched are
derived on read from `tool_use` events (`input.command`, `input.file_path`) —
per A2 and the anti-over-architecture rule, nothing is double-written.
`permission_denial` events are first-class in the projection (FR-15).

### UsageRecord

| Field | Notes |
| --- | --- |
| `runId` | 1:1 with terminal runs |
| `totalCostUsd?`, `numTurns?`, `usage?` | from the result event; **all null when `source = cancelled-unknown`** (FR-18) |
| `source` | `result-event \| cancelled-unknown \| error-partial` |

### RunSummary (persisted projection)

Written in the same transaction as the terminal state transition, 1:1 with
terminal runs (I-11). **Mechanically derived — never model-generated** (zero
token cost, deterministic, available even for cancelled runs): objective
(user-message excerpt), outcome state, files touched and commands run (from
the activity projection), denial count, warnings (capped stderr excerpt),
cost/turns (from `UsageRecord`, `unknown` where it is), duration, and the
`runtimeSessionId` continuation handle. This is the first **Work Product**
(01 §4) — the Phase-4 generic artifact system grows from this seed. Narrative
model-authored fields are a later enrichment, not Phase 1.

## 3. Invariants

| # | Invariant | Enforced by |
| --- | --- | --- |
| I-1 | One user message triggers at most one run; every run has exactly one triggering message | FR-03; unique index on `Run.messageId` |
| I-2 | At most one run per **project** is in a non-terminal state (conversations share the workspace, ADR-005); queued runs dispatch FIFO across the project | FR-04/19; transactional dispatch (NFR-01) |
| I-3 | Run state changes follow the 05 state machine only, each transition one transaction | UC-06 preamble |
| I-4 | `RunEvent` ingestion is idempotent (`id`) and ordered (`runId, seq`) | FR-13 |
| I-5 | Every terminal run has exactly one `UsageRecord`, even if its values are unknown | FR-18 |
| I-6 | `Conversation.agentId` never changes in Phase 1 | FR-02 boundary |
| I-7 | `policySnapshot` is non-empty on every run — a run without an explicit allowlist must be unrepresentable | FR-11, SEC-01/02 |
| I-8 | `capsSnapshot`/`policySnapshot` are immutable once the run leaves `queued`; `cliVersion`/`model` are **write-once** when the init event records them and immutable after | SEC-08 audit trail |
| I-10 | `Conversation.projectId` never changes | ADR-005 |
| — | (I-9 is a retired draft-era number — assigned to the FR-22 cancel counter and withdrawn with it before merge; invariant IDs, like requirement IDs, are never reused) | — |
| I-11 | Every terminal run has exactly one `RunSummary`, written in the terminal transition's transaction | FR-42 |

## 4. Ports (domain boundaries)

| Port | Responsibility | Implementations (P1) |
| --- | --- | --- |
| `HubStore` | All persistence; transactions live here | SQLite (real), in-memory (tests) — ADR-002, NFR-03 |
| `SubstrateExecPort` | exec/status/kill + session lifecycle against the seam | HTTP (per ADR-001 contract, gated on upstream #381), **fake with S-01 fixtures** (A1, NFR-04) |
| `RuntimeAdapter` | Turn semantics for a runtime: build the command (flags, stdin prompt), parse its event stream into `RunEvent`s, map cancellation | `claude-cli` (S-01 lessons encoded), fake (deterministic fixtures) |

`RuntimeAdapter` is deliberately reviewed against a hypothetical HTTP runtime
before freeze (R-12): nothing in its interface may assume stream-json, a CLI,
or a session — those are `claude-cli` implementation details.

## 5. Deliberately not modeled (Phase 1)

User/tenant (single-user, Q-07) · agent registry persistence (Phase 2 — the
`Agent` shape is the forward contract) · `Task` as an entity distinct from a
run (Phase 2-3 — today a task IS a run with bigger caps; 03 §1) ·
router/multi-agent constructs and generic `WorkProduct`s (Phases 3–4 —
`RunSummary` is the seed) · project memory/documents (Phase 2+, ADR-005) ·
memory beyond `runtimeSessionId` continuity (Phase 6) · cross-run budgets
(Phase 3; per-run caps only, R-06).
