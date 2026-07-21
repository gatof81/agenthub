# Specialist logs — in-repo memory for stateless roles

A specialist (ADR-008/N3b-1) is a **stateless role**: it starts cold in a project
session with no memory of prior turns, and — by design (18 §2 knowledge
isolation) — its accumulated craft is not smuggled into the role template. So the
durable, role-specific state a specialist needs across turns lives **here, in the
repo**: versioned, citable, and reviewable like every other spec artifact,
instead of in a per-session scratchpad that vanishes.

One file per role:

| Log | Role | Keeps |
| --- | --- | --- |
| [architecture.md](./architecture.md) | Enrique — Software Architect | reviews, design findings, doc/code divergences |
| [developer.md](./developer.md) | Claudio — Software Developer | implementation notes, non-obvious gotchas, discovered conventions |
| [qa.md](./qa.md) | Claudia — QA Specialist | known regressions, fragile/flaky areas, coverage gaps, verification approaches |

## Shared rules (every log)

- **Read your log on start** — after `docs/README.md` and `CLAUDE.md`, before you
  act — so you build on prior findings instead of re-deriving them.
- **Append, don't overwrite.** Add a dated entry when you learn something worth
  keeping. A finding that is later addressed is marked resolved with the closing
  PR/commit, **not deleted** — the trail is the value.
- **Cite evidence:** `file:line` for code, doc number + section or ADR id for
  specs (e.g. `doc 07 §2`, `ADR-009`, `FR-21`).
- **Descriptive, not normative.** These logs point at the source of truth; they
  never override it. **Decisions** belong in an ADR (`docs/adr/`); the numbered
  spec (`docs/01–19`) stays authoritative. A place where the docs and the code
  disagree is itself a finding — record it with both citations.
- **Honest.** State uncertainty and what you did not read. Never present a guess
  as a finding.

## Note on persistence

An append made inside a project session is a working-tree change there; it
becomes durable repo memory only when it flows back as a commit/PR (ADR-010
defines the code-sharing strategy ladder; the project session being the
authoritative source of truth for its workspace is its stated premise). Until
that lands, a finding lives only in that session. Keep entries small and PR them
promptly so the log stays the shared memory it is meant to be.
