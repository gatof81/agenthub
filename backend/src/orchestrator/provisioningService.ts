/**
 * ProvisioningService (ADR-013): project and specialist-session lifecycle that
 * never touches the run loop — session discovery (FR-48), project create/bind
 * and async provisioning (UC-01), specialist-session binding (N3b-1),
 * archive/restore (FR-30/43), and the provisioning half of boot reconciliation
 * (B3-02). Owns the in-flight provision promises as its own map (they were
 * `provision_*` entries in the facade's shared `inFlight`), exposed via
 * `pending()` so the facade's `idle()` still settles them.
 *
 * Testable against a fake `execPort` + `adapter.awaitReady` with no run-loop
 * machinery present.
 */

import {
  NOOP_LOGGER,
  NOOP_NOTIFIER,
  SessionGoneError,
  type HubNotifier,
  type Logger,
  type RuntimeAdapter,
  type SessionInfo,
  type SubstrateExecPort,
} from '../domain/ports.js';
import type {
  Agent,
  Conversation,
  Project,
  RepoAuth,
  RepoSpec,
  SessionOwnership,
  SpecialistSessionBinding,
  SpecialistSessionStatus,
} from '../domain/types.js';
import type { HubStore } from '../store/types.js';
import { mustAgent, OrchestratorError } from './errors.js';

/** Map a seam session state to a specialist-session status (N3b-1); `busy` is unused (I-2 is enforced by dispatch, not this status). */
function statusFromSeamState(state: string): SpecialistSessionStatus {
  return state === 'running' ? 'available' : 'offline';
}

export interface ProvisioningServiceDeps {
  store: HubStore;
  adapter: RuntimeAdapter;
  /** session lifecycle only (UC-01) — turns go through the adapter */
  execPort: SubstrateExecPort;
  agents: ReadonlyMap<string, Agent>;
  notify?: HubNotifier;
  logger?: Logger;
}

export class ProvisioningService {
  private readonly store: HubStore;
  private readonly adapter: RuntimeAdapter;
  private readonly execPort: SubstrateExecPort;
  private readonly agents: ReadonlyMap<string, Agent>;
  private readonly notify: HubNotifier;
  private readonly logger: Logger;

