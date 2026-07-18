/** REST client for the Hub API (08 §1). Types mirror the backend contracts. */

export interface Caps {
  maxTurns: number;
  budgetUsd: number;
  timeoutMs: number;
}

export interface WorkspaceTemplate {
  id: string;
  name: string;
  description?: string;
}

export interface Project {
  id: string;
  name: string;
  status: 'provisioning' | 'ready' | 'error' | 'archived';
  defaultAgentId: string;
  sessionBinding: {
    sessionId: string | null;
    /** ADR-007 (N2): how the project got its session and who owns it */
    bindingMode?: 'existing' | 'created';
    ownership?: 'owner' | 'legacy-technical';
    ownerAccountId?: string | null;
  };
}

/** What a new project declares as its workspace (FR-45/FR-49): exactly one. */
export type WorkspaceChoice =
  | { kind: 'template'; id: string }
  | { kind: 'session'; id: string };

/** A specialist's optional personal session (N3b-1, ADR-008). */
export interface SpecialistSession {
  sessionId: string;
  status: 'available' | 'busy' | 'offline' | 'error';
  ownership: 'owner' | 'legacy-technical';
  bindingMode: 'existing' | 'created';
}

/** A reusable professional identity (N3, ADR-008). */
export interface Specialist {
  id: string;
  name: string;
  role: string | null;
  capabilities: string[];
  allowedTools: string[];
  /** the specialist's personal session (N3b-1), or null when unbound */
  session: SpecialistSession | null;
}

export interface Conversation {
  id: string;
  /** null = a direct conversation with a specialist (N3b-2), no project */
  projectId: string | null;
  title: string;
  agentId: string;
  mode: 'direct' | 'preferred-specialist' | 'automatic';
  status: 'active' | 'archived';
}

/** One bubble of a turn (A): a run of assistant text, or a single tool step. */
export type TurnSegment =
  | { kind: 'text'; text: string }
  | { kind: 'command' | 'file' | 'denial' | 'tool'; detail: string; tool?: string };

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  runId: string | null;
  createdAt: string;
  /** present on an assistant turn that used tools — render as ordered bubbles
   *  (text → tool step → text) instead of the single `content` blob (A) */
  segments?: TurnSegment[];
}

export type RunState =
  | 'queued'
  | 'starting'
  | 'streaming'
  | 'completed'
  | 'completed_with_denials'
  | 'cancelled'
  | 'interrupted'
  | 'failed';

export interface Run {
  id: string;
  conversationId: string;
  messageId: string;
  state: RunState;
  killOutcome: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  /** ISO time the run began streaming — seeds the elapsed clock when a
   *  conversation is opened mid-run (F) */
  startedAt: string | null;
}

export interface ActivityItem {
  kind: 'command' | 'file' | 'denial' | 'tool';
  detail: string;
  tool?: string;
  seq: number;
}

export interface Activity {
  commands: string[];
  files: string[];
  denials: string[];
  /** every tool step in order (L4) — includes generic tools not in the arrays above */
  items: ActivityItem[];
}

export interface Usage {
  runId: string;
  totalCostUsd: number | null;
  numTurns: number | null;
  source: string;
}

export interface RunSummary {
  runId: string;
  objective: string;
  outcome: RunState;
  filesTouched: string[];
  commandsRun: string[];
  denialCount: number;
  warnings: string[];
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
}

export interface RunDetail {
  run: Run;
  activity: Activity;
  /** ordered bubbles of the turn (A) — used to seed a mid-run turn on open (F) */
  segments: TurnSegment[];
  usage: Usage | null;
  summary: RunSummary | null;
}

/**
 * A substrate session as discovery sees it (N1, FR-48, ADR-007), annotated
 * with the Hub project bound to it, if any.
 */
export interface SessionRow {
  sessionId: string;
  name: string;
  status: string;
  ownerUsername: string | null;
  createdAt: string | null;
  lastConnectedAt: string | null;
  projectId: string | null;
  projectName: string | null;
  /**
   * Lifecycle owner of the bound project's session (ADR-007): `owner` = the
   * owner's own account; `legacy-technical` = the Hub's generic account, always
   * project-bound while alive; `null` = not bound to any Hub project.
   */
  ownership: 'owner' | 'legacy-technical' | null;
}

/**
 * The sessions the owner cares to see: their own account's sessions, bound or
 * not. It hides the Hub's own generic `legacy-technical` sessions — those exist
 * only to back a project and carry no owner-facing identity of their own.
 */
export function ownerVisibleSessions(listing: SessionListing): SessionRow[] {
  return listing.sessions.filter((s) => s.ownership !== 'legacy-technical');
}

export interface SessionListing {
  /**
   * 'all' — the whole estate with owner attribution (admin-flagged execution
   * identity); 'own' — only the Hub identity's sessions (no admin flag yet):
   * a partial view the UI must present as partial (FR-48).
   */
  scope: 'all' | 'own';
  sessions: SessionRow[];
}

