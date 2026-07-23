# Architecture Decision Records

Numbering restarted for this repo — the discovery-era ADR candidates (001–005)
predate the separate-repos decision and are superseded by the list below.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-001](./ADR-001-shared-terminal-exec-seam.md) | Integration seam with shared-terminal (exec-over-HTTP contract) | **accepted** — ships with [contracts/shared-terminal-exec-api.md](../contracts/shared-terminal-exec-api.md) (PROPOSAL) |
| [ADR-002](./ADR-002-hub-persistence.md) | Hub-owned persistence (SQLite local + R2 backups after the S-03 gate fired on D1 latency; deployment shape recorded) | **accepted** (2026-07-14) |
| [ADR-003](./ADR-003-claude-cli-runner.md) | Claude CLI runner integration (per-turn command construction, event mapping, marker-based post-cancel sweep, budget strategy — S-01 lessons encoded); **amended 2026-07-19 — budget cap optional, off by default** | **accepted** (2026-07-14, amended 2026-07-19) |
| [ADR-004](./ADR-004-ui-streaming-transport.md) | Hub↔frontend streaming: SSE with `Last-Event-ID` replay from the store | **accepted** (2026-07-14) |
| [ADR-005](./ADR-005-project-aggregate.md) | Project as the organizing aggregate (one workspace/container per project; conversations share it; minimal shape with an explicit deferred list) | **accepted** (2026-07-14) |
| [ADR-006](./ADR-006-workspace-belongs-to-the-project.md) | The workspace belongs to the project, not the agent (`sessionTemplateId` moves off `Agent`; `Project` gains `repo`) — the code catching up to 18 §2's two axes | **accepted** (2026-07-16) |
| [ADR-007](./ADR-007-session-ownership-and-binding.md) | Session ownership moves to the **owner's admin account**; projects bind an existing session or create one there; the dedicated account demoted to audited execution identity (supersedes SEC-06's ownership clause and Q-04's provisional resolution) | **accepted** (owner, 2026-07-17) |
| [ADR-008](./ADR-008-specialists-and-execution-target.md) | Specialists as reusable identities with optional personal sessions; conversation modes with automatic routing; model router proposes, **deterministic execution-target selector** chooses the session, orchestrator enforces | **accepted** (owner, 2026-07-17) |
| [ADR-009](./ADR-009-task-lifecycle-dev-qa-approval.md) | Task entity with the developer → QA → human-approval lifecycle; `ImplementationReport`/`QaReport` work products; complete only after QA **and** owner approval | **accepted** (owner, 2026-07-17) |
| [ADR-010](./ADR-010-code-sharing-strategies.md) | Sharing a project's code with a specialist: strategy ladder (project session / worktree / read-only / diff / artifact) under least privilege; repo authority stays with the project session | **accepted** (owner, 2026-07-17) |
| [ADR-011](./ADR-011-browser-auth-cloudflare-access.md) | Browser auth via Cloudflare Access — the backend verifies the signed `Cf-Access-Jwt-Assertion` (aud + iss + JWKS signature), never the forgeable email header; bearer token retained for localhost/programmatic. Resolves Q-07 for Phase-1 browser auth | **accepted** (owner, 2026-07-17) |
| [ADR-012](./ADR-012-router-model-call.md) | The automatic-mode **model router** (N4b) calls the Messages API directly (Haiku 4.5, structured output) reusing `CLAUDE_CODE_OAUTH_TOKEN` — a narrow control-plane carve-out from ADR-001's "all model I/O via the seam"; deterministic fallback on failure; offline suite unaffected | **accepted** (owner, 2026-07-19) |
| [ADR-013](./ADR-013-orchestrator-decomposition.md) | Decompose the ~1,667-line **Orchestrator** god-class into four intra-module collaborators (ProvisioningService / SessionResolver / RunLoop / TaskCoordinator) behind a thin facade; boundaries preserved by construction; incremental extract-at-the-hilt migration. Drafted by the architect specialist from the architecture review's C4 | **proposed** (2026-07-21) |
| [ADR-014](./ADR-014-one-active-task-per-conversation.md) | **One active task per conversation (I-14)** — messages during it are answered (`question`) or folded into it at the next step boundary (`steer`); never a sibling task. Explicit user request is the only early split; after a terminal task the conversation is free. Kills the sibling-task spawn storms (2026-07-22 incident) | **proposed** (2026-07-23) |
| [ADR-015](./ADR-015-implementer-default-and-architect-consult.md) | **The conversation's agent implements by default** (capability-gated, #124); the **architect becomes an on-demand `design` consult** — read-only step, `DesignBrief` work product, requested by the implementer/QA via marker or the owner, bounded to one per QA cycle. QA stays an unconditional gate | **proposed** (2026-07-23) |

Remaining candidate (deliberately deferred, non-blocking): a full Hub-owned
user/tenant login (ADR-011 Option 4) — written if Cloudflare-independent
deployment or multi-user is ever required.

## Format

```markdown
# ADR-NNN — Title

Status: proposed | accepted | superseded by ADR-MMM
Date: YYYY-MM-DD

## Context        — the constraint forcing a decision, with evidence
## Options        — each option with trade-offs; MUST include "do nothing"
## Decision       — what and why; reversible vs irreversible called out
## Consequences   — costs accepted, follow-ups created, risks opened/closed
```

Rules:

- Every ADR lists the **do-nothing option** and argues against it with evidence
  (anti-over-architecture, risk R-10).
- Substrate claims cite file/line at a named commit.
- A superseded ADR is never deleted; its status line points forward.
