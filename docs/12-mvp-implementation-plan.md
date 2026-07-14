# 12 — MVP Implementation Plan (Phase 1)

**Status:** draft — review · **Last updated:** 2026-07-14

The build sequence for Phase 1: three increments, the module order within
them, and the test-first discipline that binds each to its spec. Nothing here
introduces new decisions — it orders the ones already made. Sources: scope and
increments [03 §3](./03-scope-and-phases.md); modules
[07 §2](./07-architecture.md); domain [06](./06-domain-model.md); contracts
[08](./08-api-and-event-contracts.md); persistence [09](./09-persistence.md);
runner [ADR-003](./adr/ADR-003-claude-cli-runner.md); streaming
[ADR-004](./adr/ADR-004-ui-streaming-transport.md); aggregate
[ADR-005](./adr/ADR-005-project-aggregate.md).

## Principle

**Vertical slices, backend-first, fake-before-real.** Each increment ends in
something runnable end-to-end. Ports (`HubStore`, `SubstrateExecPort`,
`RuntimeAdapter`, 06 §4) are built with their fakes as first-class peers
(A1/NFR-04), so the whole system runs deterministically before a single token
is spent or the seam is touched.

## Increment 1 — fake runtime, end-to-end

**Goal:** the complete spine — project → conversation → message → run →
stream → activity → summary → cancel — running with **zero network and zero
tokens**, fully deterministic.

Build order (each step test-first against its spec):

1. **`HubStore` + schema** (09): SQLite engine config, DDL, migrations,
   guarded-update transaction layer. In-memory fake implements the same
   interface. Contract suite runs against both (I-1..I-11 enforcement).
2. **Domain + run state machine** (05/06): types, legal-transition table,
   per-project serialization (I-2), snapshots.
3. **Orchestrator**: send → queue → dispatch → ingest (batched, idempotent) →
   terminal transition, each in one transaction (09 §3); reconciler skeleton;
   `RunSummary` derivation (FR-42).
4. **Fake `SubstrateExecPort`**: replays sanitized S-01 fixtures as an NDJSON
   exec stream (started/output/exit), honoring kill.
5. **Fake `RuntimeAdapter`**: maps the fixture stream-json → `RunEvent`s
   through the exact ADR-003 mapping (the real adapter must later produce
   identical streams from the same fixtures — the contract test).
6. **API + SSE** (08): projects/conversations/messages/runs routes; SSE
   projection with `Last-Event-ID` replay from the store.
7. **Frontend slice** (11, React + Vite): project switcher → conversation →
   send → streaming answer → activity inspector → summary; cancel. Mac layout
   first; the iPhone single-column view is the same data, narrower.

**Done when:** create a project (fake session provisions instantly), send a
message, watch a fixture-driven run stream deltas + activity, read the
summary, and cancel — all offline, all deterministic in CI. This proves every
contract except the two real integrations.

## Increment 2 — real substrate + real Claude

**Goal:** swap both fakes for real implementations behind the unchanged ports.
Unblocked: the exec API is live upstream (shared-terminal #385), Q-02
allowlist is decided (08 §5), Q-10 auth is subscription OAuth.

1. **Real `SubstrateExecPort`**: HTTP against the live exec API
   (`contracts/shared-terminal-exec-api.md`) — exec stream, status, kill;
   `X-Request-Id` capture (OPS-04); session lifecycle (create from template;
   the substrate's `agentSeed` bootstrap step [02 §1] writes settings/CLAUDE.md
   from the project's `instructions` field [ADR-005]; start/stop — FR-30).
2. **Real `claude-cli` `RuntimeAdapter`** (ADR-003): command construction
   (stdin prompt, mandatory allowlist, `--resume`), env wiring
   (`CLAUDE_CODE_OAUTH_TOKEN` + `HUB_RUN_ID`, SEC-07), stream-json parsing to
   the same `RunEvent`s the fake emits.
3. **Contract test gate**: real and fake adapters produce identical event
   streams from the S-01 fixtures — divergence fails CI (R-12), not
   production.

**Done when:** a real project against a real shared-terminal session runs a
real Claude turn end-to-end, with real cost in the summary, continuity across
turns via `--resume`, and the activity view populated from live `tool_use`
events.

## Increment 3 — hardening

**Goal:** survive the failure modes (03 §2 item 10; UC-06/07/08).

1. **Cancellation + post-cancel sweep**: kill mapping, `HUB_RUN_ID` env-marker
   sweep of escaped Bash-tool children (FR-21, ADR-003), outcome authoritative
   over stream `reason`.
2. **Boot reconciliation** (UC-06): the two-transaction reconcile (09 §3),
   queue rebuild from `queued` rows, `interrupted` resolution.
3. **SSE resilience**: reconnect-with-`Last-Event-ID` replay + REST recovery
   for state/summary events; iPhone-backgrounding reconnect treated as normal
   (11 §5).
4. **Backup pipeline** (OPS-01..03): `VACUUM INTO` → R2, freshness gauge on
   `/api/health`, and the **restore drill** (mandatory before Phase-1 exit,
   R-16).
5. **Error taxonomy + limits**: surface every code (08 §6), enforce
   timeouts/turn caps, the lagging budget estimate (ADR-003).

**Done when:** the system recovers cleanly from Hub restart, container
recreate, and seam outage; a production snapshot restores into a scratch
environment and takes a turn.

## Cross-cutting, built alongside

- **Observability floor** (07 §6, doc 14): correlation ids end-to-end, run
  state-transition counters, backup freshness, seam error rate.
- **Config** (SEC-10): agents/projects from gitignored deployment config;
  `agents.example.yaml` in the repo.
- **Module-boundary lint** (07 §2): enforce the dependency arrows so the
  monolith stays modular by tooling.

## Quality-gate mapping

The gates in [README](./README.md) close as follows — implementation may not
start until all the *specification* gates pass (brief, scope, architecture,
domain, threat model, contracts, flows, testing strategy, Phase-1 backlog,
ADRs, risk mitigations), and the increments above satisfy the *build* side:

| Gate (README) | Satisfied by |
| --- | --- |
| Product brief approved | 01 |
| MVP scope approved | 03 |
| Architecture reviewed | 07 |
| Domain model validated | 06 |
| Initial threat model | 10 |
| Main contracts defined | 08 + exec contract (tracking live upstream) |
| Critical flows defined | 05 |
| Test & migration strategy | 09 migrations + doc 13 |
| Phase-1 backlog exists | the standalone Phase-1 backlog (planned after doc 14) |
| ADR-001..005 resolved; later ADRs drafted | all five accepted |
| MVP-phase risk mitigations accepted | 16 (R-01/R-04/R-08/R-14/R-15 closed; open ones mitigated + accepted) |

Status of each is authoritative in the README gate list and the source doc;
this table maps gate → owning artifact. Approval of the draft docs is the
owner's remaining act on the specification gates.

## What this plan deliberately excludes

Any Phase-2+ surface (agent registry UI, Task entity, project memory/documents,
multi-agent, remote nodes) · premature abstraction of a third runtime (two
adapters + one interface is the rule; the third pays for the generalization,
R-10/R-12) · performance work beyond the NFR budgets until measured.
