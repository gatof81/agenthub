# Agent Hub backend

TypeScript/Node modular monolith ([docs/07-architecture.md](../docs/07-architecture.md) §2).
Module dependency arrows are enforced by `eslint-plugin-boundaries`
(`eslint.config.js` — B1-11): register a new module there, with its allowed
dependencies, before importing it.

Current modules (Increment 1 in progress, [docs/17-phase1-backlog.md](../docs/17-phase1-backlog.md)):

| Module | Contents |
| --- | --- |
| `src/domain` | canonical types (doc 06), run state machine (doc 05), ports (06 §4), pure projections (activity A2, RunSummary FR-42), id/clock |
| `src/store` | `HubStore` port + SQLite (doc 09) and in-memory implementations, migrations |
| `src/orchestrator` | send → queue → dispatch → ingest → terminal (09 §3), provisioning UC-01, cancellation UC-04, boot reconciler UC-06 |
| `src/runtime` | ADR-003 stream-json mapping (the R-12 contract surface), fake `RuntimeAdapter` |
| `src/substrate` | fake `SubstrateExecPort` (S-01 fixture replay, kill honoring, contract `unknown` semantics) |

## Commands

```bash
npm ci          # install
npm run lint    # eslint incl. module-boundary rules
npm run typecheck
npm test        # vitest: unit + contract suites, offline, deterministic
```

The test suite is fully offline and deterministic (doc 13 §6): no network,
no credentials, no real services — CI asserts credential-shaped env vars are
absent before running it.
