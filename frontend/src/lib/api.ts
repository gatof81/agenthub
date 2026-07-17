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
  sessionBinding: { sessionId: string | null };
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  agentId: string;
  status: 'active' | 'archived';
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  runId: string | null;
  createdAt: string;
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
}

export interface Activity {
  commands: string[];
  files: string[];
  denials: string[];
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
  usage: Usage | null;
  summary: RunSummary | null;
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
  // sessionTemplateId is required: the workspace is the project's and has no
  // default — the agent no longer carries one (ADR-006, FR-45).
  createProject: (
    name: string,
    defaultAgentId: string,
    sessionTemplateId: string,
    instructions?: string,
  ) =>
    call<{ project: Project }>('POST', '/api/projects', {
      name,
      defaultAgentId,
      sessionTemplateId,
      instructions,
    }),
  getProject: (id: string) =>
    call<{ project: Project; conversations: Conversation[] }>('GET', `/api/projects/${id}`),
  createConversation: (projectId: string, title?: string) =>
    call<{ conversation: Conversation }>('POST', `/api/projects/${projectId}/conversations`, {
      title,
    }),
  getConversation: (id: string) =>
    call<{ conversation: Conversation; messages: Message[] }>('GET', `/api/conversations/${id}`),
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
  // Restore. A project whose session was hard-deleted upstream cannot come
  // back — the API answers 409 `session_gone` and leaves it archived rather
  // than handing over a fresh empty workspace wearing the old name (FR-44).
  restoreProject: (id: string) =>
    call<{ project: Project }>('PATCH', `/api/projects/${id}`, { status: 'ready' }),
  restoreConversation: (id: string) =>
    call<{ conversation: Conversation }>('PATCH', `/api/conversations/${id}`, { status: 'active' }),
};
