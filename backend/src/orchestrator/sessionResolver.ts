/**
 * SessionResolver (ADR-013): decides WHERE a run executes — and only that.
 * Project/direct/step-run structural resolution, the automatic-mode router →
 * deterministic selector pipeline (ADR-008), the ADR-015 dev-seat precedence,
 * and the ADR-014 envelope decision (start vs steer). It returns a SIGNAL —
 * a resolved session, a fail, or a task-shaped outcome — and never acts on
 * it: the facade routes task signals to the TaskCoordinator and seals fail
 * signals through the run loop's finalize (ADR-013).
 *
 * Testable with a fake router + store, asserting the ADR-008 decision
 * persisted on the run without executing a turn.
 */

import { NOOP_LOGGER, type Logger, type RouterPort, type SubstrateExecPort } from '../domain/ports.js';
import { isTerminalTask } from '../domain/taskStateMachine.js';
import type {
  Agent,
  Conversation,
  ExecutionTargetDecision,
  RouteProposal,
  Run,
  SpecialistSessionBinding,
  Task,
} from '../domain/types.js';
import type { HubStore } from '../store/types.js';
import { NoExecutionTargetError, selectExecutionTarget } from './selector.js';

/**
 * The resolver's verdict for one run. `session` executes a turn; `fail` is
 * sealed by the caller as `exec_refused` (the resolver's own vocabulary — an
 * unexpected seam throw propagates instead and is classified by the caller);
 * the two task-shaped signals (ADR-014, I-14) are routed to the
 * TaskCoordinator by the facade.
 */
export type ResolvedRunTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'fail'; detail: string }
  | { kind: 'start-task'; devSpecialistId: string; qaSpecialistId: string }
  | { kind: 'steer-task'; task: Task }
  /** the message was authored while `task` was live but dispatched after it
   *  went terminal (#150) — sealed with a note, never re-routed as new work */
  | { kind: 'stale-steer'; task: Task };

export interface SessionResolverDeps {
  store: HubStore;
  /** session lookup/start on use (N3b-2) — never a turn */
  execPort: SubstrateExecPort;
  agents: ReadonlyMap<string, Agent>;
  router: RouterPort;
  /** The task envelope's QA reviewer; null disables the envelope entirely. */
  qaSpecialistId: string | null;
  logger?: Logger;
}

export class SessionResolver {
  private readonly store: HubStore;
  private readonly execPort: SubstrateExecPort;
  private readonly agents: ReadonlyMap<string, Agent>;
  private readonly router: RouterPort;
  private readonly qaSpecialistId: string | null;
  private readonly logger: Logger;

