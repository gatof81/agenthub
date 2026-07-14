# Spike S-01 — headless runner probe (runbook)

**Status:** **EXECUTED 2026-07-14** — see [RESULTS.md](./RESULTS.md); fixtures
under [`fixtures/`](./fixtures/run-20260714T142930Z/). · **Package:**
`spikes/S-01/` (repo root), kept runnable for fixture refreshes on CLI bumps
(risk R-02). **Target:** shared-terminal session image at `36be2f2` (CLI
pinned 2.1.207).

## What it settles

| # | Question | Probe | Feeds |
| --- | --- | --- | --- |
| i | Does a headless run **without permission flags** freeze on the first tool prompt? | P1 (90 s timeout on a file-creation task) | risk R-03, runner policy (Q-02) |
| ii | Per-turn startup latency with `--resume` | P2 baseline + P3 ×3 (per-line timestamps) | Q-01 (per-turn process model) |
| iii | Real cancellation behavior: process-group TERM→poll→KILL mid tool call | P4 (kills during a `sleep 120` Bash call; checks the sleeper died, captures post-kill CLI output) | ADR-001 kill semantics, R-04 residual |
| iv | Cost and `session_id` fields of the result event | P2/P3 result events | UsageRecord (A3), continuity design |
| v | `tool_use` event shape — are commands/file paths derivable? | P5 (Write + Bash task, `tool-use-extract.json`) | activity view (A2), doc 08 |
| + | Onboarding/trust behavior on a fresh state dir | P0 (bare run; falls back to seeding `hasCompletedOnboarding` and records it) | runner bootstrap design |
| + | Zombie accumulation signal (PID 1 doesn't reap) | zombie census before/after each kill | Q-08, upstream #381 note |

## Prerequisites

- A Docker host with the session image built from shared-terminal @ `36be2f2`:

  ```bash
  git clone https://github.com/gatof81/shared-terminal && cd shared-terminal
  docker build -t shared-terminal-session session-image/
  ```

- `jq`, `python3` (sanitizer), `mktemp` on the host.
- An `ANTHROPIC_API_KEY` with a **hard spend cap** set in the Anthropic
  console. Expected cost: ~6 short turns on the default model — well under
  US$1; the cap is there for the failure modes, not the happy path.

## Run

```bash
ANTHROPIC_API_KEY=sk-... ./spikes/S-01/run-spike.sh            # interactive confirm
S01_YES=1 ANTHROPIC_API_KEY=sk-... ./spikes/S-01/run-spike.sh  # non-interactive
```

One container is created and removed on exit; the throwaway workspace is
cleaned via the same uid-1000 trick the substrate's smoke test uses. Raw
output lands in `spikes/S-01/raw/run-<stamp>/` — **gitignored, never commit**
(it can embed real session ids and account UUIDs).

## Sanitize and publish fixtures

```bash
./spikes/S-01/sanitize.sh spikes/S-01/raw/run-<stamp>
```

Hard-fails if key material (`sk-ant…`) is present anywhere. Replaces session
ids with `S01-SESSION-A/B/…` (chain-preserving), UUIDs with `S01-UUID-n`,
drops `cwd`/`apiKeySource`. Then **review the sanitized directory manually**
(the scrubber is best-effort; R-09 discipline applies) and copy the reviewed
files into `docs/spikes/S-01/fixtures/` in a PR.

## After execution

Write `docs/spikes/S-01/RESULTS.md` answering i–v with numbers, citing
fixture files. Template:

```markdown
# S-01 Results

Run: <stamp> · Image: shared-terminal-session @ 36be2f2 · CLI: <version>

| Question | Verdict | Evidence |
| --- | --- | --- |
| i — freeze without flags | frozen after `tool_use` / auto-denied / completed | p1-freeze/... |
| ii — resume latency | first-event p50 = X ms; total = Y ms (n=3) | p3-resume-*/meta.json |
| iii — cancellation | outcome=<terminated/killed>, sleeper died: yes/no, post-kill events: … | p4-cancel/... |
| iv — result fields | cost field name = …, session_id per turn: stable/forks | p2/p3 result events |
| v — tool_use shape | command at .input.command, file at .input.file_path, … | p5-toolshape/tool-use-extract.json |
| + onboarding | bare run worked / needed seed | p0-onboarding/... |
| + zombies | count before/after kills: … | zombies-*.txt |

Consequences: (update Q-01/Q-08/R-03 status; unblock ADR candidate for the
runner; feed the allowlist draft for doc 08.)
```

## Known risks of the probe itself

- CLI flag surface (`--allowedTools` syntax, result field names) is asserted
  empirically, not assumed — if 2.1.207 differs from what the prompts expect,
  that divergence **is a finding**; record it, don't patch it away.
- P0 may reveal that fresh headless runs hit onboarding/trust gates; the
  script seeds a fallback and records that the seed was needed — that fact
  directly shapes the Hub runner's session-bootstrap requirements.
