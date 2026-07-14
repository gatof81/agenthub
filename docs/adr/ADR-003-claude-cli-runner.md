# ADR-003 — Claude CLI runner integration

Status: accepted (owner sign-off 2026-07-14)
Date: 2026-07-14

Evidence: [S-01 results](../spikes/S-01/RESULTS.md) (CLI 2.1.207) ·
[exec contract](../contracts/shared-terminal-exec-api.md) (tracking upstream
`EXEC_API.md`, live) · requirements FR-10..FR-25.

## Context

The `claude-cli` implementation of the `RuntimeAdapter` port (06 §4) must turn
a Hub run into a substrate exec and the CLI's stream-json output into
`RunEvent`s — encoding every S-01 lesson so implementation doesn't rediscover
them. Q-01 already resolved the process model (per-turn); this ADR fixes the
concrete command construction, event mapping, caps, cancellation, and
recovery behavior.

## Options

For the process model — re-affirmed, not reopened: **per-turn
`claude -p --resume`** (chosen; Q-01, measured ~0.6 s to first event). A
**long-lived interactive process** was rejected in 15 (Q-01) — lifecycle,
cancellation, and crash-recovery complexity with no measured need.
**Do nothing** (no adapter layer, the orchestrator shells out directly) is
rejected by R-12: the fake runtime must be a peer implementation, which
requires the port. The sections below fix the *how* of the chosen option.

## Decision

### Command construction (per turn)

```text
claude -p --output-format stream-json --verbose
       --allowedTools <agent allowlist>        # never absent (I-7)
       --max-turns <caps.maxTurns>
       [--resume <runtimeSessionId>]           # omitted only on first turn
```

- **Prompt via stdin, always.** `--allowedTools` is variadic and eats
  positional prompts; `--resume` with an empty value eats them too (S-01).
  Stdin sidesteps the whole flag-ordering bug class.
- `--resume` uses `Conversation.runtimeSessionId`; the id captured from each
  result event replaces it (drift-tolerant, FR-24).
- Env via the exec request: the OAuth token plus per-run markers (below);
  validated Hub-side against the seam's session-config rules before dispatch.
- The exec's `maxDurationMs` is set to the run's wall-clock cap (FR-17); the
  seam's 1 h backstop stays behind it as defense in depth.

### Event mapping

| CLI stream-json | RunEvent | Notes |
| --- | --- | --- |
| `system/init` | `started`-adjacent metadata | records `cliVersion`, `model`, session id (FR-12) |
| `assistant` / `user` turns | `output` | assistant text deltas feed the UI stream |
| `tool_use` blocks | `tool_use` | activity projection source (FR-14) |
| result `permission_denials[]` | one `permission_denial` per entry | first-class outcome → `completed_with_denials` (FR-15) |
| `result` | terminal metadata + `UsageRecord` | cost/usage/num_turns; absent for killed runs → `source: cancelled-unknown` (FR-18) |
| anything else (`rate_limit_event`, seam `dropped`, future types) | `unknown` (verbatim, capped) | FR-16 |

### Budget cap (FR-17) — enforcement strategy

The CLI reports authoritative cost only in the result event, so a hard
pre-spend budget is unenforceable at this layer. Phase 1 enforces budget as:
`--max-turns` + wall-clock cap as the structural bounds, plus a running
estimate from streamed `usage` fields — if the estimate crosses the cap, the
runner cancels the run (kill path) and marks it `failed` with a
budget-exceeded error. Documented limitation: the estimate lags by up to one
model call; the residual risk stays under R-06.

### Cancellation and the post-cancel sweep (FR-20/21)

1. `POST …/kill {graceMs}`; record the `outcome` — **authoritative over the
   stream's `reason`** (merged contract).
2. **Sweep via the seam itself**: every run's exec env carries a marker
   (`HUB_RUN_ID=<runId>`), inherited by all descendants — including Bash-tool
   children that escape the process group (S-01). The sweep is a short
   follow-up exec that scans `/proc/*/environ` for the marker and TERM→KILLs
   survivors, reporting what it found. Result recorded in `Run.sweepResult`.
3. Zombies are upstream-reaped since `Init: true` (#387); the sweep handles
   *running* survivors only.

### Recovery

Boot reconciliation per UC-06 (status endpoint; `unknown` covers
registry-lost and never-existed alike). The adapter itself is stateless
across restarts — everything it needs lives in the run row and the
conversation's `runtimeSessionId`.

## Consequences

- The adapter encodes CLI-version-specific behavior (flag semantics, event
  shapes) against **pinned 2.1.207 fixtures**; a CLI bump upstream requires a
  fixture refresh (S-01 package stays runnable) and a contract-test pass
  before the Hub accepts the new version (R-02).
- The `HUB_RUN_ID` marker becomes part of the runner's contract with itself;
  doc 08 specifies it, doc 13 tests the sweep against a deliberately escaping
  child.
- Budget enforcement is honest-but-lagging in Phase 1; tightening it (e.g.
  server-side usage streaming) is a later-phase concern.
- The fake `RuntimeAdapter` replays sanitized S-01 fixtures through exactly
  this mapping — divergence between fake and real is a test failure, not a
  drift (A1, R-12).
