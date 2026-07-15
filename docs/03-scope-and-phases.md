# 03 — Scope and Phases

**Status:** draft — review · **Last updated:** 2026-07-15

## 1. Phase map

| Phase | Name | Delivers | Explicitly excluded until then |
| --- | --- | --- | --- |
| 1 | Single-agent chat (MVP) | §2 below | routing, multi-agent, remote nodes |
| 2 | Agent Registry & Project enrichment | Agents as first-class entities (create/edit identity, instructions, tools, permissions, runtime binding); project memory/documents/multi-repo (ADR-005 deferred list); **Task** as an entity (unattended work with checkpoints + notifications — today a task is just a run with bigger caps; parents to the Project, not a Conversation — [18 §8](./18-agent-collaboration-model.md)); notifications channel (UX-07) | automatic selection |
| 3 | Automatic router | System picks agent(s) per message; conversation modes (automatic / preferred / pinned / explicit); cross-run budgets. The router is the **Coordinator's selection function** ([18 §3](./18-agent-collaboration-model.md)); its ADR is written when Phase 3 is designed | multi-agent execution |
| 4 | Multi-agent teams | Parallel, sequential, delegation, debate, supervisor — each bounded: budgets, depth, timeouts, loop prevention. The supervisor is the **Coordinator's orchestration function**; delegation inputs are **Context Packages** ([18 §3/§5](./18-agent-collaboration-model.md)). **Need-to-know context**: agents exchange typed **Work Products** (generic artifact system grown from Phase 1's `RunSummary`), never a shared transcript. First workflows are plain code; declarative **workflow templates** are extracted only after three real pipelines (18 §6) | — |
| 5 | Remote Agent Nodes | Runtimes on other machines / other shared-terminal installations | — |
| 6 | Advanced memory | Beyond per-runtime session continuity | — |

Phases 3–6 are documented as vision only; they are designed in detail when their
phase arrives (anti-over-architecture principle).

## 2. MVP (Phase 1) scope

End-to-end flow, all of it in scope:

1. Create a **project** (one substrate session/workspace) and conversations
   within it, each associated with an agent (ADR-005).
2. The project is bound to a shared-terminal session/template.
3. Send a message → a **run** executes Claude CLI headless in the session workspace.
4. Response streams back into the chat.
5. Continuity between messages (same CLI conversation via `--resume`).
6. Run persisted with state and events.
7. Files touched and commands executed visible in the expandable activity view.
8. Manual terminal access to the same session.
9. Cancellation of an in-flight run.
10. Error handling and recovery (backend restart, container recreate, seam outage).

### Decided adjustments (locked)

| # | Adjustment | Rationale |
| --- | --- | --- |
| A1 | **First increment runs against a fake, deterministic runtime** (recorded fixtures); real Claude enters afterwards | Decouples Hub development from token spend, seam availability, and CLI nondeterminism; the fake adapter is also the second `RuntimeAdapter` implementation from day 1 (risk R-12) |
| A2 | **Activity (files/commands) derives from `tool_use` events** in the CLI's stream-json output, not from filesystem diffs | Deterministic, cheap, attributable to the run; fs diffs race with human terminal use |
| A3 | **Minimal `UsageRecord` in Phase 1** — cost per run, which the CLI already reports | Consumption visibility from day 1 (risk R-06); no billing logic |
| A4 | **No automatic agent selection, no multi-agent** in the MVP | Phase 3–4 scope |
| A5 | **Project-centric from day 1** (ADR-005): one workspace/container per project, conversations share it | Owner's mental model + container economics (per-session caps) |
| A6 | **Mechanical `RunSummary` per terminal run** — derived from persisted events, never model-generated | First Work Product; zero token cost, deterministic (FR-42) |

### Hard limits from day 1

Every run carries: max turns, budget cap, wall-clock timeout. These are not
Phase-3 features — they are Phase-1 safety rails (risk R-06).

### Out of scope for the MVP

Agent Registry UI (Phase 2 — MVP may hardcode one or two agents in config) ·
automatic routing · multi-agent patterns · remote nodes · advanced memory ·
frontend framework decision (made at doc 11, not before) · billing.

## 3. MVP increments (sequencing sketch)

Detailed sequencing lands in `12-mvp-implementation-plan.md`; the fixed points:

1. **Increment 1 — fake runtime end-to-end:** chat → run → streamed fixture
   events → persisted run + activity view. No network, no tokens, fully
   deterministic tests.
2. **Increment 2 — real substrate, real Claude:** swap the fake seam adapter for
   the real one (gated on the upstream exec API from ADR-001) and the fake
   runtime for the Claude CLI runner (gated on S-01 findings and the Q-02
   permission-posture sign-off).
3. Hardening: cancellation, recovery, reconnection — against both fake and real
   implementations.
