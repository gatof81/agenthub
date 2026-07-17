/**
 * In-process contract double of the seam's exec API (EXEC_API.md wire
 * shapes) for the B2-01 conformance suite: real HTTP + chunked NDJSON, JWT
 * cookie auth via /api/auth/login, scripted responses. Offline by construction
 * (13 §6) — it exists so RealSubstrateExecPort can be exercised against the
 * documented wire without a substrate.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export interface ExecScript {
  /** value for X-Request-Id and the started event's requestId */
  requestId?: string;
  /** wire lines (JSON strings, no trailing newline) streamed after `started` */
  lines?: string[];
  /** include the started line automatically (default true) */
  emitStarted?: boolean;
  execId?: string;
  pgid?: number;
  /** how the byte stream is cut into HTTP chunks */
  chunkMode?: 'per-line' | 'split-mid-line';
  /** non-200: respond with this status + errorBody instead of a stream */
  status?: number;
  errorBody?: unknown;
}

export interface ScriptedResponse {
  status?: number;
  body?: unknown;
}

interface RecordedCall {
  sessionId: string;
  execId?: string;
  body: unknown;
  cookie: string | undefined;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

export class SeamDouble {
  readonly execScripts: ExecScript[] = [];
  readonly statusResponses: ScriptedResponse[] = [];
  readonly killResponses: ScriptedResponse[] = [];
  readonly execCalls: RecordedCall[] = [];
  readonly statusCalls: RecordedCall[] = [];
  readonly killCalls: RecordedCall[] = [];
  // B2-02 session-provisioning surface
  readonly templateResponses: ScriptedResponse[] = [];
  readonly createResponses: ScriptedResponse[] = [];
  readonly metaResponses: ScriptedResponse[] = [];
  readonly bootstrapLogResponses: ScriptedResponse[] = [];
  readonly stopResponses: ScriptedResponse[] = [];
  readonly templateCalls: string[] = [];
  readonly createCalls: unknown[] = [];
  readonly metaCalls: string[] = [];
  readonly bootstrapLogCalls: string[] = [];
  readonly stopCalls: string[] = [];
  // N1 session-discovery surface (wire shapes verified at 0cd4ed5)
  readonly adminListResponses: ScriptedResponse[] = [];
  readonly ownListResponses: ScriptedResponse[] = [];
  adminListCalls = 0;
  ownListCalls = 0;
  /**
   * Whether the authenticated account carries the admin flag. `false` makes
   * `GET /api/admin/sessions` answer requireAdmin's 403 (`auth.ts` at
   * 0cd4ed5: `{error:"Admin privileges required"}`) — the degraded-scope
   * branch the port must survive.
   */
  isAdmin = true;
  loginCount = 0;
  username = 'hub-service';
  password = 'hub-password';

