/**
 * WorkspaceManager (ADR-010 B, N5b-2): isolates a task's code work in a git
 * worktree/branch owned by the project session, so concurrent tasks never
 * collide in the shared session workspace. Every operation is plain git run BY
 * the project session over the exec seam — no new substrate capability, no
 * cross-session file access, no copies.
 *
 * Real/fake split behind the port, like the router (ADR-008) and the extractor
 * (ADR-009): the offline fake hands out a deterministic worktree descriptor
 * without touching git, so the supervisor's worktree orchestration runs
 * end-to-end in the offline suite; the real one issues the git execs and is
 * unit-tested against a recording exec stub.
 */

import type { SubstrateExecPort, WorkspaceManagerPort } from '../domain/ports.js';
import { NOOP_LOGGER, type Logger } from '../domain/ports.js';
import type { Task, TaskWorkspace } from '../domain/types.js';
import type { HubStore } from '../store/types.js';

/** Worktrees live under this dir in the project session's workspace root. */
const WORKTREE_ROOT = '.hub-task-worktrees';
/** Git plumbing execs are short; bounded well under the seam's 1 h backstop (FR-17). */
const GIT_EXEC_MS = 60_000;

/** The task's branch — `hub/task/<id>` — kept after cleanup so the commits survive (N6). */
export function taskBranch(taskId: string): string {
  return `hub/task/${taskId}`;
}
/** The task's worktree path, relative to the project session's workspace root. */
export function taskWorktreePath(taskId: string): string {
  return `${WORKTREE_ROOT}/${taskId}`;
}

interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Run one raw exec to completion, collecting output + exit (the sweep pattern). */
async function runExec(
  execPort: SubstrateExecPort,
  sessionId: string,
  argv: string[],
): Promise<ExecResult> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  let error: string | undefined;
  const stream = execPort.exec(sessionId, { argv, maxDurationMs: GIT_EXEC_MS });
  for await (const ev of stream) {
    if (ev.type === 'output') {
      if (ev.stream === 'stdout') stdout += ev.data;
      else stderr += ev.data;
    } else if (ev.type === 'exit') {
      exitCode = ev.exitCode;
    } else if (ev.type === 'error') {
      error = ev.message;
    }
  }
  return { exitCode, stdout, stderr, ...(error ? { error } : {}) };
}

/**
 * Offline WorkspaceManager: hands out a deterministic worktree descriptor with
 * no git and no exec. The step turns still carry its path as `workingDir`, so
 * the supervisor's create → step → commit → cleanup orchestration is exercised
 * end-to-end offline; commit and cleanup are no-ops.
 */
export class FakeWorkspaceManager implements WorkspaceManagerPort {
  createTaskWorkspace(task: Task): Promise<TaskWorkspace> {
    return Promise.resolve({
      strategy: 'worktree',
      branch: taskBranch(task.id),
      path: taskWorktreePath(task.id),
    });
  }
  commitWork(): Promise<void> {
    return Promise.resolve();
  }
  cleanup(): Promise<void> {
    return Promise.resolve();
  }
}

export interface RealWorkspaceManagerDeps {
  store: HubStore;
  execPort: SubstrateExecPort;
  logger?: Logger;
}

/**
 * Real WorkspaceManager: creates/commits/removes a git worktree by executing
 * plain git in the project's primary session. Degrades gracefully — a project
 * with no git repo (or a failed `worktree add`) falls back to the project
 * primary workspace so the task still runs (strategy A), rather than failing.
 */
export class RealWorkspaceManager implements WorkspaceManagerPort {
  private readonly store: HubStore;
  private readonly execPort: SubstrateExecPort;
  private readonly logger: Logger;

  constructor(deps: RealWorkspaceManagerDeps) {
    this.store = deps.store;
    this.execPort = deps.execPort;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  private sessionFor(task: Task): string | null {
    return this.store.getProject(task.projectId)?.sessionBinding.sessionId ?? null;
  }

  async createTaskWorkspace(task: Task): Promise<TaskWorkspace> {
    const fallback: TaskWorkspace = { strategy: 'project-primary', branch: null, path: null };
    const sessionId = this.sessionFor(task);
    if (!sessionId) return fallback;
    const branch = taskBranch(task.id);
    const path = taskWorktreePath(task.id);
    // create a worktree on a fresh task branch off HEAD, from the repo root
    const r = await runExec(this.execPort, sessionId, [
      'git',
      'worktree',
      'add',
      path,
      '-b',
      branch,
      'HEAD',
    ]);
    if (r.error || r.exitCode !== 0) {
      // repo-less project or a failed add → strategy A, the task still runs
      this.logger.warn('task.worktree_fallback', {
        taskId: task.id,
        exitCode: r.exitCode,
        error: r.error ?? null,
      });
      return fallback;
    }
    return { strategy: 'worktree', branch, path };
  }

  async commitWork(task: Task, workspace: TaskWorkspace, message: string): Promise<void> {
    if (workspace.strategy !== 'worktree' || !workspace.path) return; // strategy-A no-op
    const sessionId = this.sessionFor(task);
    if (!sessionId) return;
    // add + commit inside the worktree; tolerate "nothing to commit". path and
    // message ride as positional params ($1/$2) — never shell-interpreted.
    const script =
      'git -C "$1" add -A && git -C "$1" -c user.email=hub@localhost -c user.name="Agent Hub" commit -m "$2" || true';
    const r = await runExec(this.execPort, sessionId, [
      'bash',
      '-c',
      script,
      'hub_commit',
      workspace.path,
      message,
    ]);
    if (r.error) this.logger.warn('task.commit_failed', { taskId: task.id, error: r.error });
  }

  async cleanup(task: Task, workspace: TaskWorkspace): Promise<void> {
    if (workspace.strategy !== 'worktree' || !workspace.path) return; // strategy-A no-op
    const sessionId = this.sessionFor(task);
    if (!sessionId) return;
    // remove the worktree; the branch (commits) survives for human review + N6's
    // PR. Tolerate an already-absent worktree.
    const r = await runExec(this.execPort, sessionId, [
      'bash',
      '-c',
      'git worktree remove --force "$1" || true',
      'hub_cleanup',
      workspace.path,
    ]);
    if (r.error) this.logger.warn('task.cleanup_failed', { taskId: task.id, error: r.error });
  }
}