  /** In-flight provisioning/bind promises, keyed by project id (ADR-013: the `provision_*` half of the old shared map). */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(deps: ProvisioningServiceDeps) {
    this.store = deps.store;
    this.adapter = deps.adapter;
    this.execPort = deps.execPort;
    this.agents = deps.agents;
    this.notify = deps.notify ?? NOOP_NOTIFIER;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  /** The in-flight provisioning promises, for the facade's `idle()` (deterministic tests, clean shutdown). */
  pending(): Promise<void>[] {
    return [...this.inFlight.values()];
  }

  // — N1: session discovery (FR-48, ADR-007) —

  /**
   * The seam's listing joined with the Hub's project bindings, so the UI can
   * show which sessions a project already uses. Read-only pass-through
   * otherwise: the substrate stays the authority on session state (FR-33),
   * and archived projects keep their binding visible — a bound session is
   * bound, whatever the project's status.
   */
  async listSessions(): Promise<{
    scope: 'all' | 'own';
    sessions: Array<
      SessionInfo & {
        projectId: string | null;
        projectName: string | null;
        // The bound project's lifecycle owner (ADR-007), lifted onto the live
        // row so the UI can tell the Hub's own generic sessions
        // (`legacy-technical`) from the owner's; `null` when no Hub project
        // binds this session (an unbound session is nobody's project session).
        ownership: SessionOwnership | null;
      }
    >;
  }> {
    const listing = await this.execPort.listSessions();
    const bindings = new Map<string, { id: string; name: string; ownership: SessionOwnership }>();
    for (const p of this.store.listProjects({ includeArchived: true })) {
      const sessionId = p.sessionBinding.sessionId;
      if (sessionId !== null)
        bindings.set(sessionId, {
          id: p.id,
          name: p.name,
          ownership: p.sessionBinding.ownership,
        });
    }
    return {
      scope: listing.scope,
      sessions: listing.sessions.map((s) => {
        const bound = bindings.get(s.sessionId);
        return {
          ...s,
          projectId: bound?.id ?? null,
          projectName: bound?.name ?? null,
          ownership: bound?.ownership ?? null,
        };
      }),
    };
  }

  // — UC-01: create project + provision its substrate session —

  /**
   * Returns immediately with the `provisioning` project (the API's 202,
   * 08 §1); provisioning continues asynchronously and resolves to
   * ready | error (UC-01), observable via project.state / GET.
   */
  createProject(input: {
    name: string;
    defaultAgentId: string;
    /**
     * The project's workspace (ADR-006, FR-45) — never the agent's. `null`
     * only on the bind path: an existing session already IS the workspace.
     */
    sessionTemplateId: string | null;
    /**
     * Bind an existing owner-account session instead of creating one
     * (FR-49, ADR-007). Exactly one of this and `sessionTemplateId` — the
     * API validates; reaching here with both or neither is a logic error.
     */
    existingSessionId?: string | null;
    repo?: RepoSpec | null;
    /** provisioning-time credential; passed to the seam, never stored (FR-47, SEC-11) */
    repoAuth?: RepoAuth | null;
    instructions?: string | null;
  }): Project {
    // Validation only — provisioning itself no longer takes the agent (S-05):
    // nothing about the workspace is the role's (ADR-006). The call stays
    // because `defaultAgentId` must still name a real role at create time,
    // and this is where that is knowable.
    mustAgent(this.agents, input.defaultAgentId);
    const bindTo = input.existingSessionId ?? null;
    if ((bindTo === null) === (input.sessionTemplateId === null)) {
      throw new Error(
        'createProject: exactly one of sessionTemplateId and existingSessionId (FR-49)',
      );
    }
    const project = this.store.createProject({
      name: input.name,
      defaultAgentId: input.defaultAgentId,
      sessionTemplateId: input.sessionTemplateId,
      repo: input.repo ?? null,
      instructions: input.instructions ?? null,
    });
    const promise = (
      bindTo !== null
        ? this.bindExisting(project.id, bindTo)
        : this.provision(project, input.instructions ?? '', input.repoAuth ?? null)
    ).finally(() => {
      this.inFlight.delete(project.id);
    });
    this.inFlight.set(project.id, promise);
    return project;
  }

  /**
   * Bind an existing owner-account session (FR-49, ADR-007). Creates
   * NOTHING upstream: validates the session exists, records the binding
   * (`ownership: 'owner'` — the Hub is an execution identity there, never
   * the lifecycle authority), back-links the session via `external_ref`
   * (#418), and the project is usable. A stopped session binds fine — its
   * state is surfaced (FR-33), not judged.
   */
  private async bindExisting(projectId: string, sessionId: string): Promise<void> {
    try {
      const info = await this.execPort.getSession(sessionId);
      if (info === null) {
        // gone/unknown upstream: an error state to show, never a session to
        // conjure (FR-44's principle at bind time)
        throw new Error(`session ${sessionId} not found upstream`);
      }
      // Verify the runtime is actually usable before marking the project ready
      // (#112): the create path probes `command -v claude` (B3-08); a bound
      // session must too, or the Hub binds a session whose CLI is missing/broken
      // and only finds out at first-turn. Only meaningful while running — a
      // stopped session is probed when it is started on use (ensureRunnable).
      if (info.status === 'running') await this.adapter.awaitReady(sessionId);
      this.store.setProjectSession(projectId, {
        sessionId,
        lastKnownState: info.status,
        bindingMode: 'existing',
        ownerAccountId: info.ownerUsername,
        ownership: 'owner',
      });
      // Best-effort back-link: the Hub's binding row is the working truth;
      // the ref is the restore/reconciliation aid. A session whose owner
      // strips the ref stays bound — losing the aid must not break the bind.
      try {
        await this.execPort.setSessionExternalRef(sessionId, `agenthub:project:${projectId}`);
      } catch {
        this.logger.warn('project.bind_external_ref_failed', { projectId, sessionId });
      }
      this.store.updateProject(projectId, { status: 'ready' });
      this.notify.projectState(projectId, 'ready');
      this.logger.info('project.bound', { projectId, sessionId });
    } catch (err) {
      // The status change is observable via SSE/GET, but not the cause; log
      // it so the failing step is diagnosable, matching this method's own
      // success/inner-catch logging (and `project.restored` in restoreProject).
      // Includes the reason so a readiness failure (#112) reads as such, not a
      // bare status flip.
      this.logger.warn('project.bind_failed', {
        projectId,
        sessionId,
        reason: err instanceof Error ? err.message : 'unknown',
      });
      this.store.updateProject(projectId, { status: 'error' });
      this.notify.projectState(projectId, 'error');
    }
  }

  // — N3b-1: a specialist's optional personal session (ADR-008) —

  /**
   * Bind or create a specialist's personal session in the owner's account,
   * reusing the N2 machinery (ADR-007): exactly one of `sessionId` (bind an
   * existing owner session) or `sessionTemplateId` (create one on-behalf,
   * #420). The specialist is config (agents.yaml); only this binding is
   * state. Back-linked via `external_ref = agenthub:specialist:<id>`.
   * Synchronous end-to-end (unlike project provisioning's 202) — the caller
   * gets the final binding or a thrown error.
   */
  async bindSpecialistSession(
    specialistId: string,
    input: { sessionId?: string | null; sessionTemplateId?: string | null },
  ): Promise<SpecialistSessionBinding> {
    mustAgent(this.agents, specialistId); // must name a real specialist (config)
    const bindTo = input.sessionId ?? null;
    const template = input.sessionTemplateId ?? null;
    if ((bindTo === null) === (template === null)) {
      // API validates first (422); this is the defensive guard, like createProject
      throw new Error('bindSpecialistSession: exactly one of sessionId and sessionTemplateId');
    }
    const externalRef = `agenthub:specialist:${specialistId}`;

    if (bindTo !== null) {
      const info = await this.execPort.getSession(bindTo);
      if (info === null) {
        throw new OrchestratorError('session_gone', `session ${bindTo} not found upstream`);
      }
      // Same readiness check as create (#112, B3-08): a running session must
      // have the CLI usable before we bind it as the specialist's; the throw
      // surfaces at bind time instead of the specialist's first turn. A stopped
      // session is probed when it is started on use (ensureSpecialistSessionRunnable).
      if (info.status === 'running') await this.adapter.awaitReady(bindTo);
      try {
        await this.execPort.setSessionExternalRef(bindTo, externalRef);
      } catch {
        this.logger.warn('specialist.bind_external_ref_failed', { specialistId, sessionId: bindTo });
      }
      const binding = this.store.setSpecialistSession({
        specialistId,
        sessionId: bindTo,
        ownerAccountId: info.ownerUsername,
        ownership: 'owner',
        bindingMode: 'existing',
        lastKnownState: info.status,
        status: statusFromSeamState(info.status),
      });
      this.logger.info('specialist.session_bound', { specialistId, sessionId: bindTo });
      return binding;
    }

    // create-on-behalf: the personal session lands in the owner's account
    // (#420 when SEAM_OWNER_USER_ID is configured), else self-owned. No repo
    // and no instructions seed — the specialist's craft travels per turn
    // (B5-04); the template is its base workspace.
    const { sessionId, ownerUserId } = await this.execPort.createSession(template!, { externalRef });
    await this.adapter.awaitReady(sessionId);
    const onBehalf = ownerUserId !== null;
    const binding = this.store.setSpecialistSession({
      specialistId,
      sessionId,
      ownerAccountId: ownerUserId,
      ownership: onBehalf ? 'owner' : 'legacy-technical',
      bindingMode: 'created',
      lastKnownState: 'ready',
      status: 'available',
    });
    this.logger.info('specialist.session_created', { specialistId, sessionId });
    return binding;
  }

  private async provision(
    project: Project,
    instructions: string,
    repoAuth: RepoAuth | null,
  ): Promise<void> {
    const projectId = project.id;
    try {
      // The workspace comes from the PROJECT (ADR-006, FR-45). Reading it
      // from the agent — as this did — meant a role carried a repo, so one
      // DEV-Agent could serve exactly one repository.
      // `Project.sessionTemplateId` is nullable only for pre-ADR-006 rows that
      // never provisioned (migration 002 backfills the rest). Reaching here
      // with null is a logic error, so say so: the previous `?? ''` sent a
      // blank template to the seam and let it fail there, with nothing to
      // indicate the Hub had done it deliberately.
      if (!project.sessionTemplateId) {
        throw new OrchestratorError(
          'project_not_ready',
          `project ${projectId} declares no workspace template (ADR-006, FR-45)`,
        );
      }
      const { sessionId, ownerUserId } = await this.execPort.createSession(project.sessionTemplateId, {
        // No `settings` seed (S-05): this used to write the provisioning
        // agent's allowlist into the workspace, the same one-role-baked-into-a-
        // shared-workspace bug B5-04 fixed for instructions. Tools travel per
        // turn (`--allowedTools`, I-7); the seed added nothing but a way for a
        // future CLI version to grant DEV's tools to a QA turn. See the
        // `SessionSeed` port for what S-05 measured.
        //
        // The PROJECT's instructions, and only those (B5-04). The default
        // agent's craft used to be baked in here alongside them, which made
        // the workspace carry one role: every conversation in the project ran
        // under the provisioning agent's instructions, so a QA conversation
        // inherited DEV's. The role now travels per turn
        // (`TurnRequest.instructions`); what stays is what the whole project
        // shares.
        claudeMd: instructions,
        ...(project.repo ? { repo: project.repo } : {}),
        // Provisioned, never authenticated inside a turn (FR-46): the runner
        // is per-turn, so a device flow's process dies with the exec. The
        // credential goes to the seam here and is never persisted by us.
        ...(repoAuth ? { repoAuth } : {}),
        // session ↔ project back-link from birth (#418, N2)
        externalRef: `agenthub:project:${projectId}`,
      });
      // Bind BEFORE the readiness wait: from here on a session exists
      // upstream, and a project that fails the wait must still carry the id.
      // For a self-owned session that is what lets archiving stop it
      // (otherwise the container leaks); an owner-account session that fails
      // the wait stays in the owner's account, visible and theirs to remove —
      // the Hub never force-stops it (ADR-007), which is the honest tradeoff.
      // Created in the owner's account (N2, #420) when the seam reports an
      // owner id → treated exactly like a bound session (ADR-007): it is the
      // owner's, so archive/restore never stop or start it. Without an owner
      // id the Hub created it self-owned (`legacy-technical`), the pre-#420
      // behavior, and keeps lifecycle authority over it.
      const onBehalf = ownerUserId !== null;
      this.store.setProjectSession(projectId, {
        sessionId,
        templateId: project.sessionTemplateId,
        lastKnownState: 'provisioning',
        bindingMode: 'created',
        ownership: onBehalf ? 'owner' : 'legacy-technical',
        ownerAccountId: ownerUserId,
      });
      // A provisioned session is not yet a runnable one (B3-08): ask the
      // runtime, not the seam, whether it can actually take a turn.
      await this.adapter.awaitReady(sessionId);
      this.store.setProjectSession(projectId, { lastKnownState: 'ready' });
      this.store.updateProject(projectId, { status: 'ready' });
      this.notify.projectState(projectId, 'ready');
    } catch {
      this.store.updateProject(projectId, { status: 'error' });
      this.notify.projectState(projectId, 'error');
    }
  }

  /**
   * PATCH archive semantics (08 §1, FR-30) — scoped by ownership (ADR-007):
   * a `legacy-technical` session is the Hub's to stop; an `owner` session is
   * the owner's — archiving such a project is a Hub-side act ONLY, the
   * session keeps running for the owner's manual work. Never force-stop what
   * the Hub does not own.
   */
  async archiveProject(projectId: string): Promise<Project> {
    const project = this.store.getProject(projectId);
    if (!project) throw new OrchestratorError('not_found', `project ${projectId}`);
    if (
      project.sessionBinding.sessionId &&
      project.sessionBinding.ownership === 'legacy-technical'
    ) {
      try {
        await this.execPort.stopSession(project.sessionBinding.sessionId);
        this.store.setProjectSession(projectId, { lastKnownState: 'stopped' });
      } catch {
        // the substrate remains the authority on session state (06 §2)
      }
    }
    const updated = this.store.updateProject(projectId, { status: 'archived' });
    this.notify.projectState(projectId, 'archived');
    return updated;
  }

  /**
   * Restore an archived project (FR-43) — the inverse of archiving: restart
   * the session archiving stopped. The workspace is a host directory, so it
   * survived, and the CLI transcripts under it with it: the next turn
   * `--resume`s where it left off (FR-24).
   *
   * Unlike `archiveProject`, a seam failure is NOT swallowed. Archiving can
   * shrug at a session it cannot stop — the intent is satisfied either way.
   * Restoring cannot: a project marked `ready` whose session never came back
   * would fail its next turn instead of here, where the user can see why. A
   * `SessionGoneError` (FR-44) propagates for the API to map to
   * `409 session_gone`, and the project stays archived.
   */
  async restoreProject(projectId: string): Promise<Project> {
    const project = this.store.getProject(projectId);
    if (!project) throw new OrchestratorError('not_found', `project ${projectId}`);
    if (project.status !== 'archived') return project; // idempotent
    const sessionId = project.sessionBinding.sessionId;
    if (!sessionId) {
      throw new OrchestratorError(
        'session_gone',
        `project ${projectId} has no session to restore (FR-44)`,
      );
    }
    // Ownership scopes the restore too (ADR-007): an `owner` session was
    // never stopped by the archive, so there is nothing to start — but a
    // session the owner hard-deleted meanwhile must still surface as
    // `session_gone` rather than come back as a ready project whose next
    // turn fails (FR-44's reasoning, generalized to owner lifecycle).
    if (project.sessionBinding.ownership === 'owner') {
      const info = await this.execPort.getSession(sessionId);
      if (info === null) {
        throw new OrchestratorError(
          'session_gone',
          `session ${sessionId} no longer exists upstream (FR-44)`,
        );
      }
      this.store.setProjectSession(projectId, { lastKnownState: info.status });
      const restored = this.store.updateProject(projectId, { status: 'ready' });
      this.notify.projectState(projectId, 'ready');
      this.logger.info('project.restored', { projectId, sessionId });
      return restored;
    }
    // Translate the port's error into the orchestrator's own vocabulary: the
    // API depends on the orchestrator, not on the substrate (07 §2), so it
    // must not have to know SessionGoneError. A seam/transport failure is
    // deliberately NOT translated — it propagates as-is (500), because it is
    // transient and retryable, unlike a session that is gone for good.
    try {
      await this.execPort.startSession(sessionId);
    } catch (err) {
      if (err instanceof SessionGoneError) {
        throw new OrchestratorError('session_gone', err.message);
      }
      throw err;
    }
    this.store.setProjectSession(projectId, { lastKnownState: 'ready' });
    const updated = this.store.updateProject(projectId, { status: 'ready' });
    this.notify.projectState(projectId, 'ready');
    this.logger.info('project.restored', { projectId, sessionId });
    return updated;
  }

  /**
   * Restore an archived conversation (FR-43). Trivial next to a project's:
   * conversations own no session, they share the project's — which is
   * exactly why I-12 must be enforced here. An active conversation in an
   * archived project could not take a turn (the shared session is stopped),
   * so restoring it while the project is archived is rejected rather than
   * silently producing that dead state.
   */
  restoreConversation(conversationId: string): Conversation {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new OrchestratorError('not_found', `conversation ${conversationId}`);
    if (conversation.status !== 'archived') return conversation; // idempotent
    // I-12 applies to project conversations (they share the project's session).
    // A direct specialist conversation (projectId null) has no project to be
    // archived, so the check is skipped.
    if (conversation.projectId !== null) {
      const project = this.store.getProject(conversation.projectId);
      if (project?.status === 'archived') {
        throw new OrchestratorError(
          'project_archived',
          `restore project ${conversation.projectId} first — its session is stopped (I-12)`,
        );
      }
    }
    return this.store.updateConversation(conversationId, { status: 'active' });
  }

  // — UC-06: boot reconciliation (the provisioning half, B3-02) —

  /**
   * Projects caught mid-provisioning by the crash heal to `error` (B3-02):
   * the provision promise died with the process and nothing else can resolve
   * them; UC-01's failure path already defines the way forward (retry
   * recreates the session, FR-33/25).
   */
  reconcileProvisioning(): void {
    for (const project of this.store.listProjects()) {
      if (project.status === 'provisioning') {
        this.store.updateProject(project.id, { status: 'error' });
        this.notify.projectState(project.id, 'error');
      }
    }
  }
}
