# 18 — Agent Collaboration Model (vision)

**Status:** vision — non-normative · **Last updated:** 2026-07-15

How agents will collaborate as the phases unfold. This document is the
**canonical home for the collaboration direction** — the place where the
product's long-range ideas live so they stop being re-litigated in
conversation and never leak into earlier phases uninvited. Nothing here is
implementable specification: each concept is designed in detail only when its
phase arrives (the anti-over-architecture principle, 01 §3), and none of it
changes Phase 1 ([03 §2](./03-scope-and-phases.md) stands as scoped).

Sources it consolidates: [01 §4](./01-product-brief.md) (multi-agent vision),
the Phase 3–6 rows of [03 §1](./03-scope-and-phases.md), the deliberately-not-
modeled list of [06 §5](./06-domain-model.md), and the owner's direction
reviews of 2026-07-14 and 2026-07-15.

## 1. Philosophy

> We are not building a chat with AI. We are building a system where teams of
> AI specialists collaborate to do real work on projects.

Conversation is **one entry point into work, not the center of the system**.
The organizing unit is the Project (ADR-005); the working units are
specialist agents; the products of work are structured artifacts. Phase 1
ships the smallest honest slice of that system — one specialist, one
conversation at a time, every run audited — and each later phase adds one
collaboration capability without re-founding the ones before it.

## 2. Agents are professional roles

Already normative (01 §1, 06 §2): an agent is a **specialist identity** —
Software Architect, QA Engineer, Security Reviewer, Home Automation
Engineer — with its own instructions, tools, permissions, and (later) memory,
decoupled from whatever runtime executes it. Two consequences worth stating
for later phases:

- **Every agent is a persistent identity already.** There is no such thing as
  a transient agent that "appears when invoked" vs a "permanent" one: the
  runner is per-turn (Q-01), so *no* agent has a live process, and *every*
  agent has a stable identity. What "a permanent project agent" really asks
  for is **project-scoped accumulated context** — which is project memory
  (ADR-005 deferred list, Phase 2+) indexed by the *(project, agent)* pair,
  so the Architecture Agent of one project accumulates that project's
  decisions without polluting its role elsewhere. That indexing note is a
  Phase-2 design input; no new entity kind is needed.
- A role's *quality criteria and way of working* live in its instructions —
  configuration, not code.

## 3. The Coordinator, decomposed

The intuition: the user should express intent, and the system should figure
out which specialists do the work, plan it, bound it, and synthesize one
answer. Correct — but "Coordinator" is **not one entity**. It decomposes into
three parts of different natures, two of which are already on the roadmap:

| Function | Nature | Where it lives |
| --- | --- | --- |
| Enforce permissions, caps, budgets, queueing, delegation depth | Deterministic code — *never* a model (backend-as-authority, 01 §3) | The **Orchestrator** module (07 §2) — exists from Phase 1 |
| Interpret intent, select specialists | A model run | The **Phase-3 router** |
| Plan multi-agent work, delegate, collect, synthesize the final answer | A model run | The **Phase-4 supervisor pattern** (01 §4) |

"Coordinator" is the umbrella name for the router + supervisor functions,
and this document reserves it as vocabulary. What it must **not** become:

- **A mandatory gate.** The conversation modes (01 §4: automatic / preferred
  / pinned / explicit) are the design: the Coordinator is the brain of the
  *automatic* mode. Direct access to a pinned specialist stays first-class —
  interposing a model call in front of every message would add latency and
  cost to the dominant single-specialist case.
- **A permissions authority.** A model that "controls permissions" would
  violate the non-negotiable backend-as-authority principle. The Coordinator
  *proposes* plans and delegations; the Orchestrator *enforces* the bounds.

The coordination ADR (candidate ADR-006) is written when Phase 3 is designed,
not before.

## 4. Work Products

Agents collaborate by exchanging **typed, structured artifacts** — never by
sharing a transcript. Already normative in seed form: Phase 1's mechanical
`RunSummary` (A6, FR-42) is the first Work Product, and the generic artifact
system of Phase 4 **grows from that seed** (03 §1).

The catalog will include shapes like Architecture Proposal, Security Review,
Implementation Plan, Implementation Result, QA Report, Decision Record — each
a typed document with a producer, consumers, and provenance (which run
produced it, from which inputs). When Phase 4 designs the generic entity, the
known cost surface is: persistence (a typed table), API (list/read per
project), UX (a viewer per type), events (`work_product.*`), and audit
(provenance links). None of that is built while there is one producer
(`RunSummary`) and zero consumers — generalizing from a single case produces
the wrong schema.

What *is* fixed now is the **family envelope** — the properties every Work
Product shares, which `RunSummary` is deliberately designed to satisfy:

- a **type** (what kind of product this is),
- a **producer** (the run — and through it the agent — that emitted it),
- **provenance** (derived from persisted evidence, not free assertion:
  `RunSummary` derives from run events),
- a **structured, consumer-addressable body** (typed fields, never prose
  alone).

`RunSummary` is therefore not "the UI summary of a run" that happens to be
reusable — it is the first concrete member of this family, and Phase 4
generalizes by **extension of the envelope, not redesign**. The family
contract is the envelope; payload schemas stay per-type and evolve freely.

