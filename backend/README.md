# Agent Hub backend

TypeScript/Node modular monolith ([docs/07-architecture.md](../docs/07-architecture.md) §2).
Module dependency arrows are enforced by `eslint-plugin-boundaries`
(`eslint.config.js` — B1-11): register a new module there, with its allowed
dependencies, before importing it.

Current modules (Increment 1 in progress, [docs/17-phase1-backlog.md](../docs/17-phase1-backlog.md)):

| Module | Contents |
| --- | --- |
| `src/domain` | canonical types (doc 06), run state machine (doc 05), id/clock ports |
| `src/store` | `HubStore` port + SQLite (doc 09) and in-memory implementations, migrations |

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
