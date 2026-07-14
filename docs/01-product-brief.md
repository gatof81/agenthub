# 01 — Product Brief

**Status:** draft — review · **Last updated:** 2026-07-13

> Curated from the kickoff specification. The original long-form brief (Spanish) has
> not been supplied to this repo yet; if it surfaces, it is the source of truth for
> vision-level intent and this document gets reconciled against it. The amendments
> in [§7](#7-amendments-decisions-already-taken) supersede it either way.

## 1. Vision

Agent Hub is a **personal hub for AI agents behind a chat interface**. The
user works in **Projects** — "I'm going to work on Educación Hz", never "I
want to talk to agent X" ([ADR-005](./adr/ADR-005-project-aggregate.md)).
Each project owns a workspace and holds conversations; each conversation is
handled by one or more agents.

An **agent is a professional role** — Software Architect, QA Engineer,
Security Reviewer, Home Automation Engineer — a logical entity with identity,
instructions, specialty, tools, memory, permissions, and policies,
**decoupled from the runtime** that executes it. Agents exist because they
represent specialties, never because they wrap a particular model. The
first runtime is the Claude Code CLI running headless inside a
[shared-terminal](https://github.com/gatof81/shared-terminal) session. Later
runtimes (local models via Ollama, HTTP services, remote Agent Nodes, other
shared-terminal installations) plug in behind the same adapter contract. The same
agent must be able to switch runtimes without losing identity, memory, or
configuration.

## 2. Experience

The user writes; the system decides which agent(s) to use, executes, and returns
**one** conversational answer. Internal complexity is never imposed on the user,
but it is auditable: an expandable view shows agents used, plan, tools invoked,
commands run, files touched, errors, approvals, duration, and cost.

Alongside the chat, the underlying terminal session remains directly accessible —
the user can always drop into the workspace the agent operates on.

## 3. Non-negotiable principles

- **Backend as authority.** Models propose; permissions, secrets, execution,
  delegation, and spending limits are validated in code with deterministic
  policies. No model output is trusted to enforce anything.
- **Autonomy progression.** Level 0 (read-only) → 1 (reversible changes) → 2
  (external actions) → 3 (critical actions); configurable per user, agent, tool,
  project, and chat.
- **Anti-over-architecture.** Modular monolith, one database, adapters, testable
  contracts. No Kubernetes, microservices, Kafka, vector databases, event
  sourcing, or CQRS in the MVP. Every new infrastructure piece must cite a
  concrete failing constraint (see quality gates in [README](./README.md)).

## 4. Conversation modes and multi-agent patterns (later phases)

Conversation modes — automatic routing / preferred agent / pinned agent / explicit
selection — and multi-agent patterns — parallel, sequential, delegation, debate,
supervisor — arrive in phases 3–4, always bounded: budgets, delegation depth,
timeouts, loop prevention. Teams collaborate on a **need-to-know basis**:
agents exchange structured **Work Products** (security reviews, QA reports,
implementation plans) rather than sharing one transcript — Phase 1's
`RunSummary` is the first such artifact. Documented as vision here; designed
in detail only when their phase arrives.

## 5. Phases

| Phase | Delivers |
| --- | --- |
| 1 | Single-agent chat (MVP — see [03-scope-and-phases.md](./03-scope-and-phases.md)) |
| 2 | Agent Registry (agents as first-class configurable entities) |
| 3 | Automatic router (system picks the agent) |
| 4 | Multi-agent patterns with hard limits |
| 5 | Remote Agent Nodes (runtimes on other machines/installations) |
| 6 | Advanced memory |

## 6. Relationship to shared-terminal

Separate repositories, permanently. The integration seam is shared-terminal's
**public HTTP API** — the Hub never imports its code or touches its database.
When the Hub needs new API surface there (it does — see
[02-substrate-analysis.md](./02-substrate-analysis.md)), the contract is designed
here as a proposal and implemented through that repo's own process. Separate repos
does not mean separate hosts: co-locating the Hub on the substrate's host and
talking over localhost is a valid deployment.

## 7. Amendments (decisions already taken)

These supersede the original brief and are not reopened without cause:

1. **Separate repos** (§6 above).
2. The shared-terminal hardening batch closed the discovery-era gaps: Claude state
   continuity across container recreate (#371/#378) and exec orchestration with
   race-free cancellation (#373/#375).
3. All repo artifacts in English (both repos' convention).
4. MVP adjustments: fake deterministic runtime first; activity derived from
   `tool_use` events, not filesystem diffs; minimal UsageRecord in Phase 1; no
   automatic routing or multi-agent in the MVP (detail in
   [03-scope-and-phases.md](./03-scope-and-phases.md)).

## 8. Non-goals (MVP horizon)

**A generic SaaS platform** — Agent Hub is built personal-first: the best
possible tool for its single owner's daily work; generalization is earned
later by the architecture, never paid for up front · billing/monetization ·
multi-tenancy beyond the substrate's single-tenant assumption · native mobile
apps (the iPhone experience is web-first, UX-07) · plugin marketplaces ·
training or fine-tuning · replacing shared-terminal's own UI.

## 9. Success criteria for Phase 1

- A conversation with one agent survives backend restarts and container recreates
  without losing context.
- Every run is persisted with state, events, cost, and the commands/files it
  touched — visible in the expandable activity view.
- A run can be cancelled mid-tool-call and the system returns to a consistent state.
- The user can open the underlying terminal at any time and see what the agent did.
- No secret ever reaches the repo, the event log in plaintext where avoidable, or
  a model prompt.
