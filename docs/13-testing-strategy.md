# 13 — Testing Strategy (Phase 1)

**Status:** approved (owner, 2026-07-15) · **Last updated:** 2026-07-14

How Phase 1 is verified. The strategy follows from three properties already
decided: ports have fakes as first-class peers (06 §4, A1), the S-01 fixtures
are a deterministic corpus ([spikes/S-01](./spikes/S-01/RESULTS.md)), and the
store is the source of truth (NFR-07). Test obligations were seeded in
04/08/09/10/12; this doc consolidates and orders them.

## 1. Levels

| Level | Scope | Determinism |
| --- | --- | --- |
| Unit | pure logic: state-machine legality, summary derivation, event mapping, scrubbing | total |
| Contract | each port against all its implementations | total (fixtures/fakes) |
| Integration | vertical slice end-to-end on the **fake** substrate + runtime | total (no network/tokens) |
| Smoke (real) | a handful of owner-run checks against a real session | manual, out of CI |

The pyramid is deliberate: everything that must be *reliable in CI* is
fixture-driven and offline. Real Claude is nondeterministic and costs tokens —
it is never in the automated suite (only the S-01 package exercises it,
owner-run, R-02).

## 2. Contract tests (the spine)

- **`HubStore`**: one suite run against SQLite and the in-memory fake —
  identical results, including guarded-update *rejections* (I-2/I-3 illegal
  transitions must fail the same way in both). This is what lets the fake
  stand in for SQLite everywhere else.
- **`RuntimeAdapter`**: the real `claude-cli` adapter and the fake, fed the
  same sanitized S-01 fixtures, must emit **identical `RunEvent` streams**
  (ADR-003 mapping). Divergence fails CI, not production (R-12) — this is the
  gate that keeps the fake honest and catches CLI-version drift (R-02).
- **`SubstrateExecPort`**: the fake replays fixtures; a thin conformance suite
  pins the wire shape (NDJSON events, kill outcomes, `unknown` status
  semantics) against the tracked exec contract so the real HTTP adapter is
  checked against the same expectations.

## 3. Integration (fake-driven end-to-end)

The full spine from doc 12 Increment 1, in CI, offline:

- Create project → provision (fake) → create conversation → send → run streams
  fixture events → activity projection → terminal → `RunSummary` → SSE
  delivery. Assert persisted rows, projection, and SSE payloads all agree.
- **Queue/serialization** (I-2): two messages in one project → second queues →
  dispatches after the first terminates, including after a cancel (FR-04).
- **Cancellation** (UC-04): kill mid-fixture-stream → `cancelled` + outcome +
  sweep result recorded; usage `unknown` (FR-18/20/21).

## 4. Failure-mode tests

- **Crash-point (reconciler)**: kill the process between each §3-of-doc-09
  transaction; on restart the reconciler must heal to a legal state — including
  a run left in `interrupted` between the two reconcile transactions (UC-06).
- **SSE reconnect-with-gap**: drop the connection mid-run, reconnect with
  `Last-Event-ID`; assert gapless replay of `run_events`-derived events and
  correct REST recovery of the non-replayable state/summary events (11 §5,
  08 §3).
- **Idempotent ingestion**: replay an S-01 fixture stream twice → identical
  row counts (I-4).
- **Restore drill (automated)**: snapshot → restore into a scratch DB → boot
  reconciliation → assert data intact and a turn can run (OPS-03, R-16). The
  once-before-Phase-1-exit production drill is manual and additional.
- **Migration runner** (the migration half of this gate; strategy in 09 §4):
  apply the initial DDL from an empty database *and* from a
  schema-version-gap fixture (an older `meta.schema_version`) → assert the
  schema lands at the current version; assert a deliberately failing
  migration **aborts boot** and leaves no half-migrated database. Runs every
  CI build.

## 5. Security-derived tests (from doc 10 §6; also I-7, NFR-08/R-09)

These turn threat-model assumptions into assertions:

- **Gateway route coverage**: a test enumerates every mutating route and
  asserts the auth gateway is in front of it — a missed route is V-3's whole
  risk, so it cannot rely on convention.
- **No-payload-logging**: assert (lint rule or test) that no log statement
  writes an event payload by default (SEC-05).
- **Scrubbing**: run the secret-scrubber over the S-01 corpus + known token
  formats; assert none survive into persisted events (SEC-05, V-2).
- **Policy non-empty**: a run cannot be created with an empty allowlist
  (I-7) — assert the store rejects it and the API 422s.
- **Fixture sanitizer gates**: CI runs the S-01 sanitizer's hard-fail checks
  (keys, `msg_/req_/toolu_`, thinking signatures) over committed fixtures so a
  future fixture can't leak (NFR-08, R-09).

## 6. CI structure

- On every PR: lint, link check, and the full offline suite (unit + contract +
  integration + failure-mode + security-derived) — all deterministic, no
  secrets, no network.
- The suite must pass with **no `ANTHROPIC`/`CLAUDE`/`CLOUDFLARE` credentials
  present** — proof that CI never depends on real services (mirrors the
  substrate's standalone-smoke discipline).
- Real smoke checks (§1) and the S-01 fixture refresh (on CLI bump, R-02) are
  owner-run and documented in doc 14, not gated in CI.

## 7. Coverage intent

Not a percentage target. The contract suites (§2) and the security-derived
tests (§5) are the non-negotiable core — they encode the invariants and the
threat-model assumptions. New behavior lands with the test that would fail
without it; a bug fix lands with the test that reproduces it first.

## 8. Explicitly not tested in CI

Real Claude turns (nondeterministic, costs tokens — S-01 package only) · real
shared-terminal sessions (owner smoke only) · real R2/Cloudflare (fake object
store in tests) · performance/load beyond the NFR budgets (measured, not
CI-gated) · frontend visual regression (Phase-1 UI is thin; revisit if it
grows).
