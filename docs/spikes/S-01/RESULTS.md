# S-01 Results

**Run:** `20260714T141723Z` · **Image:** `shared-terminal-session:latest` (CLI `2.1.207`, default model `claude-sonnet-5`) · **Auth:** subscription OAuth (`CLAUDE_CODE_OAUTH_TOKEN` env var) · **Host:** the substrate's own Docker host · **Fixtures:** [`fixtures/run-20260714T141723Z/`](./fixtures/run-20260714T141723Z/) (sanitized: 5 session ids, 42 UUIDs replaced; reviewed by hand).

A first attempt (`20260714T141224Z`, discarded) failed on probe-harness bugs and
accidentally produced one finding of its own — see [Zombies](#zombies-q-08).

## Answers

| Question | Verdict | Evidence |
| --- | --- | --- |
| i — freeze without permission flags | **NO freeze on 2.1.207 — silent auto-denial.** The run completes `success` in 5.8 s with `is_error: false`; the Write attempt lands in `permission_denials` (tool name + full input) and no file is created. The risk is worse than a hang in one way: an unpoliced runner would report "success" on work that silently didn't happen | `p1-freeze/stream.jsonl` (result event) |
| ii — `--resume` startup latency | **~550–580 ms to first event; 3.2–4.1 s total** for a trivial turn (n=3). `session_id` is **stable across resumes** (all three turns share P2's id). Per-turn process model (Q-01) validated | `p2-baseline/`, `p3-resume-*/meta.json` |
| iii — cancellation mid tool call | **TERM → `terminated` within the first poll**; the in-flight `sleep 120` died with the group; the CLI flushed nothing after TERM (stream just ends); exec exit code 15. **A killed run emits NO `result` event** → no cost/usage record for cancelled runs (see consequences) | `p4-cancel/` (meta.json, stream.jsonl) |
| iv — result fields | `total_cost_usd`, `num_turns`, `usage{input_tokens, output_tokens, cache_*, service_tier, …}`, `session_id`, `uuid`, `permission_denials` — **all populated under subscription auth** (cost is notional dollars; run total ≈ $0.16). `UsageRecord` (A3) can consume this as-is | `p*/result-event.json`, `summary.txt` |
| v — `tool_use` shape | **Directly derivable**: `Write` → `input.file_path` + `input.content`; `Bash` → `input.command` + `input.description`. Activity view (A2) needs no filesystem diffing. Bonus event type discovered: `rate_limit_event` (subscription accounts) — doc 08 must treat unknown event types as pass-through | `p5-toolshape/tool-use-extract.json` |
| + onboarding | **No onboarding/trust blocker**: a fresh state dir + `CLAUDE_CODE_OAUTH_TOKEN` alone produced a successful turn (P0). The Hub runner needs no config seeding for auth | `p0-onboarding/` |

## Zombies (Q-08)

Confirmed on both attempts, two different ways:

- Clean run: each group-killed exec leaves **exactly one zombie** (`claude`
  child, re-parented to PID 1, never reaped) — `zombies-after-p4-kill.txt`.
- First attempt (double-fork harness bug): 8 orphaned `claude` processes → 8
  permanent zombies, demonstrating PID 1 (`tail -f`) reaps nothing.

Implication: with `PidsLimit: 1024`, a long-lived container tops out around
~1000 cancelled runs. Slow leak, real ceiling. Reported upstream on the exec
API proposal (shared-terminal#381) with a suggested smoke-test phase +
`Init: true` evaluation.

## Consequences applied

1. **Q-01 closes**: per-turn `claude -p --resume` validated — sub-second
   startup, stable session id.
2. **R-03 re-scoped**: "freeze forever" → "silent denial"; the mitigation is
   unchanged (explicit allowlist per Q-02 + timeout backstop) but the failure
   mode a missing policy produces is *silent no-op reported as success*, which
   the runner must treat as a first-class outcome (surface
   `permission_denials` in the activity view).
3. **Q-10 closes**: subscription OAuth works headless; cost fields populated.
4. **New requirement for the runner/UsageRecord**: cancelled runs have no
   `result` event — usage for them must be marked unknown (or reconstructed
   from earlier stream events); doc 08/09 requirement.
5. **Harness lessons that transfer to the runner** (doc 08): `--allowedTools`
   is variadic — prompts must ride stdin, never positionally after it; and
   process supervision must hold the direct parent (`setsid --wait`
   semantics) or exit codes are masked and orphans zombify.
