/**
 * Activity inspector (UX-02, 11 §4): the RunSummary at the top (FR-42) —
 * objective, outcome, continuation — then commands, files, denials, usage.
 * Never imposed: a side panel on Mac, a sheet on iPhone (UX-01).
 */

import type { RunDetail } from '../lib/api.js';

interface Props {
  open: boolean;
  detail: RunDetail | null;
  onClose: () => void;
}

export function Inspector({ open, detail, onClose }: Props): React.JSX.Element | null {
  if (!open) return null;
  if (!detail) {
    return (
      <aside className="inspector">
        <header>
          <h3>Activity</h3>
          <button className="mini" onClick={onClose} aria-label="Close activity">
            ×
          </button>
        </header>
        <p className="muted">No run yet.</p>
      </aside>
    );
  }
  const { run, activity, usage, summary } = detail;
  return (
    <aside className="inspector">
      <header>
        <h3>Activity</h3>
        <button className="mini" onClick={onClose} aria-label="Close activity">
          ×
        </button>
      </header>

      {summary && (
        <section className="summary">
          <h4>Run summary</h4>
          <dl>
            <dt>Objective</dt>
            <dd>{summary.objective}</dd>
            <dt>Outcome</dt>
            <dd className={`badge state-${summary.outcome}`}>{summary.outcome}</dd>
            <dt>Cost</dt>
            <dd>{summary.costUsd === null ? 'unknown' : `$${summary.costUsd.toFixed(4)}`}</dd>
            {summary.numTurns !== null && (
              <>
                <dt>Turns</dt>
                <dd>{summary.numTurns}</dd>
              </>
            )}
            {summary.durationMs !== null && (
              <>
                <dt>Duration</dt>
                <dd>{(summary.durationMs / 1000).toFixed(1)}s</dd>
              </>
            )}
            {summary.denialCount > 0 && (
              <>
                <dt>Denials</dt>
                <dd>{summary.denialCount}</dd>
              </>
            )}
          </dl>
          {summary.warnings.length > 0 && (
            <details>
              <summary>Warnings ({summary.warnings.length})</summary>
              <ul>
                {summary.warnings.map((w, i) => (
                  <li key={i}>
                    <code>{w}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      <section>
        <h4>Commands ({activity.commands.length})</h4>
        <ul className="mono">
          {activity.commands.map((c, i) => (
            <li key={i}>
              <code>{c}</code>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4>Files touched ({activity.files.length})</h4>
        <ul className="mono">
          {activity.files.map((f, i) => (
            <li key={i}>
              <code>{f}</code>
            </li>
          ))}
        </ul>
      </section>

      {activity.denials.length > 0 && (
        <section className="denials">
          <h4>Permission denials ({activity.denials.length})</h4>
          <ul className="mono">
            {activity.denials.map((d, i) => (
              <li key={i}>
                <code>{d}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {run.targetDecision && (
        <section className="routing">
          <h4>Routing decision</h4>
          <dl>
            <dt>Specialist</dt>
            <dd>{run.targetDecision.specialistId}</dd>
            <dt>Session</dt>
            <dd className="mono">
              <code>{run.targetDecision.selectedSessionId}</code>
            </dd>
            <dt>Strategy</dt>
            <dd>{run.targetDecision.workspaceStrategy}</dd>
            <dt>Reason</dt>
            <dd>{run.targetDecision.reason}</dd>
          </dl>
          {run.targetDecision.alternativesConsidered.length > 0 && (
            <details>
              <summary>
                Alternatives considered ({run.targetDecision.alternativesConsidered.length})
              </summary>
              <ul className="mono">
                {run.targetDecision.alternativesConsidered.map((a, i) => (
                  <li key={i}>
                    <code>{a}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {run.errorDetail && (
        <section className="denials">
          <h4>Error</h4>
          <p>
            <code>
              {run.errorCode}: {run.errorDetail}
            </code>
          </p>
        </section>
      )}

      {usage && usage.source !== 'result-event' && (
        <p className="muted">usage source: {usage.source}</p>
      )}
    </aside>
  );
}
