# ADR-006 — The workspace belongs to the project, not the agent

Status: accepted (owner direction 2026-07-16)
Date: 2026-07-16

## Context

[ADR-005](./ADR-005-project-aggregate.md) made `Project` the aggregate that
owns the substrate session, and [18 §2](../18-agent-collaboration-model.md)
states the model plainly: **two dimensions, one composition** — the role is a
stateless template, *"the project is the stateful context: **workspace** and
instructions today"*, and a "project agent" is the `(project, agent)` pair,
not a third entity. `agents.example.yaml` says the same: agents are
*"stateless, reusable across projects"*.

The implementation does not match. `Orchestrator.provision()` creates the
session from **`agent.sessionTemplateId`** — the *agent's* template. The
project's workspace is therefore determined by whichever agent happens to be
its default. The spec puts the workspace on the project; the code derives it
from the role.

This has not bitten yet only because no project has a repo: every Hub project
is an empty workspace, so "whose template" never mattered. It bites the
moment the owner's actual use case arrives — *"ask QA-AGENT to review the
last PR of Agent Hub; ask DEV-Agent to fix a bug in Home-Automation"* — which
needs one role across many repos, and many roles on one repo. With the
workspace hanging off the agent, both projects a DEV-Agent touches would
clone whatever DEV's template says.

A second, quieter mismatch rides along: `agentSeed` (which carries the
agent's instructions as the workspace's CLAUDE.md) is written **once, at
provisioning, from the project's `defaultAgentId`**. Conversations may each
bind a different agent (`Conversation.agentId`), so a QA conversation in a
project provisioned for DEV runs in a workspace seeded with DEV's
instructions. Tools are already per-turn (`--allowedTools` from the run's
policy snapshot) and correct; instructions are not.

## Decision

**The project owns its workspace specification; the agent owns only the
role.**

| Concept | Owns | Does not own |
| --- | --- | --- |
| `Agent` (role) | instructions, `allowedTools`, caps, runtime binding | any workspace, repo, session, or template |
| `Project` (context) | `sessionTemplateId`, `repo`, the session binding, project instructions | the role's craft |

Concretely:

- `sessionTemplateId` **moves from `Agent` to `Project`**.
- `Project` gains a **`repo`** specification, passed to the seam's session
  config at provisioning.
- Provisioning reads the workspace from the project, never from the agent.

This is not new architecture — it is the code catching up to 18 §2. No new
entity appears; one field moves and one is added.

## Consequences

**Enables the owner's stated model.** One `DEV-Agent` across
plataforma-educativa and shared-terminal; QA and DEV conversations against
the same repo. Both fall out of `(project, agent)` composition once the axes
stop being conflated.

**The Hub gains a credential that can write to the owner's repositories** —
a new risk class for [10](../10-security-threat-model.md), which until now
covered a substrate JWT, an Anthropic OAuth token, and an R2 token, none of
which can touch source. **Owner decision (2026-07-16): a fine-grained PAT,
one per repo** — chosen over per-repo SSH deploy keys and over a single
global PAT. Rationale: least privilege, individually revocable, and a leak of
one credential cannot reach the other repositories. Accepted cost: more
friction when adding a project. The seam already stores repo auth encrypted
in D1 — `encryptAuthCredentials` (`sessionConfig.ts:1138`), verified at
shared-terminal `main @ c35b6da`, whose own note states the intent: *"the
whole point of `auth_json` / `encryptAuthCredentials` is that secrets never
land in plaintext anywhere on disk"* — so the Hub holds no plaintext at rest.

**Interactive credential flows stay impossible, and that is now explicit.**
The runner is per-turn (ADR-003): a `gh auth login` device flow needs its
process alive while the owner visits the browser, but the exec ends with the
turn and the FR-21 sweep exists to kill exactly such survivors. Observed in
production: the device code was emitted, the turn ended, the background task
was reported `stopped`. **Credentials are provisioned, never authenticated
from inside a turn.** This ADR is what makes that a design rule rather than a
recurring surprise.

**Per-turn role instructions become necessary, not optional.** Once a project
is a real repo that several roles work on, baking one agent's instructions
into the workspace at provisioning is wrong: the QA conversation would run
under DEV's CLAUDE.md. The instructions must travel with the turn, as tools
already do. The mechanism (`--append-system-prompt` or equivalent) is
**unverified against CLI 2.1.207** and is deliberately left to its own
implementation item rather than asserted here.

**Existing projects keep working.** A project with no `repo` provisions an
empty workspace exactly as today; `sessionTemplateId` moving is a migration
of one column, and Phase-1 projects can carry the agent's template as their
own default at migration time.

## Options considered

**Do nothing — leave the workspace on the agent (rejected).** Costs nothing
today and contradicts 18 §2 permanently. The first repo turns "which agent's
template?" into a question with no good answer, and the fix then carries a
data migration plus an API break instead of a field move.

**Templates per (agent, project) pair (rejected).** Preserves both axes by
multiplying entities — precisely what 18 §2 rejects. The pair is already
expressible; it needs no storage of its own.

**Keep provisioning agent-driven, add `repo` to the agent (rejected).** Makes
the conflation worse: a role would then carry a repository, which is the
opposite of a stateless, reusable template, and one DEV-Agent could serve
exactly one repo.
