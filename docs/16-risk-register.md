# 16 — Risk Register

**Status:** draft — review · **Last updated:** 2026-07-13

Inherited from the discovery register (2026-07-12, written against substrate
`7a551f0`, before the separate-repos decision) and updated against `36be2f2`
after the hardening batch. The threat model (doc 10) will supersede security
rows with asset/attacker/vector detail; this register tracks decision-level
risk. `P`robability / `I`mpact: L/M/H. **Phase** = where the mitigation must land.

| ID | Risk | Status | P | I | Mitigation | Residual | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R-01 | Conversation continuity broken by container recreate | **CLOSED upstream** (#371/#378) | — | — | Substrate symlinks `~/.claude` and `~/.claude.json` into `workspace/.st/`; CI smoke test re-asserts per CLI bump | Plaintext transcripts/credentials on host survive soft delete → threat model (doc 10) | — |
| R-02 | Runner contract drift: stream-json schema/flags change across CLI versions; effective version floats per workspace via persisted self-updates in `.npm-global` | MITIGATED (pin 2.1.207) | M | H | Runner records CLI version per run; contract tests against recorded fixtures; fake runtime keeps CI independent | New CLI versions need fixture refresh; workspace drift detectable but not preventable | 1 |
| R-03 | Headless run freezes forever on first tool permission prompt when no permission flags are passed | **OPEN** → S-01 confirms | H (if unhandled) | M | Runner always passes the curated allowlist (Q-02, resolved 2026-07-14); per-run wall-clock timeout as backstop | — | 1 |
| R-04 | Cancellation doesn't cancel / leaves strays | **CLOSED upstream** (#373/#375) | — | — | `streamExec({newProcessGroup})` + `killExecProcessGroup` (TERM→poll→KILL, race-free pgid); smoke-test Phase 6 | Zombies vs `PidsLimit: 1024` (Q-08); daemon children that leave the process group | — |
| R-05 | Prompt injection → tool misuse in unattended headless runs (repo/web content steers the agent; nobody is watching) | OPEN | M | H | Curated allowlist default (Q-02, resolved); secrets kept out of prompts; audit trail (events + activity) from day 1; autonomy levels + approvals in later phases | Container has open egress; workspace may hold PATs/.env → sandbox is **not** an exfil boundary. Restate in doc 10 | 1→3 |
| R-06 | Runaway consumption: loops/huge contexts burn tokens unattended | OPEN | M | M | Per-run caps from day 1: `--max-turns`, budget cap, wall-clock timeout; `UsageRecord` per run (Phase 1, adjustment A3) | Caps are per-run; cross-run budgets arrive with Phase 3-4 | 1 |
| R-07 | Secrets leak into persisted run events / logs (tool output echoes env or file contents into the Hub's DB) | OPEN | M | H | Classify event payload sensitivity before persisting; scrub known secret values; never log payloads by default | Best-effort scrubbing can't catch derived/encoded secrets | 1 |
| R-08 | Seam dependency: the exec API must land in the *other* repo; its review cycle can stall Hub progress | NEW | M | M | Increment 1 runs entirely on a fake substrate adapter (adjustment A1); contract proposed early (PR-2) so upstream review overlaps Hub doc work | Real-integration increment (2) still gated on upstream merge | 1 |
| R-09 | Public-repo information leak: keys, deployment identifiers, session IDs, real conversation content in docs/fixtures | NEW | M | H | `.gitignore` from PR-0 (env, raw fixtures, `_inputs/`); fixture sanitization step (PR-4); GitHub secret scanning + push protection verified enabled; review bot checks hygiene explicitly | Human error on values scanners don't recognize (domains, IDs) | all |
| R-10 | Over-architecture (event sourcing, vector DBs, node protocols before need) | carried | M | M | Quality gates require each new infra piece to cite a failing constraint; every ADR must list the "do nothing" option | — | all |
| R-11 | Workspace races: agent run vs human typing in the same session, or two conversations bound to one session | carried | M | M | Serialize runs per session (Q-03 queue); surface "agent working" in the terminal-adjacent UI; document the manual-intervention contract | Human-vs-agent races remain possible by design (shared workspace is a feature) | 1 |
| R-12 | `RuntimeAdapter` contract shaped around Claude CLI quirks, blocking Ollama/HTTP/node runtimes later | carried | M | M | Fake adapter is the second implementation from day 1 (A1); contract reviewed against a hypothetical HTTP runtime before freeze | — | 1-2 |
| R-13 | Single-replica assumptions leak into Hub contracts, blocking Agent Nodes (Phase 5) | carried | L | M | Contracts written replica-agnostic (ids + resumable event streams); implementations may stay process-local | — | 2-5 |
| R-14 | D1 round-trip latency/cost on chat-shaped write volume (revived by ADR-002's D1 decision) | **revived** → S-03 measures | M | M | Batch event writes per turn (no per-delta rows); query-count budget per endpoint; S-03 numbers gate ADR-002 acceptance, with agreed revert-to-SQLite criteria | RTT floor on every turn commit remains | 1 |
| R-15 | D1 non-transactionality → inconsistent run state on crash between writes (revived by ADR-002) | **revived** | M | M | Atomic `UPDATE … WHERE` + affected-rows check; idempotent event ingestion; reconcile-on-boot mirroring `DockerManager.reconcile()` | Small windows remain; reconciliation heals | 1 |

## Dropped from the discovery register (with cause)

| Old ID | Was | Why dropped |
| --- | --- | --- |
| old R-08 / R-14 | D1 cost/latency blowup; D1 non-transactionality → inconsistent run state | Dropped 2026-07-13 as premised on sharing the substrate's D1. **Revived 2026-07-14 as R-14/R-15 above**: ADR-002 chose a Hub-owned D1, so both apply to the Hub's own database; S-03 runs before the ADR closes |
| old R-09 | Frontend scope explosion in vanilla TS | Premised on living inside shared-terminal and its no-framework rule. New repo = greenfield frontend decision (Q-06) |
| old R-15 | Claude auth model mismatch | Not a risk to *track* but a decision to *make* — moved to Q-10 |
| old S-02 | `~/.claude` persistence spike | Resolved upstream (#371/#378); its findings are now substrate CI invariants |

## ID mapping (discovery → this register)

R-01→R-01 (closed) · R-02→R-02 · R-03→R-03 · R-04→R-04 (closed) · R-05→R-05 ·
R-06→R-06 · R-07→R-07 · R-10→R-11 · R-11→R-12 · R-12→R-13 · R-13→R-10 ·
R-08/R-09/R-14/R-15→dropped (table above). R-08/R-09 here are new.
