# Agent Hub

> **Status: specification phase.** No product code yet — this repo currently holds
> scaffolding, foundational documents, and architecture decision records. Implementation
> starts only after the quality gates defined in [`docs/`](./docs/README.md) pass.

Agent Hub is a personal, chat-first hub for AI agents. Users create conversations
(per project, topic, or task); each conversation is handled by one or more **agents**.
An agent is a *logical entity* — identity, instructions, specialty, tools, memory,
permissions, policies — **decoupled from the runtime** that executes it. The same agent
can move between runtimes without losing identity, memory, or configuration.

The first runtime is the Claude Code CLI running inside a
[shared-terminal](https://github.com/gatof81/shared-terminal) session. Later runtimes
(local models, HTTP services, remote Agent Nodes) plug in behind the same adapter contract.

## Core principles

- **Backend as authority** — models propose; permissions, secrets, execution, delegation,
  and spending limits are enforced in code by deterministic policies.
- **Autonomy progression** — level 0 (read-only) → 1 (reversible changes) → 2 (external
  actions) → 3 (critical actions), configurable per user/agent/tool/project/chat.
- **Anti-over-architecture** — modular monolith, one database, adapters, testable
  contracts. No Kubernetes, microservices, Kafka, vector databases, event sourcing,
  or CQRS in the MVP.

## Relationship to shared-terminal

Agent Hub and shared-terminal are **separate repositories**. The integration seam is
shared-terminal's public HTTP API — the Hub never reaches into its internals. When the
Hub needs new API surface there, the contract is designed here as a proposal
(`docs/contracts/`) and implemented through that repo's own process.

## Documentation

Start at [`docs/README.md`](./docs/README.md) — document index, reading order,
work plan, and quality gates.

## License

[MIT](./LICENSE)
