# S-01 Results

**Published run:** `20260714T142930Z` · **Image:** `shared-terminal-session:latest` (CLI `2.1.207`, default model `claude-sonnet-5`) · **Auth:** subscription OAuth (`CLAUDE_CODE_OAUTH_TOKEN` env var) · **Host:** the substrate's own Docker host · **Fixtures:** [`fixtures/run-20260714T142930Z/`](./fixtures/run-20260714T142930Z/) (sanitized: 5 session ids, 43 UUIDs, 12 message ids, 12 request ids, 5 tool-use ids replaced; hand-reviewed).

## Run history (three attempts, each one taught something)

| Attempt | Outcome | What it contributed |
| --- | --- | --- |
| 1 (`…141224Z`, discarded) | Harness bugs: bare `setsid` double-forked (stream truncated, exit codes masked), `--allowedTools`' variadic parsing ate positional prompts, empty `--resume` ate the prompt | 8 orphaned `claude` processes → 8 permanent zombies: **PID 1 reaps nothing** |
| 2 (`…141723Z`, discarded) | All probes green, but review caught two flaws: sanitizer left real `msg_*`/`req_*`/`toolu_*` ids, and P4's `sleep 120` was **blocked by the CLI's own built-in Bash policy** — the kill landed mid-API-call, not mid-tool | The built-in Bash-policy finding; sanitizer hardened (provider ids + hard-fail gate) |
| 3 (`…142930Z`, **published**) | Clean run; P4 redesigned around a `node -e "setTimeout(...)"` long call | Everything below, including the tool-child escape finding |

## Answers

| Question | Verdict | Evidence |
| --- | --- | --- |
| i — freeze without permission flags | **No freeze on 2.1.207 — silent auto-denial.** The run completes `success` (`is_error: false`) with the Write attempt recorded in `permission_denials` (tool name + full input) and no file created. Reproduced in both clean runs. Worse than a hang in one way: an unpoliced runner reports success on work that silently didn't happen | `p1-freeze/stream.jsonl` |
| ii — `--resume` startup latency | **~570–580 ms to first event; 3.7–4.5 s total** for a trivial turn (n=3; attempt 2 measured the same envelope). `session_id` stable across all three resumes → **Q-01 validated: per-turn process model** | `p2-baseline/`, `p3-resume-*/meta.json` |
| iii — cancellation mid tool call | Two scenarios now covered. **Mid-API-call** (attempt 2): TERM → `terminated` first poll, CLI flushes nothing, no result event. **Mid-tool-execution** (published run): same kill semantics on the `claude` group, `terminated`, exit code 15 — **but the Bash tool's in-flight child survived the group kill** (see below) | `p4-cancel/` |
| iv — result fields | `total_cost_usd`, `num_turns`, `usage{…}`, `session_id`, `uuid`, `permission_denials` — populated under subscription auth (notional dollars; published run ≈ $0.12). `UsageRecord` (A3) consumes this as-is. **Killed runs emit no result event** → their usage must be recorded as unknown | `p*/result-event.json`, `summary.txt` |
| v — `tool_use` shape | **Directly derivable**: `Write` → `input.file_path` + `input.content`; `Bash` → `input.command` + `input.description`. No fs diffing needed (A2). Extra event type observed: `rate_limit_event` → consumers must pass through unknown event types | `p5-toolshape/tool-use-extract.json` |
| + onboarding | **No onboarding/trust blocker**: fresh state dir + `CLAUDE_CODE_OAUTH_TOKEN` alone → successful turn. No config seeding needed for auth | `p0-onboarding/` |

## Finding: Bash-tool children escape the process group

In the published run, P4 killed the `claude` process group two seconds into a
running `node -e "setTimeout(() => {}, 120000)"` Bash tool call. The group
died (`terminated`, exit 15) — **and a process carrying the tool command's
argv survived the kill**. Claude Code evidently detaches Bash tool commands
into their own process group, so killing the CLI's group does not kill its
in-flight shell commands.

Implications:

1. **For the Hub runner (doc 08):** cancelling a run ≠ cancelling its running
   commands. The runner needs a post-cancel policy: sweep survivors (e.g.
   kill user processes started after run start, tmux excluded), or accept
   orphans and lean on per-run `maxDurationMs` and the substrate's
   `PidsLimit`. To be designed with doc 08; the exec seam contract (ADR-001)
   is unaffected — `killExecProcessGroup` does exactly what it promises.
2. **R-04's residual "daemon children that leave the process group" is no
   longer hypothetical** — it is the *default* behavior for every Bash tool
   call ([16-risk-register.md](../../16-risk-register.md)).

## Zombies (Q-08) — confirmed

Every group-killed exec leaves one unreaped `claude` zombie under PID 1
(reproduced in both clean runs: `zombies-after-p4-kill.txt`); attempt 1's 8/8
orphans → permanent zombies proved PID 1 reaps nothing. Ceiling ≈ 1000
cancelled runs per container lifetime against `PidsLimit: 1024`. Reported
upstream: [shared-terminal#381](https://github.com/gatof81/shared-terminal/issues/381)
(suggested smoke phase + `Init: true`).

## Other operational findings

- **CLI built-in Bash policy**: 2.1.207 blocks a bare `sleep 120` with a
  `tool_use_error` ("use Monitor / run_in_background"). The runner's
  allowlist design must account for the CLI having *its own* opinions about
  Bash usage — denials can come from two layers.
- **Harness lessons that transfer to the runner**: hold the direct parent
  (`setsid --wait` semantics) or exit codes are masked and orphans zombify;
  never pass prompts positionally after `--allowedTools` (variadic); never
  pass `--resume` an empty value (it consumes the prompt).

## Consequences applied

1. **Q-01 closed** — per-turn `claude -p --resume` validated.
2. **Q-08 closed (confirmed)** — reported upstream on #381.
3. **Q-10 closed** — subscription OAuth headless works; cost fields populated.
4. **R-03 re-scoped** — silent denial, not freeze; runner must surface
   `permission_denials` as a first-class outcome.
5. **R-04 residual upgraded** — tool-child escape is default behavior; runner
   post-cancel policy required (doc 08).
6. **UsageRecord requirement** — cancelled runs have no result event; usage
   recorded as unknown or reconstructed from prior stream events.