  constructor(deps: SessionResolverDeps) {
    this.store = deps.store;
    this.execPort = deps.execPort;
    this.agents = deps.agents;
    this.router = deps.router;
    this.qaSpecialistId = deps.qaSpecialistId;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /**
   * The session a conversation's runs use, looked up (never started) plus its
   * cached state — for kill/reconcile/error-context. Project conversation →
   * the project's binding; direct specialist conversation → the specialist's
   * (N3b-2). See `resolve` for the execution path that also starts it.
   */
  sessionMetaForConversation(c: Conversation): {
    sessionId: string | null;
    lastKnownState: string | null;
  } {
    if (c.projectId !== null) {
      const b = this.store.getProject(c.projectId)?.sessionBinding;
      return { sessionId: b?.sessionId ?? null, lastKnownState: b?.lastKnownState ?? null };
    }
    const b = this.store.getSpecialistSession(c.agentId);
    return { sessionId: b?.sessionId ?? null, lastKnownState: b?.lastKnownState ?? null };
  }

  async resolve(
    run: Run,
    conversation: Conversation,
    userMessageContent: string,
  ): Promise<ResolvedRunTarget> {
    const fail = (detail: string): ResolvedRunTarget => ({ kind: 'fail', detail });

    // A task step run (N5b, ADR-009/010 A): the supervisor already chose the
    // specialist, and the step runs in its project's primary session — never
    // re-routed. Structural, so no selector and no recorded target decision.
    if (run.taskStepId !== null) {
      const sessionId =
        conversation.projectId !== null
          ? this.store.getProject(conversation.projectId)?.sessionBinding.sessionId ?? null
          : null;
      return sessionId !== null
        ? { kind: 'session', sessionId }
        : fail('task step run has no project session (ADR-010 A)');
    }

    // Automatic mode (N4a, ADR-008): the router proposes a specialist and the
    // deterministic selector chooses the session, recorded on the run. Direct
    // mode derives the session structurally, with no selector in the loop.
    if (conversation.mode === 'automatic') {
      return this.resolveAutomatic(run, conversation, userMessageContent);
    }

    if (conversation.projectId !== null) {
      const sessionId = this.store.getProject(conversation.projectId)?.sessionBinding.sessionId ?? null;
      return sessionId !== null
        ? { kind: 'session', sessionId }
        : fail('project has no substrate session (FR-33)');
    }

    // direct specialist conversation
    const binding = this.store.getSpecialistSession(conversation.agentId);
    if (!binding) return fail(`specialist ${conversation.agentId} has no session bound (N3b-1)`);
    return this.ensureSpecialistSessionRunnable(binding);
  }

  /**
   * Automatic-mode session resolution (N4a, ADR-008 Option 3). The router only
   * PROPOSES a specialist; the deterministic selector chooses the session from
   * real bindings — never a model (01 §3, SEC-01). The decision persists on the
   * run before the turn executes, so the inspector shows who ran, where and why.
   * In N4a the router echoes the conversation's own specialist, so the choice is
   * structural; the message-aware router that can pick a different specialist is
   * N4b, behind the same port.
   */
  private async resolveAutomatic(
    run: Run,
    conversation: Conversation,
    userMessageContent: string,
  ): Promise<ResolvedRunTarget> {
    const fail = (detail: string): ResolvedRunTarget => ({ kind: 'fail', detail });
    const proposal = await this.router.route({
      message: userMessageContent,
      specialists: [...this.agents.values()],
      conversation: {
        id: conversation.id,
        projectId: conversation.projectId,
        agentId: conversation.agentId,
        mode: conversation.mode,
      },
    });

    // Envelope (N5b, ADR-009): a routed `task` in a project conversation is not
    // a single turn — it spawns a supervised developer → QA task. The kickoff
    // run executes no turn; the implementation and QA execute as their own step
    // runs the supervisor owns. Gated on a configured QA specialist and an
    // implementation-capable developer (#124) — a hub with neither just runs a
    // normal turn (the routed specialist answers).
    if (
      proposal.workType === 'task' &&
      conversation.projectId !== null &&
      this.qaSpecialistId !== null
    ) {
      // I-14 (ADR-014): a conversation has at most ONE active task. A
      // work-shaped message while one runs STEERS it — folded at the next
      // step boundary, or re-entering the loop from awaiting_human_approval —
      // never a sibling task. Questions fall through to a normal turn above
      // (workType 'question' never reaches this branch).
      const activeTask = this.store
        .listTasks({ sourceConversationId: conversation.id })
        .find((t) => !isTerminalTask(t.state));
      if (activeTask) return { kind: 'steer-task', task: activeTask };
      // Steer intent survives the queue (#150): a message AUTHORED while a
      // task was live can dispatch only after that task went terminal (it
      // queues behind the step run, I-2). Re-routing it here would spawn a
      // fresh task from a context-less fragment — observed live in the
      // 2026-07-28 acceptance. If the message was born inside a now-terminal
      // task's lifetime window, seal it as an informational envelope instead;
      // the owner resends if they still want it as new work. Window check via
      // ISO timestamps (createdAt ≤ msg ≤ updatedAt; a terminal task's
      // updatedAt is its terminal transition — approve's later PR-URL write
      // widens it by milliseconds, a benign overshoot).
      const message = this.store.getMessage(run.messageId);
      const staleTarget = message
        ? this.store
            .listTasks({ sourceConversationId: conversation.id })
            .filter(
              (t) =>
                isTerminalTask(t.state) &&
                t.createdAt <= message.createdAt &&
                t.updatedAt >= message.createdAt,
            )
            .at(-1)
        : undefined;
      if (staleTarget) return { kind: 'stale-steer', task: staleTarget };
      const devSpecialistId = this.resolveDevSpecialist(proposal, conversation);
      if (devSpecialistId !== null) {
        if (devSpecialistId !== proposal.specialistId) {
          // the router's contextual pick could not implement (#124 — the
          // architect-as-implementer loop); the audit trail is the step row
          this.logger.info('task.dev_rerouted', {
            runId: run.id,
            proposed: proposal.specialistId,
            devSpecialistId,
          });
        }
        return { kind: 'start-task', devSpecialistId, qaSpecialistId: this.qaSpecialistId };
      }
      // no implementation-capable specialist → fall through to a normal turn
    }

    const projectPrimarySessionId =
      conversation.projectId !== null
        ? this.store.getProject(conversation.projectId)?.sessionBinding.sessionId ?? null
        : null;
    const specialistBinding = this.store.getSpecialistSession(proposal.specialistId);

    let decision: ExecutionTargetDecision;
    try {
      decision = selectExecutionTarget({
        proposal,
        projectPrimarySessionId,
        specialistSessionId: specialistBinding?.sessionId ?? null,
      });
    } catch (err) {
      if (err instanceof NoExecutionTargetError) {
        return fail(
          `no execution target for specialist ${proposal.specialistId} (ADR-008): neither a project primary session nor a bound specialist session`,
        );
      }
      throw err;
    }

    this.store.recordRunTarget(run.id, decision.selectedSessionId, decision);

    // The selector chose the session; it must still be runnable. A project
    // primary session was already gated `ready` at send; a specialist session
    // may need starting on use — the same path a direct specialist run takes.
    if (decision.workspaceStrategy === 'specialist-session') {
      return this.ensureSpecialistSessionRunnable(specialistBinding!);
    }
    return { kind: 'session', sessionId: decision.selectedSessionId };
  }

  /**
   * Can this specialist take a task's IMPLEMENTATION step (#124)? Declared
   * capabilities must include `implementation`; a specialist that declares
   * none is unconstrained (backward-compatible — capabilities are optional in
   * AGENTS_CONFIG). This is what keeps a design-only role (the architect) out
   * of the dev seat, where the dev → QA loop can never converge.
   */
  private canImplement(agent: Agent): boolean {
    return agent.capabilities === undefined || agent.capabilities.includes('implementation');
  }

  /**
   * The developer for a task's implementation steps (ADR-015, #124): the
   * CONVERSATION'S OWN agent when it can implement — the entity that already
   * holds the context implements by default, no third-party fresh-context tax
   * — else the router's contextual pick when capable, else the first capable
   * specialist by stable id order. The QA specialist is never the developer
   * (the envelope's independence requirement). Null = nobody can implement;
   * the caller falls back to a normal turn rather than spawning a task doomed
   * to loop.
   */
  private resolveDevSpecialist(
    proposal: RouteProposal,
    conversation: Conversation,
  ): string | null {
    const eligible = (a: Agent | undefined): boolean =>
      a !== undefined && a.id !== this.qaSpecialistId && this.canImplement(a);
    const conversationOwn = this.agents.get(conversation.agentId);
    if (eligible(conversationOwn)) return conversationOwn!.id;
    const proposed = this.agents.get(proposal.specialistId);
    if (eligible(proposed)) return proposed!.id;
    const candidates = [...this.agents.values()]
      .filter((a) => eligible(a))
      .sort((a, b) => a.id.localeCompare(b.id));
    return candidates[0]?.id ?? null;
  }

  /**
   * Ensure a specialist's bound session is running, starting it on use (N3b-2,
   * owner decision — needs operate-tier start upstream, shared-terminal#429).
   * Returns the session, or a fail signal if it is gone upstream (FR-44) or
   * cannot be started. Shared by direct and automatic resolution.
   */
  private async ensureSpecialistSessionRunnable(
    binding: SpecialistSessionBinding,
  ): Promise<ResolvedRunTarget> {
    const info = await this.execPort.getSession(binding.sessionId);
    if (info === null) {
      this.store.setSpecialistSession({ ...binding, status: 'error', lastKnownState: null });
      return {
        kind: 'fail',
        detail: `specialist session ${binding.sessionId} no longer exists upstream (FR-44)`,
      };
    }
    if (info.status !== 'running') {
      // Until #429 ships an owner session 403s on start: report it honestly
      // rather than silently. Auto-starts once #429 lands.
      try {
        await this.execPort.startSession(binding.sessionId);
        this.store.setSpecialistSession({ ...binding, status: 'available', lastKnownState: 'running' });
      } catch {
        this.store.setSpecialistSession({ ...binding, status: 'offline', lastKnownState: info.status });
        return {
          kind: 'fail',
          detail: `specialist session is ${info.status} and could not be started from the Hub — start it in Shared Terminal (auto-start pending shared-terminal#429)`,
        };
      }
    }
    return { kind: 'session', sessionId: binding.sessionId };
  }
}
