# Architecture Decision Records

Numbering restarted for this repo — the discovery-era ADR candidates (001–005)
predate the separate-repos decision and are superseded by the list below.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [ADR-001](./ADR-001-shared-terminal-exec-seam.md) | Integration seam with shared-terminal (exec-over-HTTP contract) | **accepted** — ships with [contracts/shared-terminal-exec-api.md](../contracts/shared-terminal-exec-api.md) (PROPOSAL) |
| ADR-002 | Hub-owned persistence | planned |

Candidates for doc-07 time (not yet numbered): Claude CLI runner integration
(gated on S-01) · Hub↔frontend streaming transport · Hub user/auth model (Q-07).

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
