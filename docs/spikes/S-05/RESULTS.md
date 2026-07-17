# S-05 Results — does a seeded `settings.json` widen a turn's tools?

Run: 2026-07-17 · Image: shared-terminal session image (CLI **2.1.207**, the
pinned version — the probe asserts this rather than trusting the host, whose
CLI floats via self-update, doc 02 §4 constraint 6) · Model: `claude-sonnet-5`
(the image's default) · Package:
[`spikes/S-05/probe.sh`](../../../spikes/S-05/probe.sh)

## What it settles

Provisioning seeded `settings: { allowedTools: agent.allowedTools }` into the
project's session — the same shape B5-04 removed for instructions: one role's
configuration baked into a workspace every role shares (ADR-006). The seed was
redundant, since tools travel per turn as `--allowedTools` (I-7). This probe
asked whether it was also **harmful**: does that file widen a turn's tools past
the flag? If so, SEC-02/I-7 were a fiction on any project a broad role
provisioned.

The seed lands in the CLI's **user-level** settings: `~/.claude` is a symlink to
`workspace/.st/claude-state`, so the seeded file is the widest-scoped settings
file the CLI reads — not a project-local one.

| Arm | `--allowedTools` | `settings.json` | Bash ran? |
| --- | --- | --- | --- |
| A — positive control | `Read Bash` | `{}` | **yes** — the ask works |
| B — baseline | `Read` | `{}` | no — the flag denies |
| C — **the shape the Hub seeded** | `Read` | `{"allowedTools":["Bash"]}` | **no** |
| D — the CLI's documented shape | `Read` | `{"permissions":{"allow":["Bash"]}}` | **yes** |

Both control arms held, so C and D mean something. Run twice with independent
run ids; identical both times. Cost: ~US$0.12 per probe run (four turns).

**Verdict: the seed was inert — by luck, not by design.**

- **D is the finding.** A settings file *does* grant tools past
  `--allowedTools`. The escalation path is real and live on 2.1.207.
- **C is why it never fired.** The Hub wrote the key `allowedTools`; the
  documented key is `permissions.allow`, and 2.1.207 ignores the former.
  Writing the wrong key is the only thing that stood between a QA turn and
  DEV's tools.
- Tool enforcement therefore rests entirely on `--allowedTools` — the flag, not
  the seed. SEC-02/I-7 hold, and now hold *by construction*.

## Method, and why the controls are the load-bearing half

Deny a tool at the flag, grant it in settings, ask for an effect only that tool
can produce. The observable is a marker file — unambiguous in a way that
grepping a permission-denial out of stream-json is not.

Arm A exists because "no marker" is otherwise unreadable: it cannot distinguish
"settings did not widen" from "the model never tried". Arm B exists because
without it, a marker in C or D would not prove the flag had denied anything.
Arm D exists because a null result on C alone cannot separate "settings never
widen" from "we wrote a key this version ignores" — and those two findings have
opposite consequences. Each arm ran on a fresh transcript (no `--resume`): an
earlier arm's refusal would otherwise steer a later one.

## Consequences

- **The seed is gone, and so is the field.** `SessionSeed` no longer has
  `settings` (not merely unused — removed), so re-seeding is a port change with
  a spike behind it rather than a one-line regression. Pinned by tests in the
  orchestrator spine and the real-port conformance suite.
- **Provisioning no longer takes the `Agent` at all.** With the allowlist seed
  gone, nothing about the workspace was the role's — the fullest expression of
  ADR-006. The agent id is still validated at create time, where it is
  knowable; it just never reaches the seam.
- **Deployment-wide settings keep a home.** The workspace **template** carries
  its own `agentSeed`, which the seam preserves when the Hub's seed omits the
  field. That is the right layer: the template is the project's (FR-45), so
  nothing there wears an agent's identity.
- **Existing workspaces were remediated** (2026-07-17). The agentSeed runs at
  create time only, so removing the code did not clean sessions already
  provisioned. Inert today is not inert forever: a CLI bump that honors the
  key, or someone "fixing" it to `permissions.allow`, would arm them
  retroactively. Of the four live session containers, exactly **one** carried
  the seed — its settings file was nothing but the Hub's `allowedTools` key,
  now stripped (leaving `{}`, backup alongside). The other three held only the
  owner's own settings (`model`, `theme`, and in one case a real
  `permissions.allow` allowing four `npm` commands) and were left untouched.
  Worth recording as method, not trivia: the containers were **read before
  they were written**. A blanket `rm settings.json`, or a scripted strip across
  all sessions, would have destroyed live owner configuration to remediate a
  key only one of them had.
- **Re-run this on a CLI bump** (R-02, doc 14 §Runbooks), alongside S-01 and
  S-04. Arm D is the watch item: if a future version widens through a key the
  Hub or a template writes, tool enforcement stops being the flag's alone.

## Known limits of this probe

- It answers "can settings widen past the flag", not "which keys widen" — arm D
  establishes that `permissions.allow` does, and arm C that `allowedTools` does
  not, on this version. Other keys are unexplored.
- It probes granting, not denying: whether a settings `permissions.deny` can
  *narrow* a turn below its flag is a separate question, and not one the Hub
  currently depends on.
- No fixtures are published under this spike. The raw stream-json carries real
  session ids (R-09) and the probe's value is the reproducible script, not a
  recorded stream.
