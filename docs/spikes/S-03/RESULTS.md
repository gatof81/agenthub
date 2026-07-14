# S-03 Results

**Authoritative run:** `vm100` label, 2026-07-14, from the Hub's deployment
host (co-located with the substrate) — [results-vm100.json](./results-vm100.json).
Preliminary run from a non-representative host:
[results-dev-container.json](./results-dev-container.json) (same shape, same
conclusions). Scratch database `agenthub-s03-scratch`; tables dropped; no
account/database identifiers in the result files.

## Verdict: the ADR-002 revert criterion fired

Pre-agreed gate: turn-commit p50 > 150 ms from the co-located host → revert
to SQLite. **Measured: 291 ms p50 (p95 480 ms).** Owner confirmed the
reversion 2026-07-14; [ADR-002](../../adr/ADR-002-hub-persistence.md) now
records **SQLite local + scheduled backups to R2** as the accepted decision.

## Numbers (from the deployment host)

| Measurement | p50 | p95 | n |
| --- | --- | --- | --- |
| Turn-commit, 1 multi-statement call (1 msg + 20 events + usage) | **291 ms** | 480 ms | 15 |
| Turn-commit, 3 sequential calls (naive) | 862 ms | 1119 ms | 15 |
| Single-statement write | 291 ms | 325 ms | 30 |
| Read-back last 50 events | 263 ms | 277 ms | 15 |

Reading: every operation pays a ~260–290 ms round-trip floor regardless of
size — D1 latency is distance-to-Cloudflare-bound, and co-location with the
substrate does not lower it. Batching amortizes statements (22 statements in
one call cost the same as one statement) but cannot beat the floor.

## Secondary findings (transfer to doc 09 regardless of engine)

- **~100 KB per-statement ceiling**: a 256 KB inlined value fails with
  `statement too long: SQLITE_TOOBIG`; 64 KB passes. Event payloads must be
  capped (and oversized tool output truncated/segmented) — SQLite has
  analogous (higher) limits, so the cap is good schema hygiene either way.
- **Batching discipline matters on any remote store**: 1-call vs 3-call is
  3× — recorded as evidence for why the hot path must not be RTT-bound at
  all.

## Quota math (recorded for completeness; moot after the reversion)

A turn = 1 HTTP request / 22 statements in the batched design. At a generous
200 turns/day, that is ~4.4k statement-writes/day — far inside D1's free-tier
daily write allowance, so the *quota* headroom criterion (≥ 10×) passed;
the decision fell on latency alone.

## Package

`spikes/S-03/run-spike.mjs` — rerunnable if D1 economics/latency ever change
materially (needs `CLOUDFLARE_API_TOKEN` scoped to D1 + account id; Node ≥ 18).
The scratch database can now be deleted.
