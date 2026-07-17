# S-04 Results — `--append-system-prompt` on the pinned CLI

Run: 2026-07-17 · Image: shared-terminal session image (CLI **2.1.207**, the
pinned version — the probe asserts this rather than trusting the host, whose
CLI floats via self-update, doc 02 §102) · Model: `claude-sonnet-5` (the
image's default) · Package: [`spikes/S-04/probe.sh`](../../../spikes/S-04/probe.sh)

## What it settles

ADR-006 concluded that role instructions must travel **per turn** once several
roles share one project's workspace, and deliberately refused to assert the
mechanism: *"`--append-system-prompt` or equivalent is **unverified against CLI
2.1.207**"*. B5-04 was blocked on exactly that sentence. This is the evidence.

| # | Question | Verdict | Evidence |
| --- | --- | --- | --- |
| i | Does `--append-system-prompt` exist on 2.1.207? | **Yes** | `claude --help` matches the flag; `claude --version` → `2.1.207` |
| ii | Does the appended prompt actually **reach the model**, or is it parsed and dropped? | **It reaches the model** | A codeword injected only via the flag was echoed back; `exit=0`, result `subtype: success`, `is_error: false` |
| iii | Control — could the model produce the codeword **without** the flag? | **No** | Same prompt, same session, flag omitted: codeword absent |
| + | Is `--append-system-prompt-file` available as an escape hatch? | **Yes** | Present in `--help` on the same version |

Cost: ~US$0.06 per probe run (two turns).

## Method, and why the control is the load-bearing half

Inject a codeword the model **cannot otherwise know** through the flag, then ask
for it. A pass alone would prove only that the model can say a word; the control
run — same prompt, same session, no flag — is what makes the flag the *cause*.
Both halves ran, twice, with different codewords each time (a codeword reused
across runs could be answered from the resumed transcript rather than the flag).

Verified twice, independently: once ad hoc, then once more through the committed
`probe.sh` — a probe that has never been run as committed is not a probe.

## Consequences

- **B5-04 is unblocked**, and its shape is settled: the role travels per turn as
  `--append-system-prompt`, the project's own instructions stay in the workspace
  `CLAUDE.md`. Both facts are now pinned by tests
  ([`17-phase1-backlog.md`](../../17-phase1-backlog.md) B5-04).
- **ADR-006's open consequence closes.** The domain model's `instructions` row
  (doc 06 §2) no longer carries a "blocked pending B5-04" caveat.
- **Re-run this on a CLI bump** (R-02, doc 14 §Runbooks). The failure mode it
  guards is silent: a version that parses the flag and ignores it would run
  every conversation under no role at all, and no offline suite can see what the
  model was actually told — the tests would stay green while the product stopped
  working.
- **The instruction rides argv**, which shares the seam's 32 KiB command cap
  with the prompt (contracts tracking doc, Hub-side notes). The real port
  validates that cap, so an over-long role fails at the boundary with a clear
  error rather than mid-turn. `--append-system-prompt-file` is the escape hatch
  if roles ever outgrow it; it would cost a second exec to place the file.

## Known limits of this probe

- It answers "does the flag reach the model", not "does the model obey the role
  faithfully" — the latter is not a property a spike can pin.
- No fixtures are published under this spike. The raw stream-json carries real
  session ids (R-09) and the probe's value is the reproducible script, not a
  recorded stream; S-01's fixtures already cover stream-json shape.
