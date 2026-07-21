/**
 * HTTP + SSE gateway (07 §2 `api`, 08 §1): auth, validation, correlation.
 * Every mutating route sits behind the single-credential gateway (Q-07);
 * every response carries X-Request-Id (16-hex, mirroring the seam).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { deriveActivity, deriveSegments, sseFromRunEvent } from '../domain/projections.js';
import type { Agent, RepoAuth } from '../domain/types.js';
import type { WorkspaceTemplate } from '../config/workspaceTemplates.js';
import { Orchestrator, OrchestratorError } from '../orchestrator/orchestrator.js';
import { NOOP_LOGGER, type Logger } from '../domain/ports.js';
import { NotFoundError, ValidationError, type HubStore } from '../store/types.js';
import { withCorrelation } from '../observability/logger.js';
import type { AccessVerifier } from './accessAuth.js';
import type { Broadcaster, OutboundSse } from './broadcaster.js';

export interface ApiDeps {
  store: HubStore;
  orchestrator: Orchestrator;
  agents: ReadonlyMap<string, Agent>;
  broadcaster: Broadcaster;
  /**
   * Bearer credential for localhost/programmatic callers (and the SPA's dev
   * fallback). A request with this token is authorized regardless of Access.
   */
  authToken: string;
  /**
   * Cloudflare Access JWT verifier (Q-07, ADR-011). When set, a browser
   * request carrying a valid signed `Cf-Access-Jwt-Assertion` is authorized
   * without the bearer token. Absent (dev/local, no Access) → bearer only.
   */
  accessVerifier?: AccessVerifier;
  /** SSE heartbeat interval; tests shrink it (default 25 s, 08 §3) */
  heartbeatMs?: number;
  /** backup freshness (OPS-02, B3-04); absent when backups are disabled */
  snapshotFreshness?: () => { lastSnapshotAt: string | null; degraded: boolean };
  /** structured logging (B3-07); no-op by default */
  logger?: Logger;
  /** metrics snapshot for /api/health detail (B3-07); absent → omitted */
  metricsSnapshot?: () => Record<string, unknown>;
  /**
   * What a project may declare as its workspace (ADR-006, FR-45). Required,
   * not optional: the create route validates against it, and an optional dep
   * would have let a harness skip it and quietly disable that validation —
   * test convenience shaping production behaviour.
   */
  workspaceTemplates: WorkspaceTemplate[];
  /**
   * Directory of the built frontend (`frontend/dist`). When set, the backend
   * serves the SPA so the browser is same-origin with `/api` — the ADR-002
   * single-hostname topology (tunnel → one backend serving both). Absent in
   * tests and in dev (Vite serves the SPA and proxies `/api`); an API-only
   * boot (no built frontend) also leaves it unset and simply doesn't serve a
   * SPA. Static assets are public — the `/api` token gate does not cover
   * them, and must not: the browser fetches the bundle before it has a token.
   */
  staticDir?: string;
}

function requestId(): string {
  return randomBytes(8).toString('hex'); // 16-hex, seam convention
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  const wanted = Buffer.from(expected);
  return presented.length === wanted.length && timingSafeEqual(presented, wanted);
}

