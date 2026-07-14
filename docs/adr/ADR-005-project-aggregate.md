# ADR-005 — Project as the organizing aggregate

Status: accepted (owner direction 2026-07-14, incorporation plan approved in review conversation)
Date: 2026-07-14

## Context

The owner's working intuition is project-shaped ("I'm going to work on
Educación Hz"), never agent-shaped ("I want to talk to agent X"). The
pre-pivot model made `Conversation` the top-level unit, each owning its own
substrate session — which meant **one Docker container per conversation**.
With the substrate's per-session caps now enforced (4 cores / 8 GiB,
shared-terminal #388), three conversations about the same codebase would cost
three containers, three clones, and three times the RAM, while *semantically*
they all belong to one workspace.

This lands during the specification phase: the change costs one focused docs
PR now, or a data migration plus API break later.

## Options

### Do nothing — conversation-centric (rejected)

Keeps the docs as they are. Fails the owner's stated mental model, and the
container economics worsen linearly with conversations per topic. Rejected
on both counts.

### Project as a label (rejected)

A `project` tag on conversations groups the UI without touching session
ownership. Cheap, but it changes nothing real: still one container per
conversation, still no shared workspace, and the tag inevitably grows into
the aggregate anyway — with a migration in between. Half a decision.

### Project as the aggregate root (chosen)

`Project` owns the substrate session (the workspace) and the conversations.
Minimal Phase-1 shape:

```text
Project { id, name, status, sessionBinding, defaultAgentId, instructions?, createdAt }
```

- Conversations belong to exactly one project and **inherit its session**;
  the CLI's own multi-session transcripts keep per-conversation continuity
  (`runtimeSessionId` stays on `Conversation` — many CLI sessions share one
  workspace under `.st/claude-state`, a substrate-verified property).
- One container per *project*; run serialization (FR-19) was already
  session-scoped, so "one active run per project" falls out unchanged.
- `defaultAgentId` seeds new conversations; per-conversation agent override
  remains possible (Phase-2 registry makes it real).

### Project as everything (rejected scope)

The owner's full list — project memory, document libraries, multiple
repos/workspaces, multiple terminals, per-project permissions — is Phase-2+
material. Attaching it now is textbook over-architecture (R-10): each item
gets built when a phase needs it, on top of this aggregate. The deferred
list is recorded here precisely so it doesn't leak in silently (risk R-17).

## Decision

Adopt **Project as the aggregate root** with the minimal Phase-1 shape.
Accepted trade-off: two conversations of the same project cannot run
concurrently (they share the workspace). For a single user this is the
*correct* semantics — R-11's workspace-race risk becomes designed behavior —
and Q-11 records it as revisitable if it ever hurts.

## Consequences

- Domain (06): `Project` aggregate added; `Conversation` re-parented
  (`projectId` immutable, I-10); `SessionBinding` moves to `Project`; I-2
  becomes per-project serialization.
- Contracts (08): `/api/projects` routes; conversations created within a
  project.
- Persistence (09): `projects` table; `conversations` re-parented; provisioning
  state machine moves to the project.
- UX: the primary navigation unit is the project (doc 11 input).
- Container economics: N conversations per topic → 1 container.
- Deferred explicitly (Phase 2+): project memory, documents, multi-repo,
  multi-terminal, per-project permission overrides, per-conversation runtime
  overrides.
- New risk R-17 (aggregate scope creep) guards the deferred list.