const TOKEN_KEY = 'agenthub.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail?: string,
  ) {
    super(detail ?? code);
    this.name = 'ApiError';
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${getToken() ?? ''}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, String(json['code'] ?? 'error'), json['detail'] as string);
  }
  return json as T;
}

export const api = {
  health: () => call<{ status: string }>('GET', '/api/health'),
  agents: () => call<{ agents: Array<{ id: string; name: string }> }>('GET', '/api/agents'),
  listProjects: (opts?: { archived?: boolean }) =>
    call<{ projects: Project[] }>('GET', `/api/projects${opts?.archived ? '?archived=true' : ''}`),
  listArchivedConversations: () =>
    call<{ conversations: Conversation[] }>('GET', '/api/conversations?archived=true'),
  workspaceTemplates: () =>
    call<{ workspaceTemplates: WorkspaceTemplate[] }>('GET', '/api/workspace-templates'),
  listSessions: () => call<SessionListing>('GET', '/api/sessions'),
  listSpecialists: () => call<{ specialists: Specialist[] }>('GET', '/api/specialists'),
  // bind or create a specialist's personal session (N3b-1): exactly one arg
  bindSpecialistSession: (specialistId: string, workspace: WorkspaceChoice) =>
    call<{ session: SpecialistSession }>('POST', `/api/specialists/${specialistId}/session`, {
      ...(workspace.kind === 'session'
        ? { sessionId: workspace.id }
        : { sessionTemplateId: workspace.id }),
    }),
  // The workspace is the project's and has no default (ADR-006, FR-45):
  // either a template to create from, or an existing owner-account session
  // to bind (FR-49, N2) — exactly one, enforced server-side.
  createProject: (
    name: string,
    defaultAgentId: string,
    workspace: WorkspaceChoice,
    instructions?: string,
  ) =>
    call<{ project: Project }>('POST', '/api/projects', {
      name,
      defaultAgentId,
      ...(workspace.kind === 'template'
        ? { sessionTemplateId: workspace.id }
        : { sessionId: workspace.id }),
      instructions,
    }),
  getProject: (id: string) =>
    call<{ project: Project; conversations: Conversation[] }>('GET', `/api/projects/${id}`),
  createConversation: (projectId: string, title?: string) =>
    call<{ conversation: Conversation }>('POST', `/api/projects/${projectId}/conversations`, {
      title,
    }),
  // direct conversation with a specialist (N3b-2) — runs in its personal session
  createSpecialistConversation: (specialistId: string, title?: string) =>
    call<{ conversation: Conversation }>(
      'POST',
      `/api/specialists/${specialistId}/conversations`,
      { title },
    ),
  getConversation: (id: string, opts?: { before?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (opts?.before) q.set('before', opts.before);
    if (opts?.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return call<{ conversation: Conversation; messages: Message[]; hasMore: boolean }>(
      'GET',
      `/api/conversations/${id}${qs ? `?${qs}` : ''}`,
    );
  },
  sendMessage: (conversationId: string, content: string) =>
    call<{ messageId: string; runId: string; runState: RunState }>(
      'POST',
      `/api/conversations/${conversationId}/messages`,
      { content },
    ),
  getRun: (id: string) => call<RunDetail>('GET', `/api/runs/${id}`),
  cancelRun: (id: string) => call<{ accepted: boolean }>('POST', `/api/runs/${id}/cancel`),
  // Archive is the product's "delete" and is REVERSIBLE (FR-43): archiving a
  // project stops its substrate session, restoring restarts it. The workspace
  // is a host directory, so it survives the stop — a restored project comes
  // back with the same files and the same transcripts, and its next turn
  // resumes where it left off.
  archiveProject: (id: string) =>
    call<{ project: Project }>('PATCH', `/api/projects/${id}`, { status: 'archived' }),
  archiveConversation: (id: string) =>
    call<{ conversation: Conversation }>('PATCH', `/api/conversations/${id}`, {
      status: 'archived',
    }),
  // Conversations earn a name from their first message (backend auto-title) and
  // can be renamed by hand — same PATCH, title only (the backend ignores a
  // blank one). I-10/I-6: projectId and agentId have no update path.
  renameConversation: (id: string, title: string) =>
    call<{ conversation: Conversation }>('PATCH', `/api/conversations/${id}`, { title }),
  // Restore. A project whose session was hard-deleted upstream cannot come
  // back — the API answers 409 `session_gone` and leaves it archived rather
  // than handing over a fresh empty workspace wearing the old name (FR-44).
  restoreProject: (id: string) =>
    call<{ project: Project }>('PATCH', `/api/projects/${id}`, { status: 'ready' }),
  restoreConversation: (id: string) =>
    call<{ conversation: Conversation }>('PATCH', `/api/conversations/${id}`, { status: 'active' }),
};