export function buildApp(deps: ApiDeps): express.Express {
  const { store, orchestrator, agents, broadcaster, authToken } = deps;
  const heartbeatMs = deps.heartbeatMs ?? 25_000;
  const logger = deps.logger ?? NOOP_LOGGER;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // correlation id per request (OPS-04): generate, echo on the response, run
  // the handler inside the ambient scope so every nested log carries it, and
  // log request start/finish with ids/method/path/status ONLY — never bodies
  // (SEC-04/05, 13 §5). The id joins to the seam's X-Request-Id via the run row.
  app.use((req, res, next) => {
    const cid = requestId();
    res.setHeader('X-Request-Id', cid);
    withCorrelation(cid, () => {
      const start = Date.now();
      res.on('finish', () => {
        logger.info('http.request', {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - start,
        });
      });
      next();
    });
  });

  // liveness is unauthenticated; detail requires auth (08 §1)
  app.get('/api/health', (req, res) => {
    const authed = tokenMatches(req.headers.authorization, authToken);
    const backup = deps.snapshotFreshness?.() ?? null;
    res.json({
      status: 'ok',
      ...(authed
        ? {
            backup: backup
              ? { enabled: true, ...backup }
              : { enabled: false, lastSnapshotAt: null, degraded: false },
            ...(deps.metricsSnapshot ? { metrics: deps.metricsSnapshot() } : {}),
          }
        : {}),
    });
  });

  // the auth gateway — one middleware, in front of EVERYTHING else (V-3).
  // Two accepted credentials (ADR-011): the bearer token (localhost /
  // programmatic / SPA dev fallback), or — behind Cloudflare Access — a
  // valid signed Access JWT for browser traffic. The signed JWT is verified,
  // never the forgeable email header. Fail closed on any verification error.
  app.use('/api', (req, res, next) => {
    if (tokenMatches(req.headers.authorization, authToken)) {
      next();
      return;
    }
    const assertion = req.headers['cf-access-jwt-assertion'];
    if (deps.accessVerifier && typeof assertion === 'string') {
      deps.accessVerifier
        .verify(assertion)
        .then((identity) => {
          if (identity) {
            next();
            return;
          }
          res.status(401).json({ code: 'unauthorized' });
        })
        .catch(() => res.status(401).json({ code: 'unauthorized' }));
      return;
    }
    res.status(401).json({ code: 'unauthorized' });
  });

  // — agents (read-only, FR-02) —
  app.get('/api/agents', (_req, res) => {
    res.json({
      agents: [...agents.values()].map((a) => ({
        id: a.id,
        name: a.name,
        allowedTools: a.allowedTools,
        defaultCaps: a.defaultCaps,
      })),
    });
  });

  // — specialists (N3, ADR-008): reusable professional roles with
  // `role` + `capabilities`, plus their optional personal session (N3b-1).
  // Direct conversation with a specialist is N3b-2.
  app.get('/api/specialists', (_req, res) => {
    res.json({
      specialists: [...agents.values()].map((a) => {
        const session = store.getSpecialistSession(a.id);
        return {
          id: a.id,
          name: a.name,
          role: a.role ?? null,
          capabilities: a.capabilities ?? [],
          allowedTools: a.allowedTools,
          // the specialist's personal session (N3b-1), or null when unbound.
          // Ownership/sessionId echoed so the UI can offer "open terminal"
          // later (#419) — never a secret.
          session: session
            ? {
                sessionId: session.sessionId,
                status: session.status,
                ownership: session.ownership,
                bindingMode: session.bindingMode,
              }
            : null,
        };
      }),
    });
  });

  // Bind or create a specialist's personal session (N3b-1, ADR-008): exactly
  // one of `sessionId` (bind an existing owner session) or `sessionTemplateId`
  // (create one on-behalf, #420). Same validation shape as POST /api/projects.
  app.post('/api/specialists/:id/session', (req, res, next) => {
    const specialistId = req.params.id;
    if (!agents.has(specialistId)) {
      res.status(404).json({ code: 'not_found', detail: 'unknown specialist' });
      return;
    }
    const { sessionId, sessionTemplateId } = (req.body ?? {}) as Record<string, unknown>;
    const bindId = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : null;
    const templateId =
      typeof sessionTemplateId === 'string' && sessionTemplateId.trim() !== ''
        ? sessionTemplateId.trim()
        : null;
    if ((bindId !== null) === (templateId !== null)) {
      res.status(422).json({
        code: 'validation',
        detail: 'exactly one of sessionId (bind) and sessionTemplateId (create) is required',
      });
      return;
    }
    if (templateId !== null && !deps.workspaceTemplates.some((t) => t.id === templateId)) {
      res.status(422).json({
        code: 'validation',
        detail: 'sessionTemplateId must be one of the deployment workspace templates',
      });
      return;
    }
    orchestrator
      .bindSpecialistSession(specialistId, {
        ...(bindId !== null ? { sessionId: bindId } : {}),
        ...(templateId !== null ? { sessionTemplateId: templateId } : {}),
      })
      .then((binding) =>
        res.status(201).json({
          session: {
            sessionId: binding.sessionId,
            status: binding.status,
            ownership: binding.ownership,
            bindingMode: binding.bindingMode,
          },
        }),
      )
      .catch(next);
  });

  // The client cannot invent a template id: the workspace is the project's
  // and has no default (ADR-006, FR-45), so it needs the list to choose from.
  app.get('/api/workspace-templates', (_req, res) => {
    res.json({ workspaceTemplates: deps.workspaceTemplates });
  });

  // — sessions (N1 discovery, FR-48, ADR-007) — read-only: the substrate is
  // the authority; the Hub adds only its own project-binding annotation.
  // `scope: 'own'` tells the UI it is seeing the execution identity's estate,
  // not the owner's (no admin flag yet) — surfaced, never papered over.
  app.get('/api/sessions', (_req, res, next) => {
    orchestrator
      .listSessions()
      .then((listing) => res.json(listing))
      .catch(next);
  });

  // — projects —
  app.post('/api/projects', (req, res) => {
    const { name, defaultAgentId, sessionTemplateId, sessionId, repo, instructions } = (req.body ??
      {}) as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim() === '') {
      res.status(422).json({ code: 'validation', detail: 'name required' });
      return;
    }
    if (typeof defaultAgentId !== 'string' || !agents.has(defaultAgentId)) {
      res.status(422).json({ code: 'validation', detail: 'defaultAgentId must be a configured agent' });
      return;
    }
    // The workspace is the project's (ADR-006, FR-45) and it has no sane
    // default: falling back to the agent's template is exactly the conflation
    // this replaced. Validated against the configured list the same way
    // defaultAgentId is validated against the agents map — the comment on
    // /api/workspace-templates claims a client "cannot invent a template id",
    // and a claim the boundary does not enforce is just a wish. Unvalidated,
    // a made-up or stale id returned 202 and the project failed later at the
    // seam, with nothing pointing at the cause.
    //
    // No `length > 0` escape hatch: a deployment that configured none would
    // then accept anything, which is precisely the confusing failure this
    // prevents. Empty list ⇒ no project can be created, exactly as the
    // contract says.
    //
    // N2 (FR-49, ADR-007): the workspace declaration is now EITHER a template
    // (create path) OR an existing owner-account session to bind — exactly
    // one. Bind creates nothing upstream; the session already is the
    // workspace, so a repo declaration alongside it is a contradiction (the
    // session carries its own repo) and is refused rather than ignored.
    const bindSessionId = typeof sessionId === 'string' && sessionId.trim() !== ''
      ? sessionId.trim()
      : null;
    const hasTemplate = typeof sessionTemplateId === 'string' && sessionTemplateId.trim() !== '';
    if ((bindSessionId !== null) === hasTemplate) {
      res.status(422).json({
        code: 'validation',
        detail: 'exactly one of sessionTemplateId (create) and sessionId (bind, FR-49) is required',
      });
      return;
    }
    if (bindSessionId !== null && repo !== undefined && repo !== null) {
      res.status(422).json({
        code: 'validation',
        detail: 'repo cannot be declared when binding an existing session — the session already carries its workspace (FR-49)',
      });
      return;
    }
    // Validate and use the SAME value. Trimming for the checks and storing the
    // raw string let `"tpl "` clear both guards and reach the seam as an
    // unknown template — the project then died in `error` with nothing
    // pointing at a trailing space.
    const templateId = hasTemplate ? (sessionTemplateId as string).trim() : null;
    if (templateId !== null && !deps.workspaceTemplates.some((t) => t.id === templateId)) {
      res.status(422).json({
        code: 'validation',
        detail: `sessionTemplateId must be one of the deployment's workspace templates (GET /api/workspace-templates)`,
      });
      return;
    }
    const r = (repo ?? null) as { url?: unknown; ref?: unknown; target?: unknown; auth?: unknown } | null;
    if (r !== null && (typeof r.url !== 'string' || r.url.trim() === '')) {
      res.status(422).json({ code: 'validation', detail: 'repo.url required when repo is given' });
      return;
    }
    // repo.auth never reaches the store: it is handed to the seam at
    // provisioning and forgotten (FR-47, SEC-11). Split it off here so no
    // downstream call can accidentally persist it.
    //
    // Validated like every other field at this boundary. A blind cast let
    // `{kind:'oops'}` or a `pat` branch with no pat through to the seam,
    // producing an opaque substrate error instead of a 422 that says what is
    // wrong — the same failure this route already refuses for
    // sessionTemplateId. The detail never echoes the credential (SEC-04/05):
    // it names the shape, not the value.
    const rawAuth = r !== null && typeof r.auth === 'object' && r.auth !== null
      ? (r.auth as Record<string, unknown>)
      : null;
    let repoAuth: RepoAuth | null = null;
    if (rawAuth !== null) {
      if (rawAuth.kind === 'none') {
        repoAuth = { kind: 'none' };
      } else if (
        rawAuth.kind === 'pat' &&
        typeof rawAuth.pat === 'string' &&
        rawAuth.pat.trim() !== ''
      ) {
        repoAuth = { kind: 'pat', pat: rawAuth.pat.trim() };
      } else {
        res.status(422).json({
          code: 'validation',
          detail: 'repo.auth must be {kind:"none"} or {kind:"pat", pat:"<token>"}',
        });
        return;
      }
    }
    const project = orchestrator.createProject({
      name: name.trim(),
      defaultAgentId,
      sessionTemplateId: templateId,
      ...(bindSessionId !== null ? { existingSessionId: bindSessionId } : {}),
      ...(r !== null
        ? {
            repo: {
              url: (r.url as string).trim(),
              ...(typeof r.ref === 'string' ? { ref: r.ref } : {}),
              ...(typeof r.target === 'string' ? { target: r.target } : {}),
            },
          }
        : {}),
      ...(repoAuth ? { repoAuth } : {}),
      instructions: typeof instructions === 'string' ? instructions : null,
    });
    res.status(202).json({ project }); // status: "provisioning" (UC-01)
  });

  app.get('/api/projects', (req, res) => {
    const includeArchived = req.query['archived'] === 'true';
    res.json({ projects: store.listProjects({ includeArchived }) });
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ code: 'not_found' });
      return;
    }
    res.json({ project, conversations: store.listConversations({ projectId: project.id }) });
  });

  app.patch('/api/projects/:id', (req, res, next) => {
    const { name, status } = (req.body ?? {}) as Record<string, unknown>;
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ code: 'not_found' });
      return;
    }
    // archive stops the session (FR-40); restore restarts it (FR-43)
    if (status !== undefined && status !== 'archived' && status !== 'ready') {
      res.status(422).json({
        code: 'validation',
        detail: 'status may only be set to "archived" (archive) or "ready" (restore)',
      });
      return;
    }
    (async () => {
      let updated = project;
      if (typeof name === 'string' && name.trim() !== '') {
        updated = store.updateProject(project.id, { name });
      }
      if (status === 'archived') {
        updated = await orchestrator.archiveProject(project.id); // stops the session (FR-30)
      }
      if (status === 'ready') {
        updated = await orchestrator.restoreProject(project.id); // restarts it (FR-43)
      }
      res.json({ project: updated });
    })().catch(next);
  });

  // — conversations —
  app.post('/api/projects/:id/conversations', (req, res) => {
    const { title, agentId, mode } = (req.body ?? {}) as Record<string, unknown>;
    // `automatic` routes each turn (N4a, ADR-008); default `direct` pins agentId.
    // `preferred-specialist` is a declared ConversationMode but is not
    // implemented yet — reject any unsupported value rather than silently
    // downgrade it to `direct` (data loss at the seam; the mode ships in N4b).
    if (mode !== undefined && mode !== 'automatic' && mode !== 'direct') {
      res.status(422).json({ code: 'validation', detail: "mode must be 'automatic' or 'direct'" });
      return;
    }
    const conversation = orchestrator.createConversation({
      projectId: req.params.id,
      ...(typeof title === 'string' && title.trim() !== '' ? { title } : {}),
      ...(typeof agentId === 'string' ? { agentId } : {}),
      ...(mode === 'automatic' || mode === 'direct' ? { mode } : {}),
    });
    res.status(201).json({ conversation }); // instant — no provisioning (ADR-005)
  });

  // Direct conversation with a specialist (N3b-2, ADR-008): no project, runs
  // in the specialist's personal session. 422 if the specialist has no bound
  // session (nowhere to run — bind one first, N3b-1).
  app.post('/api/specialists/:id/conversations', (req, res, next) => {
    const specialistId = req.params.id;
    if (!agents.has(specialistId)) {
      res.status(404).json({ code: 'not_found', detail: 'unknown specialist' });
      return;
    }
    if (!store.getSpecialistSession(specialistId)) {
      res.status(422).json({
        code: 'validation',
        detail: 'bind a session to this specialist first (N3b-1)',
      });
      return;
    }
    const { title } = (req.body ?? {}) as Record<string, unknown>;
    try {
      const conversation = orchestrator.createSpecialistConversation(
        specialistId,
        typeof title === 'string' && title.trim() !== '' ? title : undefined,
      );
      res.status(201).json({ conversation });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/conversations', (req, res) => {
    const includeArchived = req.query['archived'] === 'true';
    const rows = store.listConversations({ includeArchived });
    // Last message of every conversation in ONE query (not one per row) so the
    // sidebar list doesn't block the event loop with 1+2N queries.
    const lastByConversation = store.getLastMessagesByConversationIds(rows.map((c) => c.id));
    const conversations = rows.map((c) => ({
      ...c,
      lastMessage: lastByConversation.get(c.id) ?? null,
    }));
    res.json({ conversations });
  });

  app.get('/api/conversations/:id', (req, res) => {
    const conversation = store.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ code: 'not_found' });
      return;
    }
    const before = typeof req.query['before'] === 'string' ? req.query['before'] : undefined;
    const rawLimit = Number(req.query['limit'] ?? 50);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    // Fetch one past the page so we can tell the client whether OLDER messages
    // exist (E) without a second query — a conversation over the limit would
    // otherwise silently truncate its history. Drop the extra oldest row.
    const fetched = store.listMessages(conversation.id, {
      ...(before ? { before } : {}),
      limit: limit + 1,
    });
    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(1) : fetched;
    // An assistant turn that used tools is rendered as ordered bubbles (A): text
    // → tool step → text. Derived on read from the run's events (a projection,
    // like activity). Attached only when tools actually split the turn — a plain
    // text answer renders from `content` (one bubble), so the payload stays lean.
    // Events for every turn on the page are fetched in ONE query (not per
    // message) so segmenting a long page stays a single round-trip.
    const eventsByRun = store.getEventsByRunIds(
      rows.flatMap((m) => (m.role === 'assistant' && m.runId ? [m.runId] : [])),
    );
    const messages = rows.map((m) => {
      if (m.role === 'assistant' && m.runId) {
        const segments = deriveSegments(eventsByRun.get(m.runId) ?? []);
        if (segments.some((s) => s.kind !== 'text')) return { ...m, segments };
      }
      return m;
    });
    // `hasMore` = older messages exist before this page (E). The client pages
    // back with `?before=<oldest message id>`.
    res.json({ conversation, messages, hasMore });
  });

  app.patch('/api/conversations/:id', (req, res) => {
    const { title, status } = (req.body ?? {}) as Record<string, unknown>;
    if (status !== undefined && status !== 'archived' && status !== 'active') {
      res.status(422).json({
        code: 'validation',
        detail: 'status may only be set to "archived" (archive) or "active" (restore)',
      });
      return;
    }
    // restore goes through the orchestrator: it enforces I-12 (a conversation
    // cannot be active while its project is archived — the shared session is
    // stopped, so it could not take a turn)
    let conversation =
      status === 'active'
        ? orchestrator.restoreConversation(req.params.id)
        : store.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ code: 'not_found' });
      return;
    }
    if (
      (typeof title === 'string' && title.trim() !== '') ||
      status === 'archived'
    ) {
      conversation = store.updateConversation(req.params.id, {
        ...(typeof title === 'string' && title.trim() !== '' ? { title } : {}),
        ...(status === 'archived' ? { status: 'archived' as const } : {}),
      });
    }
    res.json({ conversation });
  });

  // — messages → runs (FR-03) —
  app.post('/api/conversations/:id/messages', (req, res) => {
    const { content } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof content !== 'string' || content.trim() === '') {
      res.status(422).json({ code: 'validation', detail: 'content required' });
      return;
    }
    const { message, run } = orchestrator.send(req.params.id, content);
    res.status(202).json({ messageId: message.id, runId: run.id, runState: run.state });
  });

  // — runs —
  app.get('/api/runs/:id', (req, res) => {
    const run = store.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ code: 'not_found' });
      return;
    }
    const events = store.getEvents(run.id);
    res.json({
      run,
      activity: deriveActivity(events), // derived on read (06 §2, A2)
      // ordered bubbles (A) — lets a client seed the partial turn when it opens a
      // conversation mid-run (F), and matches how the finalized message renders
      segments: deriveSegments(events),
      usage: store.getUsage(run.id) ?? null,
      summary: store.getSummary(run.id) ?? null,
    });
  });

  app.post('/api/runs/:id/cancel', (req, res, next) => {
    orchestrator
      .cancelRun(req.params.id)
      .then(() => res.status(202).json({ accepted: true })) // final state arrives via SSE + GET
      .catch(next);
  });

  // — tasks (N5b, ADR-009): read surface for the task view (N5b-2b) —
  // The tasks a conversation spawned, so the client can hang a "view task"
  // affordance on the kickoff turn (matched by `sourceMessageId`).
  app.get('/api/conversations/:id/tasks', (req, res) => {
    const conversation = store.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ code: 'not_found' });
      return;
    }
    res.json({ tasks: store.listTasks({ sourceConversationId: conversation.id }) });
  });

  // One task in full: its state, ordered steps (with the DelegatedWorkspaceAccess
  // audit, ADR-010), and work products (ImplementationReport/QaReport, 18 §4).
  app.get('/api/tasks/:id', (req, res) => {
    const task = store.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ code: 'not_found' });
      return;
    }
    res.json({
      task,
      steps: store.listTaskSteps(task.id),
      workProducts: store.listWorkProducts(task.id),
    });
  });

  // Human approval (N6, ADR-009): the owner's verdict on a task awaiting it.
  // Approve/reject are terminal; request-changes re-enters the dev → QA loop.
  app.post('/api/tasks/:id/approve', (req, res, next) => {
    orchestrator
      .approveTask(req.params.id)
      .then((task) => res.json({ task }))
      .catch(next);
  });

  app.post('/api/tasks/:id/reject', (req, res, next) => {
    orchestrator
      .rejectTask(req.params.id)
      .then((task) => res.json({ task }))
      .catch(next);
  });

  app.post('/api/tasks/:id/request-changes', (req, res, next) => {
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (note === '') {
      // 422 for validation (doc 08 §6), matching every other validation reject
      res.status(422).json({ code: 'validation', detail: 'a note describing the requested changes is required' });
      return;
    }
    try {
      res.json({ task: orchestrator.requestTaskChanges(req.params.id, note) });
    } catch (err) {
      next(err);
    }
  });

  // — SSE (ADR-004, 08 §3) —
  app.get('/api/conversations/:id/events', (req, res) => {
    const conversation = store.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ code: 'not_found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const write = (e: OutboundSse): void => {
      let frame = '';
      if (e.id !== undefined) frame += `id: ${e.id}\n`;
      frame += `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
      res.write(frame);
    };

    // subscribe FIRST (buffering) so nothing falls between replay and live
    let replaying = true;
    let maxReplayedId = -1;
    const buffered: OutboundSse[] = [];
    const unsubscribe = broadcaster.subscribe(conversation.id, conversation.projectId, (e) => {
      if (replaying) buffered.push(e);
      else write(e);
    });

    // Cleanup is registered BEFORE replay so a throw mid-replay (headers are
    // already sent, so it cannot become a clean HTTP error) still tears down
    // the heartbeat and, crucially, the broadcaster subscription — otherwise
    // the closure leaks and the Broadcaster's per-conversation Set grows
    // unbounded (#117).
    const heartbeat = setInterval(() => res.write(': hb\n\n'), heartbeatMs);
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);

    try {
      // Last-Event-ID replay from the store — replayable events only (08 §3).
      //
      // Replay is for RESUMING: it hands back what a dropped connection missed.
      // A cold connect (no header) missed nothing — the client just loaded the
      // conversation over REST, history included — so there is nothing to
      // recover and replaying is actively harmful. It used to: an absent header
      // parsed to NaN and fell through to `afterIndex = -1`, i.e. "replay from
      // the beginning". Every page load re-streamed every past run's deltas on
      // top of the messages REST had already delivered, so answers appeared
      // twice and, because state events are deliberately NOT replayed (11 §5),
      // the client saw live deltas with no terminal `run.state` and sat on
      // "working" forever, for a run that had finished. Reloading did not help:
      // the server reproduced it on every fresh connection.
      //
      // Absent (or unparseable) header ⇒ start from now. Only an explicit,
      // numeric Last-Event-ID replays — and it is clamped to >= 0 so a client
      // can never reach the internal "-1 = from the beginning" sentinel and
      // force a full-history re-stream with a negative/zero id (#117). The
      // smallest legitimate cursor is 0 ("I have index 0"), which resumes from
      // index 1; index 0 is therefore never re-narrated.
      const rawLastEventId = req.headers['last-event-id'];
      const parsed =
        rawLastEventId === undefined ? Number.NaN : Number.parseInt(String(rawLastEventId), 10);
      const afterIndex = Number.isFinite(parsed) ? Math.max(0, parsed) : null;
      const messageIdByRun = new Map<string, string>();
      for (const row of afterIndex === null ? [] : store.getReplayableEvents(conversation.id, afterIndex)) {
        let messageId = messageIdByRun.get(row.event.runId);
        if (messageId === undefined) {
          messageId = store.getRun(row.event.runId)?.messageId ?? '';
          messageIdByRun.set(row.event.runId, messageId);
        }
        for (const wire of sseFromRunEvent(messageId, row.event)) {
          write({ ...wire, id: row.index });
        }
        maxReplayedId = row.index;
      }
      replaying = false;
      for (const e of buffered) {
        if (e.id !== undefined && e.id <= maxReplayedId) continue; // already replayed
        write(e);
      }
      buffered.length = 0;
    } catch (err) {
      cleanup();
      throw err;
    }
  });

  // — static SPA (ADR-002 single-origin) — registered AFTER every /api route
  // so it can never shadow one. Only when a built frontend is wired.
  if (deps.staticDir !== undefined) {
    const staticDir = deps.staticDir;
    const indexHtml = join(staticDir, 'index.html');
    // Unmatched /api paths answer JSON 404, not the SPA — an API 404 must
    // stay machine-readable. This sits before the static block so the SPA
    // fallback below never sees an /api path.
    app.use('/api', (_req, res) => {
      res.status(404).json({ code: 'not_found' });
    });
    // Real files (index.html, hashed assets) — public, no token gate.
    app.use(express.static(staticDir, { index: false }));
    // SPA fallback: client-side routes resolve to index.html. Express 5's
    // router rejects a bare '*' path (path-to-regexp v8), so this is a plain
    // catch-all middleware, guarded to GETs and to non-/api paths (the /api
    // 404 above already claimed those). Missing index.html → the error
    // handler, not a hang.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET') {
        next();
        return;
      }
      res.sendFile(indexHtml, (err: unknown) => {
        if (err) next(err);
      });
    });
  }

  // — error taxonomy mapping (08 §6 API side) —
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof OrchestratorError) {
      const status =
        err.code === 'not_found'
          ? 404
          : err.code === 'unknown_agent'
            ? 422
            : 409; // project_not_ready | run_not_cancellable | session_gone (FR-44)
            //       | project_archived (I-12) — the body carries the code
      res.status(status).json({ code: err.code, detail: err.message });
      return;
    }
    if (err instanceof ValidationError) {
      res.status(422).json({ code: 'validation', detail: err.message });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ code: 'not_found' });
      return;
    }
    res.status(500).json({ code: 'internal' });
  });

  return app;
}