## 5. Knowledge Flow and Context Packages

The collaboration failure mode to design against: delegation degenerating
into forwarding hundreds of transcript messages to the next agent. The
standing principle — elevated to the non-negotiable list in 01 §3 — is
**need-to-know**: a delegated agent receives a
**Context Package** — the task brief, the specific Work Products it must
consume, and the relevant project decisions — and nothing else. Knowledge
flows through typed artifacts, not through shared history.

`Context Package` is vocabulary for Phase-4 design, not an entity today. Its
Phase-1 ancestor already exists: a run's input is the user message plus the
CLI's own session continuity, and its output is captured as a `RunSummary` —
one producer, one consumer (the user), zero transcript sharing.

## 6. Workflow templates: code first, template when proven

Recurring pipelines are real — Security Review (architect → security reviewer
→ developer → QA → summary), New Feature (requirements → architecture →
implementation → QA → docs). The trap is building the workflow *engine*
(template versioning, per-step error semantics, conditional branches, an
editor) before a single pipeline has run — that is the generic-BPM shape this
product explicitly refuses (01 §3, anti-over-architecture).

The rule, mirroring the runtime-adapter discipline (12 §exclusions: two
adapters + one interface is the rule; the third implementation pays for the
generalization — with R-12's design-time review against a hypothetical third
guarding the interface meanwhile): **Phase 4's first workflows are
plain code** — a hardcoded sequence of roles exchanging Work Products under
Orchestrator bounds. When **three** real workflows exist and their variation
is visible, the declarative template (likely a YAML sequence of role + expected
Work Product type) is extracted from evidence. Direction recorded here;
object deferred until earned.

## 7. Project Policies: declarative gates, not orchestration

A project will want to declare rules about its work — the GitHub
branch-protection analogy: *every feature requires an Architecture Review
before it is marked complete; infrastructure changes require a Security
Review; physical automation requires human approval.* These are **not
workflows**: they don't plan or execute anything. They are **conditions a
state transition must satisfy**, checked deterministically.

Why the direction is coherent with this architecture:

- **Enforcement is code, not model** — a policy check ("does a Security
  Review Work Product exist for this task?") is exactly the kind of
  deterministic gate the Orchestrator already owns (backend-as-authority).
  Policies *strengthen* the product's central principle rather than adding a
  new kind of authority.
- **They are the consumer that Work Products were missing.** A policy like
  "requires Architecture Review" is only checkable when Tasks (Phase 2) and
  typed Work Products (Phase 4) exist — which is why policies land *after*
  both, as a thin declarative layer over them, not before.
- **Human-approval policies compose with autonomy levels** (01 §3): "physical
  automation requires human approval" is the project-scoped face of the
  approvals/`awaiting_approval` mechanism — one mechanism, two configuration
  surfaces, never a parallel permission system.

The known trap, same as workflows: a policy *language* (conditions,
expressions, combinators) is a rules engine — the enterprise shape this
product refuses. Same discipline applies: the first policies are hardcoded
checks in project config; a declarative form is extracted only from real,
repeated cases. Vocabulary reserved; nothing designed until Tasks and Work
Products exist.

## 8. Task, ahead of its phase

Task becomes an entity in Phase 2 (03 §1); today a task *is* a run with
bigger caps (06 §5). One forward constraint is worth fixing now so Phase 2
doesn't inherit a migration: **a Task parents to the Project, not to a
Conversation.** Tasks outlive conversations, may involve several agents
(Phase 4), and produce Work Products; a conversation is one way to start or
steer a task, not its owner.

## 9. The project surface grows into a dashboard

Phase 1's project view (11 §4: conversations · activity inspector · terminal)
is the **proto-dashboard** — it already shows everything that exists. As
phases add entities, the same entry surface grows to show them: running
tasks (Phase 2), pending approvals (Phase 2+), recent Work Products and team
pipelines (Phase 4), decisions and risks (with project memory). Opening a
project then lands on an overview rather than a conversation list — an
evolution of one surface, not a new product. Recorded as UX direction in
[11 §7](./11-ux-specification.md).

## 10. Explicitly rejected shapes

Recorded so they are not re-proposed without new evidence (R-17):

| Rejected | Why | The simpler thing that replaces it |
| --- | --- | --- |
| `Coordinator` as a domain entity / mandatory intermediary | Conflates code-enforced authority with model-driven judgment; taxes the dominant direct-specialist case | §3's decomposition: Orchestrator (P1) + router (P3) + supervisor (P4) |
| Configurable workflow-template objects now | A BPM engine with zero executed pipelines behind it | §6: code-first, extract the template at the third proven workflow |
| `PermanentAgent` as a distinct agent kind | All agents are already persistent identities; "permanent" is accumulated project context, not a lifecycle | §2: project memory indexed by *(project, agent)*, Phase 2+ |
| Generic `WorkProduct` entity in Phase 1 | One producer, zero consumers — generalization without a second case | §4: `RunSummary` is the seed; the entity lands with Phase 4's first consumer |
