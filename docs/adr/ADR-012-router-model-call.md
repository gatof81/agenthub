# ADR-012 — The automatic-mode router calls the Messages API directly

Status: accepted (owner, 2026-07-19)
Date: 2026-07-19

## Context

N4a (ADR-008) landed the automatic-mode decision core: a `RouterPort` that
**proposes** a specialist for a turn, a deterministic execution-target selector
that chooses the session, and the `ExecutionTargetDecision` recorded on the run.
N4a shipped the *deterministic* router (`DeterministicRouter` — echoes the
conversation's own specialist, no model call) so the whole flow is offline and
testable. N4b makes the router **message-aware**: it must read the message and
the available specialists (identity + capabilities) and pick who should handle
the turn — a single model call per message (ADR-008 Consequences; doc 19 §8).

The Hub's model I/O today goes **only** through the `claude-cli` adapter over
the shared-terminal exec seam (ADR-001, ADR-003), authenticated with the Claude
OAuth token that rides each run's exec env (`CLAUDE_CODE_OAUTH_TOKEN`,
`config/runtime.ts`). There is no direct Anthropic SDK dependency. So "how does
the router call the model?" is a real architectural fork.

## Options

1. **Route via the seam (a `claude -p` one-shot).** Consistent with ADR-001
   (all model I/O through the seam) and reuses the adapter. Rejected:
   - **Chicken-and-egg.** Running the CLI needs a substrate session to exec on,
     but choosing the session is *exactly* what routing feeds into (the selector
     runs on the router's proposal). Routing must be session-independent.
   - **Cost/latency.** A CLI cold start per message (seconds) for what is a
     lightweight classification, and it would consume the workspace's single
     active-run lock (I-2) for a meta-decision that isn't a run.
2. **Direct Messages API call.** The router makes one cheap
   `POST /v1/messages` call to a small model (Haiku 4.5) with structured output,
   authenticated with the **existing** `CLAUDE_CODE_OAUTH_TOKEN` (OAuth bearer +
   `anthropic-beta: oauth-2025-04-20`) — no new credential. Fast (sub-second),
   session-independent, structured. Departs from ADR-001's "all model I/O via
   the seam".

## Decision

Option 2.

- The **model router** (`ModelRouter`, real mode) calls the Anthropic Messages
  API directly via `@anthropic-ai/sdk`, model `claude-haiku-4-5`. It gets a
  structured proposal (`{workType, specialistId, reason}`; `capabilities` are
  grounded from the chosen specialist's config, not the model) via a **forced
  tool call** (`tool_choice` on a `route` tool) — fully typed in the SDK, stable,
  and needs no beta header (chosen over `output_config`, which is untyped in the
  pinned SDK and would silently fall back on every turn if unsupported). It
  authenticates with the OAuth token already resolved for `real` mode — reused,
  not a new secret.
- **This is a deliberate, narrow carve-out from ADR-001.** ADR-001 governs
  *agent execution* — running a Claude turn in a workspace — which stays entirely
  on the seam. The router is a **control-plane meta-decision** (which specialist,
  is this a question or a task), session-independent, that never touches a
  workspace or runs a tool. Only that decision is exempt. Everything ADR-001
  covers is unchanged.
- **The router only PROPOSES (ADR-008 unchanged).** Its output is validated
  against the real specialist set and the deterministic selector still owns the
  session choice; the backend disposes. A model never chooses the execution
  environment (01 §3, SEC-01).
- **Graceful degradation is load-bearing.** On any router failure — model error,
  timeout, or a proposal naming an unknown specialist — the `ModelRouter` falls
  back to the N4a `DeterministicRouter` (the conversation's own specialist).
  Automatic mode therefore never breaks a turn; worst case it routes as N4a did.
- **Offline discipline preserved (13 §6).** `RouterPort` keeps its
  `DeterministicRouter` fake; the offline suite runs only that (no network, no
  credentials). `ModelRouter` is instantiated **only** in `real` mode
  (`config/runtime.ts` wiring), exactly like the real seam client and adapter,
  so CI's no-`CLAUDE*`-env assertion still holds.

## Consequences

- New dependency: `@anthropic-ai/sdk` in the backend. It is imported only by
  `ModelRouter`; the module-boundary rules are unaffected (external dep, not a
  cross-module edge).
- **The OAuth token gains a second consumer.** It already rides every run's exec
  env for the CLI; N4b also sends it to `api.anthropic.com` on the Bearer header
  for the router call. No-payload-logging (SEC-04/05) and token-hygiene rules
  apply unchanged — the token is never logged, and the user message the router
  sees is payload, never logged.
- **Credential-fit risk (accepted, mitigated).** `CLAUDE_CODE_OAUTH_TOKEN` is a
  Claude Code subscription token; whether it authorizes the raw Messages API is
  verified only in `real` mode on the deployment host, not offline. The
  deterministic fallback bounds the blast radius: if the token is rejected,
  automatic mode degrades to N4a deterministic routing rather than failing —
  observable (the recorded reason says "fallback"), never a broken turn. A
  dedicated router credential is recorded as the future narrowing if needed.
- **Cost/latency** of one Haiku call per automatic-mode message. Bounded by the
  same caps machinery in spirit and avoidable via `direct` mode; Haiku keeps it
  cheap and sub-second. Direct mode interposes no model call.
- ADR-008's "default `automatic` once N4b lands" takes effect here; ADR-001's
  Status records this single control-plane carve-out (amended 2026-07-19).
