# Architecture Decision Records

Numbering restarted for this repo — the discovery-era ADR candidates (001–005)
predate the separate-repos decision and are superseded by the list below.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-001](./ADR-001-shared-terminal-exec-seam.md) | Integration seam with shared-terminal (exec-over-HTTP contract) | **accepted** — ships with [contracts/shared-terminal-exec-api.md](../contracts/shared-terminal-exec-api.md) (PROPOSAL) |
| [ADR-002](./ADR-002-hub-persistence.md) | Hub-owned persistence (SQLite local + R2 backups after the S-03 gate fired on D1 latency; deployment shape recorded) | **accepted** (2026-07-14) |
| [ADR-003](./ADR-003-claude-cli-runner.md) | Claude CLI runner integration (per-turn command construction, event mapping, marker-based post-cancel sweep, budget strategy — S-01 lessons encoded) | proposed |
| [ADR-004](./ADR-004-ui-streaming-transport.md) | Hub↔frontend streaming: SSE with `Last-Event-ID` replay from the store | proposed |

Remaining candidate (deliberately deferred, non-blocking): Hub user/auth model
(Q-07) — written when multi-user pressure is real.

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
