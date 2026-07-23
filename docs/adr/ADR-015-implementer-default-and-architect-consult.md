# ADR-015 — The conversation's agent implements; the architect is an on-demand consult

Status: proposed
Date: 2026-07-23

## Context

The task envelope (ADR-009) fills its implementation seat by routing: the
specialist the router proposes for the message becomes the developer. Two
costs surfaced in production and dogfooding:

- **A third-party dev identity pays a fresh-context tax.** Every step run
  starts a new CLI conversation that re-reads the repo from zero (task steps
  deliberately keep their own continuation chains, #123). The delegated
  developer regularly burns high turn counts on re-orientation the
  conversation's own agent already has. The separate "dev" identity adds a
  system prompt and an allowlist — not knowledge, not independence that
  matters (the QA gate is where independence pays).
- **The architect has no structural moment.** Nothing in the flow ever asks
  "does this warrant design first?" — the architect runs only when the owner
  opens a conversation with him, or (before #124) when the router mis-seated
  him as the implementer. His actual value shows up in dogfooding as
  *consults*: architecture reviews and ADR drafting on request.

Owner direction (2026-07-23): stop hardcoding "always do X"; the system
should decide whether a specialist helps or the work is solved by whoever
already has it. Keep architect and QA as meaningful roles; a free-standing
dev identity is in doubt.

## Options

1. **Do nothing** — router-proposed dev (capability-gated since #124). Keeps
   the fresh-context tax and leaves the architect structurally unused.
2. **Fixed richer pipeline** (architect → dev → QA for every task) —
   maximizes architect relevance, but doc 18 §6/§10 already rejected
   workflow-templates until a pipeline earns its shape in practice, and
   up-front triage predicts complexity exactly when the least is known: most
   tasks would pay a design step they do not need.
3. **Implementer defaults to the conversation's agent; architect is an
   on-demand, bounded design consult; QA stays an unconditional gate** — the
   delegation decision is made where the information lives: by default no
   third party implements, and the *worker* (or the owner) pulls the
   architect in when the need is discovered, not predicted.

## Decision

Option 3.

- **Implementation seat: the conversation's agent first.** `resolveDevSpecialist`
  precedence becomes: the conversation's agent when implementation-capable
  (#124 gate unchanged) → else the router's proposal when capable → else the
  first capable specialist by stable id order; the QA specialist is never
  eligible. With ADR-014, the conversation's agent is naturally the task's
  owner — the entity with the context implements by default.
- **New step kind `design` — the architect consult.** Bounded, on-demand:
  - **Who requests it:** the implementer, by a deterministic marker in its
    step output (`NEEDS_DESIGN: <question>` — same mechanism as QA's
    `CHANGES_REQUIRED`); or QA, flagging that the failure is architectural;
    or the owner, explicitly (message/affordance).
  - **What it is:** one step run by an architecture-capable specialist
    (declared `capabilities` including `architecture` or `design`), with
    **read-only** workspace access (ADR-010 ladder — a consult never writes),
    producing a **DesignBrief** work product (family envelope, 18 §4):
    `{objective, constraints, approach, risks, outOfScope}`.
  - **How it lands:** the brief is folded into the next developer prompt,
    exactly like QA feedback. At most **one consult per QA cycle** — a loop
    of consults is a stall, and the no-progress guard (#124) still applies.
  - No architecture-capable specialist configured → the request is a no-op
    (logged); the loop proceeds. The consult is an enhancer, never a gate.
- **QA remains an unconditional gate.** Independent verification is a policy
  (the human-approval ladder's first rung), not a delegation decision — this
  ADR does not touch it.
- **Not decided here:** promoting `design` to a fixed pipeline stage. Per
  doc 18's extraction discipline, that happens only if real tasks request
  the consult so consistently that the pattern has earned template status
  (three real repetitions, then an ADR).

Reversible: orchestration + one enum extension. `task_steps.kind` and
`work_products.kind` carry CHECK constraints (migration 008), so `design` /
`design_brief` need a forward-only migration; the seat-precedence change is
pure code.

## Consequences

- **Cheaper tasks by default:** the common case (conversation agent
  implements) skips the third-party fresh-context tax; specialists run when
  they add something — verification (always) and design (when pulled).
- **The architect gets a real, bounded slot** with the right authority shape:
  read-only, advisory, producing a durable work product the owner can read in
  the task view — instead of either silence or a mis-assigned dev seat.
- **Delegation becomes a decision at two honest points:** the router still
  classifies the work's shape up front (cheap triage), and the worker pulls
  expertise mid-task when discovered (informed). Neither hardcodes "always".
- **Costs accepted:** a consult is a full fresh-context step run (money and
  minutes) — bounded to one per QA cycle; marker-driven requests are
  deterministic but crude (a missed marker means no consult — the owner can
  always ask explicitly).
- Follow-ups: migration (step/work-product kind enums), StepRunner/extractor
  support for `DesignBrief`, seat-precedence change + tests, doc 18 §4 family
  registry row, TaskView rendering of the brief; ADR-009 amendment on
  acceptance.
