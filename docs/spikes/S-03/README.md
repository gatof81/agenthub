# Spike S-03 — D1 turn-commit latency, size limits, quota math (runbook)

**Status:** **EXECUTED 2026-07-14** — authoritative run from the deployment
host captured; **the ADR-002 revert criterion fired** (turn-commit p50
291 ms > 150 ms) and the decision reverted to SQLite local + R2 backups.
See [RESULTS.md](./RESULTS.md).

## What it measures

Against a throwaway schema shaped like Phase 1 (`messages`, `run_events`,
`usage_records`) on the scratch database `agenthub-s03-scratch` (never a
production DB; tables dropped on exit):

1. Single-statement write latency (n=30) — the RTT floor every write pays.
2. **Turn-commit as one multi-statement call** (1 message + 20 events in a
   single multi-row INSERT + 1 usage record; n=15) — the batched design
   ADR-002 mandates.
3. Turn-commit as 3 sequential calls (n=15) — the naive baseline.
4. UI read-back: last 50 events (n=15).
5. Value-size probe: event payload 64 KB → 2 MB until the API refuses.

## Run

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  node spikes/S-03/run-spike.mjs --label vm100 > results-vm100.json
```

Requires Node ≥ 18 (built-in fetch) and a token scoped to Account → D1 →
Edit only. Results contain no tokens, account ids, or database UUIDs (only
the scratch database's name) — safe to commit after review. No model tokens are spent; D1 free-tier usage only.

## Preliminary results (dev container, ~2026-07-14)

See [results-dev-container.json](./results-dev-container.json). Headlines:

- Everything is RTT-dominated: single write ≈ turn-commit-1-call ≈ read
  ≈ **260–280 ms p50** from this host; D1 processing time is negligible.
- Batching is the whole game: 1-call commit 280 ms vs 3-call 812 ms p50.
- **Hard statement-size ceiling between 64 KB and 256 KB**
  (`SQLITE_TOOBIG` — consistent with D1's documented 100 KB per-statement
  limit). Doc 09 requirement: cap/chunk event payloads (~64 KB safe inline).

## Interpretation guard

The dev-container numbers do NOT decide the ADR-002 gate — the criterion is
defined from the co-located host. But note the shape of the risk: D1 latency
is distance-to-Cloudflare-bound, not distance-to-substrate-bound, so
co-location with the substrate does not by itself buy a lower floor. If the
VM run also lands above 150 ms p50 for the 1-call commit, the ADR's agreed
revert-to-SQLite criteria fire and the decision goes back to the owner with
numbers on the table.
