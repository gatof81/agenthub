/**
 * RealWorkspaceManager (N5b-2, ADR-010 B) — offline. Asserts the exact git it
 * runs BY the project session over the exec seam (worktree add / commit /
 * remove), the injection-safe positional-param wrapper, and the graceful
 * strategy-A fallback when a project has no session or `git worktree add` fails.
 * No real git, no substrate — a recording exec stub.
 */

import { describe, expect, it } from 'vitest';
import type { ExecRequest, SeamEvent, SubstrateExecPort } from '../src/domain/ports.js';
import type { Task } from '../src/domain/types.js';
import type { HubStore } from '../src/store/types.js';
import { RealWorkspaceManager, taskBranch, taskWorktreePath } from '../src/orchestrator/workspaceManager.js';

/** Records every exec and replays a scripted exit code + stdout. */
class RecordingExec {
  requests: Array<{ sessionId: string; req: ExecRequest }> = [];
  constructor(
    public exitCode: number | null = 0,
    public stdout = '',
  ) {}
  async *exec(sessionId: string, req: ExecRequest): AsyncIterable<SeamEvent> {
    this.requests.push({ sessionId, req });
    yield { v: 1, type: 'started', execId: 'e1', pgid: 1, requestId: 'r1' };
    if (this.stdout) yield { v: 1, type: 'output', stream: 'stdout', data: this.stdout };
    yield { v: 1, type: 'exit', exitCode: this.exitCode, reason: 'exited' };
  }
}

const TASK: Task = {
  id: 'task_1',
  projectId: 'proj_1',
  sourceConversationId: 'c1',
  sourceMessageId: 'm1',
  state: 'planning',
  pendingFeedback: [],
  pullRequestUrl: null,
  createdAt: 't',
  updatedAt: 't',
};

/** Minimal store: only `getProject().sessionBinding.sessionId` is read. */
function storeWithSession(sessionId: string | null): HubStore {
  return {
    getProject: () => (sessionId ? { sessionBinding: { sessionId } } : undefined),
  } as unknown as HubStore;
}

function make(sessionId: string | null, exitCode: number | null = 0, stdout = '') {
  const execPort = new RecordingExec(exitCode, stdout);
  const mgr = new RealWorkspaceManager({
    store: storeWithSession(sessionId),
    execPort: execPort as unknown as SubstrateExecPort,
  });
  return { execPort, mgr };
}

const WORKTREE = { strategy: 'worktree' as const, branch: 'hub/task/task_1', path: '/x/task_1' };
const PRIMARY = { strategy: 'project-primary' as const, branch: null, path: null };

