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

/** Records every exec and replays a scripted exit code. */
class RecordingExec {
  requests: Array<{ sessionId: string; req: ExecRequest }> = [];
  constructor(public exitCode: number | null = 0) {}
  async *exec(sessionId: string, req: ExecRequest): AsyncIterable<SeamEvent> {
    this.requests.push({ sessionId, req });
    yield { v: 1, type: 'started', execId: 'e1', pgid: 1, requestId: 'r1' };
    yield { v: 1, type: 'exit', exitCode: this.exitCode, reason: 'exited' };
  }
}

const TASK: Task = {
  id: 'task_1',
  projectId: 'proj_1',
  sourceConversationId: 'c1',
  sourceMessageId: 'm1',
  state: 'planning',
  createdAt: 't',
  updatedAt: 't',
};

/** Minimal store: only `getProject().sessionBinding.sessionId` is read. */
function storeWithSession(sessionId: string | null): HubStore {
  return {
    getProject: () => (sessionId ? { sessionBinding: { sessionId } } : undefined),
  } as unknown as HubStore;
}

function make(sessionId: string | null, exitCode: number | null = 0) {
  const execPort = new RecordingExec(exitCode);
  const mgr = new RealWorkspaceManager({
    store: storeWithSession(sessionId),
    execPort: execPort as unknown as SubstrateExecPort,
  });
  return { execPort, mgr };
}

describe('RealWorkspaceManager (ADR-010 B, offline)', () => {
  it('createTaskWorkspace runs `git worktree add <path> -b <branch> HEAD`', async () => {
    const { execPort, mgr } = make('s1');
    const ws = await mgr.createTaskWorkspace(TASK);

    expect(ws).toEqual({
      strategy: 'worktree',
      branch: taskBranch(TASK.id),
      path: taskWorktreePath(TASK.id),
    });
    expect(execPort.requests).toHaveLength(1);
    expect(execPort.requests[0]!.sessionId).toBe('s1');
    expect(execPort.requests[0]!.req.argv).toEqual([
      'git',
      'worktree',
      'add',
      taskWorktreePath(TASK.id),
      '-b',
      taskBranch(TASK.id),
      'HEAD',
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
    const ws = { strategy: 'project-primary' as const, branch: null, path: null };
    await mgr.commitWork(TASK, ws, 'x');
    await mgr.cleanup(TASK, ws);
    expect(execPort.requests).toHaveLength(0);
  });
});
