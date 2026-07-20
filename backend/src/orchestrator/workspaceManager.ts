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

import type {
  PullRequestContent,
  SubstrateExecPort,
  WorkspaceManagerPort,
} from '../domain/ports.js';
import { NOOP_LOGGER, type Logger } from '../domain/ports.js';
import type { Task, TaskStep, TaskWorkspace } from '../domain/types.js';
import type { HubStore } from '../store/types.js';

/**
 * The container-side workspace root — the repo lives here (a session's workspace
 * is bind-mounted at this fixed path, and #188's repo-clone runs at its root).
 * Verified in the substrate at `6291397`: `dockerManager.ts:418`
 * (`${WORKSPACE_ROOT}/${sessionId}:/home/developer/workspace`) and the exec cwd
 * default `dockerManager.ts:1262` (`WorkingDir: opts.workingDir ?? "/home/developer/workspace"`).
 */
const WORKSPACE_ROOT = '/home/developer/workspace';
/** Worktrees live under this dir inside the workspace root. */
const WORKTREE_ROOT = `${WORKSPACE_ROOT}/.hub-task-worktrees`;
/** Git plumbing execs are short; bounded well under the seam's 1 h backstop (FR-17). */
const GIT_EXEC_MS = 60_000;

/** The task's branch — `hub/task/<id>` — kept after cleanup so the commits survive (N6). */
export function taskBranch(taskId: string): string {
  return `hub/task/${taskId}`;
}
/**
 * The task's worktree path — ABSOLUTE. An absolute path is unambiguous as the
 * seam's `workingDir` (Docker resolves a relative `WorkingDir` against the image
 * WORKDIR, not a guarantee we depend on) and as a `git worktree add` target run
 * from the repo root (ADR-010 B, N5b-2).
 */
export function taskWorktreePath(taskId: string): string {
  return `${WORKTREE_ROOT}/${taskId}`;
}

/**
 * Recover a task's workspace descriptor from its existing steps' audited grants
 * (N6) — no git op. Used when a task resumes (user-requested changes) or reaches
 * a human-terminal state (approve/reject cleanup): its worktree already exists
 * and must not be re-created. Falls back to project-primary when no step recorded
 * a worktree grant (the strategy-A path, or a pre-N5b-2 task).
 */
export function workspaceFromSteps(steps: TaskStep[]): TaskWorkspace {
  const grant = [...steps].reverse().find((s) => s.workspaceAccess?.branch)?.workspaceAccess;
  return grant?.branch
    ? { strategy: 'worktree', branch: grant.branch, path: grant.path }
    : { strategy: 'project-primary', branch: null, path: null };
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
  openPullRequest(): Promise<{ url: string | null }> {
    // offline: no git, no gh, no real PR — the flow records "no URL"
    return Promise.resolve({ url: null });
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

  async openPullRequest(
    task: Task,
    workspace: TaskWorkspace,
    content: PullRequestContent,
  ): Promise<{ url: string | null }> {
    if (workspace.strategy !== 'worktree' || !workspace.branch) return { url: null }; // nothing to publish
    const sessionId = this.sessionFor(task);
    if (!sessionId) return { url: null };
    // push the task branch, then open the PR — both FROM the project session with
    // its own repo credential (ADR-010). branch/title/body ride as positional
    // params ($1..$3), never shell-interpreted; `gh pr create` prints the URL.
    const script =
      'set -e; git -C "$1" push -u origin "$2" >/dev/null; cd "$1"; gh pr create --head "$2" --title "$3" --body "$4"';
    const r = await runExec(this.execPort, sessionId, [
      'bash',
      '-c',
      script,
      'hub_pr',
      WORKSPACE_ROOT,
      workspace.branch,
      content.title,
      content.body,
    ]);
    if (r.error || r.exitCode !== 0) {
      // best-effort: a PR failure must NOT un-approve the task — record no URL
      this.logger.warn('task.pr_failed', {
        taskId: task.id,
        exitCode: r.exitCode,
        error: r.error ?? null,
      });
      return { url: null };
    }
    const url =
      r.stdout
        .split('\n')
        .map((l) => l.trim())
        .reverse()
        .find((l) => /^https?:\/\/\S+$/.test(l)) ?? null;
    return { url };
  }
}
