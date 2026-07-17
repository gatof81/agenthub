# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Agent Hub — a personal, chat-first hub for AI agents, built spec-first. The `docs/` tree (01–18 + ADRs) is the **normative specification**; code comments and PRs cite it constantly (`doc 07 §2`, `FR-21`, `SEC-04`, `UC-06`, `B3-04`, `R-09`). When a reference like that appears, the source of truth is the corresponding doc, not the comment. Start at `docs/README.md` for the index, work plan, and current increment status.

The runtime substrate is [shared-terminal](https://github.com/gatof81/shared-terminal), a **separate repo** consumed only through its public HTTP API ("the seam", ADR-001; contract tracked in `docs/contracts/`). Substrate facts in docs are verified at a pinned commit noted in `docs/README.md` — re-verify against the real code (file:line) before relying on or citing them.

## Commands

Backend (`backend/`, Node >= 22):

```bash
npm ci
npm run lint        # eslint incl. module-boundary rules
npm run typecheck
npm test            # vitest run — offline, deterministic
npx vitest run test/sse.test.ts        # single test file
npx vitest run -t "name substring"     # single test by name
npm run dev         # tsx watch src/main.ts
npm run build && npm run smoke   # smoke boots the dist artifact — build alone has shipped broken before
```

Frontend (`frontend/`, React 19 + Vite):

```bash
npm ci
npm run build       # tsc --noEmit && vite build
npm test            # vitest run (tests co-located in src/)
npm run dev
```

CI (`.github/workflows/ci.yml`) additionally runs markdownlint (`.markdownlint-cli2.jsonc`) and a lychee link check over **all** `*.md` — broken links fail the build.

## Architecture (backend)

Modular monolith with dependency arrows **enforced by `eslint-plugin-boundaries`** (`backend/eslint.config.js`): a new module must be registered there, with its allowed dependencies, before anything can import it. Arrows: `api → orchestrator/store`, `orchestrator → runtime/store`, `runtime → substrate`, `backup → store`; `config` feeds api/orchestrator/runtime/substrate; everything may import `domain`; `domain` imports nothing.

- `src/domain` — canonical types, run state machine, **ports** (interfaces), pure projections. All cross-module contracts are ports defined here.
- `src/main.ts` — composition root, the only file allowed to see every module. It wires port implementations based on env (`config/runtime.ts`): `HUB_RUNTIME=fake` (default, offline — fixture-replay substrate + fake adapter) or `real` (seam client + `claude-cli` adapter, OAuth token rides each run's exec env only).
- `src/orchestrator` — the run loop: send → queue → dispatch → ingest → terminal; provisioning, cancellation (post-cancel sweep for escaped children, FR-21), boot reconciliation, timeouts/budget caps.
- `src/runtime` — ADR-003 stream-json mapping of Claude CLI output; fake and real `RuntimeAdapter`.
- `src/substrate` — fake and real `SubstrateExecPort` (the seam client).
- `src/store` — `HubStore` port with SQLite (production, ADR-002) and in-memory implementations, plus migrations. Backups are `VACUUM INTO` snapshots gzipped to R2/local (`src/backup`), never raw WAL copies.
- `src/api` — Express HTTP + SSE gateway: token auth, error taxonomy (doc 08 §6), `Last-Event-ID` replay from the store (ADR-004).
- `src/observability` — injected structured JSON logger + metrics. The `Logger` field type admits only scalars, so logging a payload object is a **compile error** by design (no-payload-logging rule, SEC-04/05) — don't work around it.

Key test conventions: the suite is **fully offline and deterministic** (doc 13 §6) — no network, no credentials; CI asserts no `ANTHROPIC*`/`CLAUDE*`/`CLOUDFLARE*` env vars are present before running it. Ports have shared contract suites run against both implementations (`test/storeContract.ts`, real-vs-fake adapter contract, exec-port conformance) — when changing a port, update the contract suite, not just one implementation.

Agent definitions load from YAML (`AGENTS_CONFIG`); real definitions live **outside** the repo — `agents.example.yaml` is the committed template, same pattern as `.env.example` vs gitignored `.env`.

## Working conventions

- All repo artifacts (code, docs, commits, PRs, issues) in English; conversation with the owner (Diego) in Spanish.
- One PR = one coherent change; present the plan and wait for OK before writing. Never commit directly to main; squash-merge; Conventional Commits.
- Every PR waits for the review bot. The verdict is the **text** in the PR comment (`gh pr view N --comments` → look for `## Verdict`: LGTM | NIT | SHOULD-FIX), **not** the check's `conclusion`, which only says the job ran. Merge only on LGTM/NIT and after the owner's merge word.
- Public repo: no real hostnames, tokens, deployment identifiers, or session IDs anywhere — sanitize fixtures before committing.