  private server: Server | null = null;
  private readonly validCookies = new Set<string>();
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server ? this.server.close((e) => (e ? reject(e) : resolve())) : resolve(),
    );
  }

  /** Simulate a substrate-side session expiry: every issued JWT stops working. */
  expireAllCookies(): void {
    this.validCookies.clear();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';
    const raw = await readBody(req);
    const body: unknown = raw === '' ? undefined : JSON.parse(raw);

    // upstream mounts everything under /api, auth routes included
    if (req.method === 'POST' && url === '/api/auth/login') {
      const creds = body as { username?: string; password?: string };
      if (creds.username !== this.username || creds.password !== this.password) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid credentials' }));
        return;
      }
      this.loginCount += 1;
      const cookie = `st_token=tok_${this.loginCount}`;
      this.validCookies.add(cookie);
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `${cookie}; HttpOnly; Path=/; SameSite=Strict`,
      });
      res.end(JSON.stringify({ userId: 'user_hub' })); // never the raw token
      return;
    }

    const cookie = req.headers.cookie;
    if (cookie === undefined || !this.validCookies.has(cookie)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthenticated' }));
      return;
    }

    // N1 discovery listings. Wire shapes at 0cd4ed5: both return an ARRAY
    // (no envelope) of serializeMeta rows + cpuLimit/memLimit/usage; admin
    // rows additionally carry userId + ownerUsername (routes/admin.ts:139-151).
    if (req.method === 'GET' && url === '/api/admin/sessions') {
      this.adminListCalls += 1;
      if (!this.isAdmin) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Admin privileges required' }));
        return;
      }
      const scripted = this.adminListResponses.shift() ?? { body: [] };
      res.writeHead(scripted.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scripted.body ?? []));
      return;
    }

    if (req.method === 'GET' && url === '/api/sessions') {
      this.ownListCalls += 1;
      const scripted = this.ownListResponses.shift() ?? { body: [] };
      res.writeHead(scripted.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scripted.body ?? []));
      return;
    }

    const template = /^\/api\/templates\/([^/]+)$/.exec(url);
    if (req.method === 'GET' && template) {
      this.templateCalls.push(decodeURIComponent(template[1]!));
      const scripted = this.templateResponses.shift() ?? {
        body: { id: template[1], name: 'tpl', config: {} },
      };
      res.writeHead(scripted.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scripted.body ?? {}));
      return;
    }

    if (req.method === 'POST' && url === '/api/sessions') {
      // wire-accurate AgentSeedSpec (sessionConfig.ts): both fields are
      // strings, settings must parse as JSON — objects are a 400
      const seed = (body as { config?: { agentSeed?: Record<string, unknown> } })?.config
        ?.agentSeed;
      if (seed) {
        for (const [field, value] of Object.entries(seed)) {
          if (typeof value !== 'string') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: `config.agentSeed.${field}: Invalid input: expected string, received ${typeof value}`,
              }),
            );
            return;
          }
        }
        if (typeof seed.settings === 'string' && seed.settings !== '') {
          try {
            JSON.parse(seed.settings);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'settings must be valid JSON' }));
            return;
          }
        }
      }
      this.createCalls.push(body);
      const scripted = this.createResponses.shift() ?? {
        status: 201,
        body: { sessionId: 'sess_double1', status: 'running', bootstrapping: true },
      };
      res.writeHead(scripted.status ?? 201, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scripted.body ?? {}));
      return;
    }

    const stop = /^\/api\/sessions\/([^/]+)\/stop$/.exec(url);
    if (req.method === 'POST' && stop) {
      this.stopCalls.push(stop[1]!);
      const scripted = this.stopResponses.shift() ?? { body: { sessionId: stop[1], status: 'stopped' } };
      res.writeHead(scripted.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scripted.body ?? {}));
      return;
    }

    const bootstrapLog = /^\/api\/sessions\/([^/]+)\/bootstrap-log$/.exec(url);
    if (req.method === 'GET' && bootstrapLog) {
      this.bootstrapLogCalls.push(bootstrapLog[1]!);
      const scripted = this.bootstrapLogResponses.shift() ?? { body: { log: null } };
      res.writeHead(scripted.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scripted.body ?? {}));
      return;
    }

    const meta = /^\/api\/sessions\/([^/]+)$/.exec(url);
    if (req.method === 'GET' && meta) {
      this.metaCalls.push(meta[1]!);
      const scripted = this.metaResponses.shift() ?? {
        body: { sessionId: meta[1], status: 'running' },
      };
      res.writeHead(scripted.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scripted.body ?? {}));
      return;
    }

    const exec = /^\/api\/sessions\/([^/]+)\/exec$/.exec(url);
    if (req.method === 'POST' && exec) {
      this.execCalls.push({ sessionId: exec[1]!, body, cookie });
      const script = this.execScripts.shift();
      if (!script) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'seamDouble: no exec script queued' }));
        return;
      }
      await this.streamExec(res, script);
      return;
    }

    const status = /^\/api\/sessions\/([^/]+)\/exec\/([^/]+)$/.exec(url);
    if (req.method === 'GET' && status) {
      this.statusCalls.push({ sessionId: status[1]!, execId: status[2]!, body, cookie });
      const scripted = this.statusResponses.shift() ?? { body: { state: 'unknown' } };
      res.writeHead(scripted.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scripted.body ?? {}));
      return;
    }

    const kill = /^\/api\/sessions\/([^/]+)\/exec\/([^/]+)\/kill$/.exec(url);
    if (req.method === 'POST' && kill) {
      this.killCalls.push({ sessionId: kill[1]!, execId: kill[2]!, body, cookie });
      const scripted = this.killResponses.shift() ?? { body: { outcome: 'terminated' } };
      res.writeHead(scripted.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scripted.body ?? {}));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown route' }));
  }

  private async streamExec(res: ServerResponse, script: ExecScript): Promise<void> {
    if (script.status !== undefined && script.status !== 200) {
      res.writeHead(script.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(script.errorBody ?? { error: 'scripted-error' }));
      return;
    }
    const requestId = script.requestId ?? 'a1b2c3d4e5f60718';
    const lines: string[] = [];
    if (script.emitStarted !== false) {
      lines.push(
        JSON.stringify({
          v: 1,
          type: 'started',
          execId: script.execId ?? 'e_double1',
          pgid: script.pgid ?? 137,
          requestId,
          ts: '2026-07-15T00:00:00.000Z',
        }),
      );
    }
    lines.push(...(script.lines ?? []));
    const payload = lines.map((l) => `${l}\n`).join('');

    res.writeHead(200, {
      'content-type': 'application/x-ndjson',
      'x-request-id': requestId,
    });

    if (script.chunkMode === 'split-mid-line') {
      // cut the byte stream without regard for line boundaries (the
      // contract's "not necessarily line-aligned"); tiny sleeps keep Node
      // from coalescing the writes into one chunk
      const size = 7;
      for (let i = 0; i < payload.length; i += size) {
        res.write(payload.slice(i, i + size));
        await sleep(1);
      }
    } else {
      for (const line of lines) {
        res.write(`${line}\n`);
        await sleep(1);
      }
    }
    res.end();
  }
}
