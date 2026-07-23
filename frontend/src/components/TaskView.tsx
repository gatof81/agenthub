/**
 * TaskView (N5b-2b): one task's dev → QA → human-approval progress, opened from
 * the kickoff turn (A). Renders the task state, the ordered steps with their
 * DelegatedWorkspaceAccess grant (ADR-010), and the work products
 * (ImplementationReport / QaReport with its load-bearing verdict). Refetches
 * when `refreshKey` changes so it tracks live progress off the conversation's
 * run-state stream — no separate task socket.
 */

import { useEffect, useState } from 'react';
import {
  api,
  type DesignBrief,
  type ImplementationReport,
  type QaReport,
  type TaskDetail,
  type TaskState,
  type WorkProduct,
} from '../lib/api.js';

export type TaskTone = 'progress' | 'attention' | 'ok' | 'danger';

const STATE_TONE: Record<TaskState, TaskTone> = {
  planning: 'progress',
  implementing: 'progress',
  qa_pending: 'progress',
  qa_running: 'progress',
  changes_requested_by_qa: 'progress',
  changes_requested_by_user: 'attention',
  awaiting_human_approval: 'attention',
  approved: 'ok',
  rejected: 'danger',
  failed: 'danger',
};

/** The colour tone for a task state — shared with the kickoff-turn affordance. */
export function taskStateTone(state: TaskState): TaskTone {
  return STATE_TONE[state];
}

function stateLabel(s: TaskState): string {
  return s.replace(/_/g, ' ');
}

function isQa(body: ImplementationReport | QaReport | DesignBrief): body is QaReport {
  return 'verdict' in body;
}

function isDesign(body: ImplementationReport | QaReport | DesignBrief): body is DesignBrief {
  return 'approach' in body;
}

function List({ label, items }: { label: string; items: string[] }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="wp-field">
      <span className="wp-field-label">{label}</span>
      <ul className="wp-list">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

function WorkProductCard({ wp }: { wp: WorkProduct }): React.JSX.Element {
  const body = wp.body;
  if (isQa(body)) {
    const pass = body.verdict === 'passed';
    return (
      <div className="wp-card">
        <div className="wp-head">
          <span className="wp-kind">QA report</span>
          <span className={`badge task-state ${pass ? 'ok' : 'attention'}`}>{body.verdict.replace(/_/g, ' ')}</span>
        </div>
        <List label="Requirements reviewed" items={body.requirementsReviewed} />
        <List label="Tests run" items={body.testsRun} />
        <List label="Passed" items={body.passed} />
        <List label="Failed" items={body.failed} />
        <List label="Regressions" items={body.regressions} />
      </div>
    );
  }
  if (isDesign(body)) {
    // the architect consult's brief (ADR-015): advisory, read-only
    return (
      <div className="wp-card">
        <div className="wp-head">
          <span className="wp-kind">Design brief</span>
        </div>
        {body.approach && <p className="wp-summary">{body.approach}</p>}
        <List label="Constraints" items={body.constraints} />
        <List label="Risks" items={body.risks} />
        <List label="Out of scope" items={body.outOfScope} />
      </div>
    );
  }
  const impl = body as ImplementationReport;
  return (
    <div className="wp-card">
      <div className="wp-head">
        <span className="wp-kind">Implementation report</span>
      </div>
      {impl.summary && <p className="wp-summary">{impl.summary}</p>}
      <List label="Files changed" items={impl.filesChanged} />
      <List label="Commands run" items={impl.commandsRun} />
      <List label="Tests run" items={impl.testsRun} />
      <List label="Known risks" items={impl.knownRisks} />
    </div>
  );
}

export function TaskView({
  taskId,
  refreshKey,
  onClose,
}: {
  taskId: string;
  refreshKey?: number;
  onClose: () => void;
}): React.JSX.Element {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Approval actions (N6): the owner's verdict when awaiting_human_approval.
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [changeNote, setChangeNote] = useState<string | null>(null); // non-null → the note field is open

  useEffect(() => {
    let live = true;
    api
      .getTask(taskId)
      .then((d) => live && setDetail(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : 'failed to load task'));
    return () => {
      live = false;
    };
  }, [taskId, refreshKey, reload]);

  const act = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    setActionError(null);
    fn()
      .then(() => {
        setChangeNote(null);
        setReload((n) => n + 1); // re-read so the state badge + actions update
      })
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : 'action failed'))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal task-view"
        role="dialog"
        aria-modal="true"
        aria-label="Task"
        onClick={(e) => e.stopPropagation()}
      >
        {error && <p className="task-error">{error}</p>}
        {!detail && !error && <p className="task-loading">Loading task…</p>}
        {detail && (
          <>
            <div className="task-head">
              <div>
                <span className="task-title">Task</span>
                <code className="task-id">{detail.task.id}</code>
              </div>
              <span className={`badge task-state ${STATE_TONE[detail.task.state]}`}>
                {stateLabel(detail.task.state)}
              </span>
            </div>

            {detail.task.pullRequestUrl && (
              <a
                className="task-pr-link"
                href={detail.task.pullRequestUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                View pull request ↗
              </a>
            )}

            <div className="task-section">
              <h4 className="task-section-title">Steps</h4>
              {detail.steps.length === 0 && <p className="task-empty">No steps yet.</p>}
              <ol className="task-steps">
                {detail.steps.map((s) => (
                  <li key={s.id} className="task-step">
                    <span className={`step-kind ${s.kind}`}>
                      {s.kind === 'implementation' ? 'Implementation' : s.kind === 'design' ? 'Design' : 'QA'}
                    </span>
                    <span className="step-specialist">{s.specialistId}</span>
                    {s.workspaceAccess && (
                      <span className="step-access" title={s.workspaceAccess.path ?? undefined}>
                        {s.workspaceAccess.accessMode}
                        {s.workspaceAccess.branch ? ` · ${s.workspaceAccess.branch}` : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>

            <div className="task-section">
              <h4 className="task-section-title">Work products</h4>
              {detail.workProducts.length === 0 && <p className="task-empty">None yet.</p>}
              {detail.workProducts.map((wp) => (
                <WorkProductCard key={wp.id} wp={wp} />
              ))}
            </div>

            {detail.task.state === 'awaiting_human_approval' && (
              <div className="task-approval">
                <h4 className="task-section-title">Your verdict</h4>
                {actionError && <p className="task-error">{actionError}</p>}
                {changeNote === null ? (
                  <div className="task-verdict-actions">
                    <button
                      className="approve"
                      disabled={busy}
                      onClick={() => act(() => api.approveTask(detail.task.id))}
                    >
                      Approve
                    </button>
                    <button className="mini" disabled={busy} onClick={() => setChangeNote('')}>
                      Request changes
                    </button>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => act(() => api.rejectTask(detail.task.id))}
                    >
                      Reject
                    </button>
                  </div>
                ) : (
                  <div className="task-change-request">
                    <textarea
                      className="task-note"
                      placeholder="Describe the changes you want…"
                      value={changeNote}
                      onChange={(e) => setChangeNote(e.target.value)}
                      autoFocus
                    />
                    <div className="task-verdict-actions">
                      <button className="mini" disabled={busy} onClick={() => setChangeNote(null)}>
                        Cancel
                      </button>
                      <button
                        disabled={busy || changeNote.trim() === ''}
                        onClick={() => act(() => api.requestTaskChanges(detail.task.id, changeNote.trim()))}
                      >
                        Send request
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="modal-actions">
              <button className="mini" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
