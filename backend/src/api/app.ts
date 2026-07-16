/**
 * HTTP + SSE gateway (07 §2 `api`, 08 §1): auth, validation, correlation.
 * Every mutating route sits behind the single-credential gateway (Q-07);
 * every response carries X-Request-Id (16-hex, mirroring the seam).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { deriveActivity, sseFromRunEvent } from '../domain/projections.js';
import type { Agent } from '../domain/types.js';
import { Orchestrator, OrchestratorError } from '../orchestrator/orchestrator.js';
import { NOOP_LOGGER, type Logger } from '../domain/ports.js';
import { NotFoundError, ValidationError, type HubStore } from '../store/types.js';
import { withCorrelation } from '../observability/logger.js';
import type { Broadcaster, OutboundSse } from './broadcaster.js';

export interface ApiDeps {
  store: HubStore;
  orchestrator: Orchestrator;
  agents: ReadonlyMap<string, Agent>;
  broadcaster: Broadcaster;
  /** the single credential (Q-07); requests must send `Authorization: Bearer <token>` */
  authToken: string;
  /** SSE heartbeat interval; tests shrink it (default 25 s, 08 §3) */
  heartbeatMs?: number;
  /** backup freshness (OPS-02, B3-04); absent when backups are disabled */
  snapshotFreshness?: () => { lastSnapshotAt: string | null; degraded: boolean };
  /** structured logging (B3-07); no-op by default */
  logger?: Logger;
  /** metrics snapshot for /api/health detail (B3-07); absent → omitted */
  metricsSnapshot?: () => Record<string, unknown>;
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

  // the auth gateway — one middleware, in front of EVERYTHING else (V-3)
  app.use('/api', (req, res, next) => {
    if (!tokenMatches(req.headers.authorization, authToken)) {
      res.status(401).json({ code: 'unauthorized' });
      return;
    }
    next();
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

  // — projects —
  app.post('/api/projects', (req, res) => {
    const { name, defaultAgentId, instructions } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim() === '') {
      res.status(422).json({ code: 'validation', detail: 'name required' });
      return;
    }
    if (typeof defaultAgentId !== 'string' || !agents.has(defaultAgentId)) {
      res.status(422).json({ code: 'validation', detail: 'defaultAgentId must be a configured agent' });
      return;
    }
    const project = orchestrator.createProject({
      name,
      defaultAgentId,
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
    if (status !== undefined && status !== 'archived') {
      res.status(422).json({ code: 'validation', detail: 'status may only be set to "archived"' });
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
      res.json({ project: updated });
    })().catch(next);
  });

  // — conversations —
  app.post('/api/projects/:id/conversations', (req, res) => {
    const { title, agentId } = (req.body ?? {}) as Record<string, unknown>;
    const conversation = orchestrator.createConversation({
      projectId: req.params.id,
      ...(typeof title === 'string' && title.trim() !== '' ? { title } : {}),
      ...(typeof agentId === 'string' ? { agentId } : {}),
    });
    res.status(201).json({ conversation }); // instant — no provisioning (ADR-005)
  });

  app.get('/api/conversations', (req, res) => {
    const includeArchived = req.query['archived'] === 'true';
    const conversations = store.listConversations({ includeArchived }).map((c) => {
      const last = store.listMessages(c.id, { limit: 1 }).at(-1) ?? null;
      return { ...c, lastMessage: last };
    });
    res.json({ conversations });
  });

  app.get('/api/conversations/:id', (req, res) => {
    const conversation = store.getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ code: 'not_found' });
      return;
    }
    const before = typeof req.query['before'] === 'string' ? req.query['before'] : undefined;
    const limit = Number(req.query['limit'] ?? 50);
    res.json({
      conversation,
      messages: store.listMessages(conversation.id, {
        ...(before ? { before } : {}),
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
      }),
    });
  });

  app.patch('/api/conversations/:id', (req, res) => {
    const { title, status } = (req.body ?? {}) as Record<string, unknown>;
    if (status !== undefined && status !== 'archived') {
      res.status(422).json({ code: 'validation', detail: 'status may only be set to "archived"' });
      return;
    }
    const conversation = store.updateConversation(req.params.id, {
      ...(typeof title === 'string' && title.trim() !== '' ? { title } : {}),
      ...(status === 'archived' ? { status: 'archived' as const } : {}),
    });
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
    // numeric Last-Event-ID replays.
    const rawLastEventId = req.headers['last-event-id'];
    const parsed =
      rawLastEventId === undefined ? Number.NaN : Number.parseInt(String(rawLastEventId), 10);
    const afterIndex = Number.isFinite(parsed) ? parsed : null;
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

    const heartbeat = setInterval(() => res.write(': hb\n\n'), heartbeatMs);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

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
            : 409; // project_not_ready | run_not_cancellable — body carries state
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