describe('RealWorkspaceManager (ADR-010 B, offline)', () => {
  it('createTaskWorkspace cuts the branch from the REMOTE base, never local HEAD (#132)', async () => {
    const { execPort, mgr } = make('s1', 0, 'HUB_BASE=abc1234\nHUB_AHEAD=0\n');
    const ws = await mgr.createTaskWorkspace(TASK);

    expect(ws).toEqual({
      strategy: 'worktree',
      branch: taskBranch(TASK.id),
      path: taskWorktreePath(TASK.id),
    });
    expect(execPort.requests).toHaveLength(1);
    expect(execPort.requests[0]!.sessionId).toBe('s1');
    const argv = execPort.requests[0]!.req.argv;
    expect(argv[0]).toBe('bash');
    // base resolution: fetch best-effort, then origin/HEAD → upstream → HEAD;
    // the worktree is added from the RESOLVED base, not local HEAD
    expect(argv[2]).toContain('git fetch origin');
    expect(argv[2]).toContain('origin/HEAD');
    expect(argv[2]).toContain('@{upstream}');
    expect(argv[2]).toContain('git worktree add "$2" -b "$3" "$base"');
    // path/branch ride as positional params, never shell-interpreted
    expect(argv.slice(-2)).toEqual([taskWorktreePath(TASK.id), taskBranch(TASK.id)]);
  });

  it('logs unpushed local commits as EXCLUDED when the workspace runs ahead of the base (#132)', async () => {
    const warned: Array<Record<string, unknown>> = [];
    const execPort = new RecordingExec(0, 'HUB_BASE=abc1234\nHUB_AHEAD=2\n');
    const mgr = new RealWorkspaceManager({
      store: storeWithSession('s1'),
      execPort: execPort as unknown as SubstrateExecPort,
      logger: {
        info: () => {},
        warn: (event, fields) => warned.push({ event, ...fields }),
        error: () => {},
      },
    });
    await mgr.createTaskWorkspace(TASK);
    expect(warned).toEqual([
      { event: 'task.workspace_ahead', taskId: TASK.id, base: 'abc1234', aheadCount: 2 },
    ]);
  });

  it('falls back to the project workspace (no exec) when the project has no session', async () => {
    const { execPort, mgr } = make(null);
    const ws = await mgr.createTaskWorkspace(TASK);
    expect(ws).toEqual({ strategy: 'project-primary', branch: null, path: null });
    expect(execPort.requests).toHaveLength(0);
  });

  it('falls back to the project workspace when `git worktree add` fails (repo-less)', async () => {
    const { mgr } = make('s1', 128); // git error exit
    const ws = await mgr.createTaskWorkspace(TASK);
    expect(ws.strategy).toBe('project-primary');
    expect(ws.path).toBeNull();
  });

  it('commitWork add+commits in the worktree, path/message as positional params', async () => {
    const { execPort, mgr } = make('s1');
    const ws = { strategy: 'worktree' as const, branch: taskBranch(TASK.id), path: taskWorktreePath(TASK.id) };
    await mgr.commitWork(TASK, ws, 'do the thing');

    const argv = execPort.requests[0]!.req.argv;
    expect(argv[0]).toBe('bash');
    expect(argv[1]).toBe('-c');
    // the script references $1/$2, and path + message ride as their own argv slots
    expect(argv[2]).toContain('git -C "$1" add -A');
    expect(argv[2]).toContain('commit -m "$2"');
    expect(argv.slice(-2)).toEqual([taskWorktreePath(TASK.id), 'do the thing']);
  });

  it('cleanup removes the worktree with --force', async () => {
    const { execPort, mgr } = make('s1');
    const ws = { strategy: 'worktree' as const, branch: taskBranch(TASK.id), path: taskWorktreePath(TASK.id) };
    await mgr.cleanup(TASK, ws);

    const argv = execPort.requests[0]!.req.argv;
    expect(argv[2]).toContain('git worktree remove --force "$1"');
    expect(argv.at(-1)).toBe(taskWorktreePath(TASK.id));
  });

  it('commit and cleanup are no-ops on the project-primary fallback', async () => {
    const { execPort, mgr } = make('s1');
    await mgr.commitWork(TASK, PRIMARY, 'x');
    await mgr.cleanup(TASK, PRIMARY);
    expect(execPort.requests).toHaveLength(0);
  });

  it('openPullRequest pushes the branch, runs gh pr create, and returns the printed URL', async () => {
    const { execPort, mgr } = make('s1', 0, 'https://github.com/o/r/pull/42\n');
    const res = await mgr.openPullRequest(TASK, WORKTREE, { title: 'T', body: 'B' });

    expect(res.url).toBe('https://github.com/o/r/pull/42');
    const argv = execPort.requests[0]!.req.argv;
    // #113: wire gh as git's credential helper before pushing, else `git push`
    // over HTTPS fails non-interactively on a session that never ran setup-git
    expect(argv[2]).toContain('gh auth setup-git');
    expect(argv[2]).toContain('git -C "$1" push -u origin "$2"');
    expect(argv[2]).toContain('gh pr create --head "$2" --title "$3" --body "$4"');
    // branch/title/body ride as positional params (never shell-interpreted)
    expect(argv.slice(-3)).toEqual(['hub/task/task_1', 'T', 'B']);
  });

  it('openPullRequest returns url:null on the project-primary fallback (no branch), no exec', async () => {
    const { execPort, mgr } = make('s1');
    const res = await mgr.openPullRequest(TASK, PRIMARY, { title: 'T', body: 'B' });
    expect(res.url).toBeNull();
    expect(execPort.requests).toHaveLength(0);
  });

  it('openPullRequest returns url:null when push/gh fails (best-effort)', async () => {
    const { mgr } = make('s1', 1); // gh/git error exit
    const res = await mgr.openPullRequest(TASK, WORKTREE, { title: 'T', body: 'B' });
    expect(res.url).toBeNull();
  });
});
