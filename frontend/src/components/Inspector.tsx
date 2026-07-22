/**
 * Activity panel (UX-01/02, 11 §4): the conversation's RUN HISTORY, newest
 * first — the running turn on top with a live state, the already-executed ones
 * below with their outcome. Each entry expands to the full detail (summary,
 * the ordered step timeline, denials, routing, error) fetched on demand from
 * `GET /api/runs/:id`. This is where the tool noise lives now — the thread
 * keeps only the words (conversation-declutter). Never imposed: a side panel
 * on Mac, a sheet on iPhone (UX-01).
 */

import { useEffect, useRef, useState } from 'react';
import { api, type RunDetail, type RunHistoryEntry } from '../lib/api.js';
import {
  describeRunOutcome,
  describeStep,
  isTerminalRun,
  type LiveRun,
} from '../lib/runStatus.js';
import { formatRelativeTime } from '../lib/time.js';

interface Props {
  open: boolean;
  conversationId: string;
  /** bumped by the thread on run SSE frames, so the list tracks live progress */
  refreshKey: number;
  /** the in-flight run, so the top entry can show it is the one working */
  liveRun: LiveRun | null;
  /** entry to auto-expand — set when opened from a turn's steps chip */
  focusRunId: string | null;
  onClose: () => void;
}

export function Inspector({
  open,
  conversationId,
  refreshKey,
  liveRun,
  focusRunId,
  onClose,
}: Props): React.JSX.Element | null {
  const [entries, setEntries] = useState<RunHistoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  // out-of-order guards, same discipline as the thread's fetchRunDetail
  const listSeqRef = useRef(0);
  const detailSeqRef = useRef(0);
  // auto-expand happens once per open — after that the reader's collapse wins
  const autoExpandedRef = useRef(false);
  const detailRef = useRef<RunDetail | null>(null);
  detailRef.current = detail;

  useEffect(() => {
    if (!open) autoExpandedRef.current = false;
  }, [open]);

  // Follow the chip that opened the panel; re-focus if a different chip is
  // clicked while already open.
  useEffect(() => {
    if (open && focusRunId) {
      setExpandedId(focusRunId);
      autoExpandedRef.current = true;
    }
  }, [open, focusRunId]);

  useEffect(() => {
    if (!open) return;
    const seq = (listSeqRef.current += 1);
    void api.conversationRuns(conversationId).then((r) => {
      if (seq !== listSeqRef.current) return;
      setEntries(r.runs);
      setHasMore(r.hasMore);
      // nothing focused yet → the newest entry is the interesting one, once
      if (!autoExpandedRef.current) {
        autoExpandedRef.current = true;
        setExpandedId((cur) => cur ?? r.runs[0]?.run.id ?? null);
      }
    });
  }, [open, conversationId, refreshKey]);

  useEffect(() => {
    if (!open || !expandedId) {
      setDetail(null);
      return;
    }
    // an already-loaded terminal run cannot change — skip the refetch churn
    const cached = detailRef.current;
    if (cached && cached.run.id === expandedId && isTerminalRun(cached.run.state)) return;
    const seq = (detailSeqRef.current += 1);
    void api.getRun(expandedId).then((d) => {
      if (seq === detailSeqRef.current) setDetail(d);
    });
  }, [open, expandedId, refreshKey]);

  if (!open) return null;

  return (
    <aside className="inspector">
      <header>
        <h3>Activity</h3>
        <button className="mini" onClick={onClose} aria-label="Close activity">
          ×
        </button>
      </header>
      {entries.length === 0 && <p className="muted">No runs yet.</p>}
      <ol className="run-history">
        {entries.map((e) => (
          <RunHistoryRow
            key={e.run.id}
            entry={e}
            live={liveRun !== null && liveRun.runId === e.run.id && !isTerminalRun(liveRun.state)}
            expanded={expandedId === e.run.id}
            onToggle={() => setExpandedId((cur) => (cur === e.run.id ? null : e.run.id))}
            detail={detail && detail.run.id === e.run.id ? detail : null}
          />
        ))}
      </ol>
      {hasMore && <p className="muted">Showing the latest {entries.length} runs.</p>}
    </aside>
  );
}

function RunHistoryRow({
  entry,
  live,
  expanded,
  onToggle,
  detail,
}: {
  entry: RunHistoryEntry;
  live: boolean;
  expanded: boolean;
  onToggle: () => void;
  detail: RunDetail | null;
}): React.JSX.Element {
  const { run, summary } = entry;
  const outcome = describeRunOutcome(run, summary);
  const who = run.targetDecision?.specialistId ?? null;
  return (
    <li className={`run-entry${live ? ' run-entry-live' : ''}`}>
      <button
        type="button"
        className="run-entry-head"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className={`badge state-${run.state}`}>
          {live && <span className="spinner" />}
          {outcome ? outcome.label : run.state === 'queued' ? 'Queued' : 'Working…'}
        </span>
        <span className="run-entry-objective">{summary?.objective ?? ''}</span>
        <span className="run-entry-meta">
          {who && <span>@{who}</span>}
          {run.taskStepId && <span className="run-entry-task">task step</span>}
          {summary?.durationMs != null && <span>{(summary.durationMs / 1000).toFixed(1)}s</span>}
          {summary?.costUsd != null && <span>${summary.costUsd.toFixed(4)}</span>}
          {summary != null && summary.denialCount > 0 && (
            <span className="run-entry-denials">⛔ {summary.denialCount}</span>
          )}
          <time dateTime={run.createdAt} title={new Date(run.createdAt).toLocaleString()}>
            {formatRelativeTime(run.createdAt, Date.now())}
          </time>
        </span>
      </button>
      {expanded &&
        (detail ? <RunDetailSections detail={detail} /> : <p className="muted">Loading…</p>)}
    </li>
  );
}

/** One run in full: summary, the ordered step timeline, denials, routing, error. */
function RunDetailSections({ detail }: { detail: RunDetail }): React.JSX.Element {
  const { run, activity, usage, summary } = detail;
  return (
    <div className="run-entry-detail">
      {summary && (
        <section className="summary">
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

      {activity.items.length > 0 && (
        <section>
          <h4>Steps ({activity.items.length})</h4>
          <ul className="run-steps">
            {activity.items.map((s, i) => {
              const { icon, label } = describeStep(s);
              return (
                <li key={i} className={`step step-${s.kind}`}>
                  <span className="step-icon" aria-hidden="true">
                    {icon}
                  </span>
                  <span className="step-label">{label}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

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
    </div>
  );
}
