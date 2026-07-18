/**
 * Conversation thread (11 §4): streaming assistant output, distinct run
 * states (UX-03), optimistic send (11 §5), cancel whenever active (UX-04),
 * activity inspector as a peel-back detail (UX-01/02) — a side panel on
 * Mac, a tap-to-expand sheet on iPhone.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type Conversation,
  type Message,
  type Project,
  type RunDetail,
  type RunState,
  type TurnSegment,
} from '../lib/api.js';
import { subscribeConversation, type SseEvent } from '../lib/sse.js';
import {
  appendDelta,
  describeRunOutcome,
  describeStep,
  formatElapsed,
  isTerminalRun,
  reconcileLiveRun,
  type LiveRun,
  type LiveStep,
  type RunOutcome,
} from '../lib/runStatus.js';
import type { TextSize } from '../lib/textSize.js';
import { Inspector } from './Inspector.js';
import { Markdown } from './Markdown.js';

/** Contextual actions the thread exposes to the command palette (11 §4, B1-12). */
export interface ThreadCommands {
  focusComposer: () => void;
  /** null while unavailable (empty draft or project not ready); a non-empty
   *  draft sent during an active run queues behind it. */
  sendDraft: (() => void) | null;
  /** null unless a run is active. */
  cancelRun: (() => void) | null;
  toggleInspector: () => void;
}

interface Props {
  conversation: Conversation;
  projectStatus: Project['status'];
  onBack: () => void;
  /** the title changed — backend auto-title after the first message, or a rename */
  onRenamed: (conversation: Conversation) => void;
  /** reader-chosen text size (11 §11) and the cycler behind the header "Aa" */
  textSize: TextSize;
  onCycleTextSize: () => void;
  registerCommands: (commands: ThreadCommands | null) => void;
}

// While a run is shown active but its stream has gone silent this long, the
// watchdog re-reads the store — the belt for the un-replayable terminal frame.
const WATCHDOG_IDLE_MS = 15_000;
const WATCHDOG_TICK_MS = 5_000;

export function Thread({
  conversation,
  projectStatus,
  onBack,
  onRenamed,
  textSize,
  onCycleTextSize,
  registerCommands,
}: Props): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([]);
  const [liveRun, setLiveRun] = useState<LiveRun | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [draft, setDraft] = useState('');
  // `restored` is true only when the failing path put the draft back (send), so
  // the banner never claims a restore that did not happen (retry restores nothing).
  const [sendError, setSendError] = useState<{ text: string; restored: boolean } | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  // Runs sent while another is active queue behind it (the backend serializes
  // per workspace); their user message shows a "queued" pill until they start.
  const [queuedRunIds, setQueuedRunIds] = useState<Set<string>>(() => new Set());
  // A 1 s tick that re-renders the elapsed clock while a run is active.
  const [clock, setClock] = useState<number>(() => Date.now());
  // Whether the reader is pinned to the bottom — auto-scroll only follows new
  // content when they are, so scrolling up to re-read is never yanked back.
  const [atBottom, setAtBottom] = useState(true);
  // Whether older messages exist before the loaded page (E).
  const [hasMore, setHasMore] = useState(false);
  // Guards "load earlier" against a double-click that would prepend the same
  // batch twice — the ref blocks synchronously, the state disables the button.
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadingEarlierRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  atBottomRef.current = atBottom;
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Read through refs so refetch stays stable (keyed on conversation.id) and
  // the SSE subscription is not torn down every time the title updates.
  const onRenamedRef = useRef(onRenamed);
  onRenamedRef.current = onRenamed;
  const titleRef = useRef(conversation.title);
  titleRef.current = conversation.title;
  // The in-flight run, read through a ref so refetch (keyed on conversation.id)
  // can reconcile it without re-subscribing on every delta.
  const liveRunRef = useRef<LiveRun | null>(null);
  liveRunRef.current = liveRun;
  // When the tracked run last produced any SSE frame — the watchdog only polls
  // once the stream has genuinely gone quiet.
  const lastEventAtRef = useRef<number>(Date.now());

  const refetch = useCallback(async () => {
    const detail = await api.getConversation(conversation.id);
    setMessages(detail.messages);
    setHasMore(detail.hasMore);
    // The backend auto-titles a conversation from its first message; surface
    // that (and any out-of-band rename) once the run's refetch brings it back.
    if (detail.conversation.title !== titleRef.current) onRenamedRef.current(detail.conversation);
    // Reconcile against the store (NFR-07). Prefer the in-flight run over the
    // last message's run: a running turn has no persisted message yet, so
    // findLast(runId) would point at the PREVIOUS run and never settle the
    // live indicator. The terminal run.state frame is not replayable, so this
    // REST read is the only thing that clears a "Working…" whose frame was
    // missed (a socket drop around finalize, or no subscriber at that instant).
    const trackedRunId = liveRunRef.current?.runId ?? detail.messages.findLast((m) => m.runId)?.runId;
    if (trackedRunId) {
      const runDetail = await api.getRun(trackedRunId);
      setRunDetail(runDetail);
      setLiveRun((prev) => {
        const reconciled = reconcileLiveRun(prev, runDetail.run);
        // F: the conversation was opened mid-run — nothing live yet, but the
        // latest run is still active. Seed it (state + partial bubbles + start
        // time) so the working indicator, elapsed clock and partial text show
        // immediately; live SSE then continues appending to it.
        if (!prev && reconciled === null && !isTerminalRun(runDetail.run.state)) {
          return {
            runId: runDetail.run.id,
            state: runDetail.run.state,
            segments: runDetail.segments,
            startedAt: runDetail.run.startedAt ? Date.parse(runDetail.run.startedAt) : Date.now(),
          };
        }
        return reconciled;
      });
    }
  }, [conversation.id]);

  // Page older messages in (E): fetch the batch before the oldest loaded and
  // prepend it. The reader is not at the bottom, so auto-scroll won't jump.
  const loadEarlier = useCallback(async () => {
    const oldest = messages[0];
    if (!oldest || loadingEarlierRef.current) return;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    try {
      const older = await api.getConversation(conversation.id, { before: oldest.id });
      setMessages((prev) => [...older.messages, ...prev]);
      setHasMore(older.hasMore);
    } finally {
      loadingEarlierRef.current = false;
      setLoadingEarlier(false);
    }
  }, [conversation.id, messages]);

  const saveTitle = useCallback(async () => {
    const next = (editingTitle ?? '').trim();
    setEditingTitle(null);
    if (next === '' || next === conversation.title) return;
    try {
      const { conversation: updated } = await api.renameConversation(conversation.id, next);
      onRenamedRef.current(updated);
    } catch {
      /* a failed rename is non-critical — the old title stays */
    }
  }, [editingTitle, conversation.id, conversation.title]);

  useEffect(() => {
    const onEvent = (e: SseEvent): void => {
      lastEventAtRef.current = Date.now();
      if (e.event === 'run.state') {
        const d = e.data as { runId: string; state: RunState; killOutcome?: string; error?: string };
        setLiveRun((prev) => {
          // the tracked run's own transition
          if (prev && prev.runId === d.runId) {
            return { ...prev, state: d.state, killOutcome: d.killOutcome, error: d.error };
          }
          // a DIFFERENT run reporting while ours is still active → it is queued
          // behind us; don't let it hijack the live view (the old overwrite bug)
          if (prev && !isTerminalRun(prev.state)) return prev;
          // the stage is free → this run takes it, starting its elapsed clock
          return {
            runId: d.runId,
            state: d.state,
            segments: [],
            startedAt: Date.now(),
            killOutcome: d.killOutcome,
            error: d.error,
          };
        });
        // a queued run stops being "queued" once it starts running or ends
        if (d.state !== 'queued') {
          setQueuedRunIds((q) => {
            if (!q.has(d.runId)) return q;
            const next = new Set(q);
            next.delete(d.runId);
            return next;
          });
        }
        if (isTerminalRun(d.state)) {
          // refetch pulls the finalized message and reconciles the indicator to
          // the store's terminal state (→ null); it also settles the case where
          // this very frame was the one a reconnecting client had missed.
          void refetch();
        }
      } else if (e.event === 'message.delta') {
        // fold streamed text into the turn's bubbles (A)
        const d = e.data as { runId: string; text: string };
        setLiveRun((prev) =>
          prev && prev.runId === d.runId
            ? { ...prev, segments: appendDelta(prev.segments, d.text) }
            : { runId: d.runId, state: 'streaming', segments: appendDelta([], d.text), startedAt: Date.now() },
        );
      } else if (e.event === 'activity.item') {
        // a tool step closes the current text bubble and becomes its own segment
        // (A) — a multi-step turn reads as text → tool → text, not one blob
        const d = e.data as { runId: string } & LiveStep;
        setLiveRun((prev) =>
          prev && prev.runId === d.runId
            ? {
                ...prev,
                segments: [
                  ...prev.segments,
                  { kind: d.kind, detail: d.detail, ...(d.tool ? { tool: d.tool } : {}) },
                ],
              }
            : prev,
        );
        void api.getRun(d.runId).then(setRunDetail);
      } else if (e.event === 'run.summary' || e.event === 'run.usage') {
        const d = e.data as { runId: string };
        void api.getRun(d.runId).then(setRunDetail);
      }
    };
    const handle = subscribeConversation(conversation.id, onEvent, () => void refetch());
    return () => handle.close();
  }, [conversation.id, refetch]);

  // Auto-scroll follows new content ONLY when the reader is already at the
  // bottom — reading earlier output (scrolled up) is never interrupted.
  useEffect(() => {
    if (atBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, liveRun?.segments]);

  const onMessagesScroll = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    // 80px slack so a nearly-bottom reader still counts as pinned
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }, []);

  const jumpToLatest = useCallback(() => {
    setAtBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Post a message and light up its run — shared by the composer (send) and the
  // one-click retry of a cut turn (D). Optimistic render (11 §5), confirmed by
  // the 202 + run.state; a busy workspace queues the new run (B).
  const submit = useCallback(
    async (content: string, onError?: () => void) => {
      if (content === '') return;
      setSendError(null);
      const optimistic: Message = {
        id: `optimistic_${Date.now()}`,
        conversationId: conversation.id,
        role: 'user',
        content,
        runId: null,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimistic]);
      try {
        const res = await api.sendMessage(conversation.id, content);
        lastEventAtRef.current = Date.now();
        // tie the optimistic message to its run so a queued turn can show as such
        setMessages((prev) =>
          prev.map((m) => (m.id === optimistic.id ? { ...m, runId: res.runId } : m)),
        );
        const busy = liveRunRef.current !== null && !isTerminalRun(liveRunRef.current.state);
        if (busy) {
          setQueuedRunIds((q) => new Set(q).add(res.runId));
        } else {
          setLiveRun({ runId: res.runId, state: res.runState, segments: [], startedAt: Date.now() });
        }
      } catch (err) {
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        setSendError({
          text: err instanceof Error ? err.message : 'send failed',
          restored: onError !== undefined,
        });
        onError?.();
      }
    },
    [conversation.id],
  );

  const send = useCallback(() => {
    const content = draft.trim();
    if (content === '') return;
    setDraft('');
    void submit(content, () => setDraft(content)); // restore the draft if the send fails
  }, [draft, submit]);

  // Retry a cut turn (D): re-send the last user message. The runtime resumes the
  // session, so the agent continues with the context of its partial attempt.
  const retry = useCallback(() => {
    const lastUser = messages.findLast((m) => m.role === 'user');
    if (lastUser) void submit(lastUser.content);
  }, [messages, submit]);

  const cancel = useCallback(() => {
    if (liveRun) void api.cancelRun(liveRun.runId).catch(() => {});
  }, [liveRun]);

  const active = liveRun !== null && !isTerminalRun(liveRun.state);

  // The persistent terminal chip (11 §6): once a run settles, how it ended must
  // not vanish with the live badge. Derived from the authoritative run so a
  // failed/cancelled turn keeps a durable, labelled trace under the thread —
  // null while active, so it never competes with the live badge.
  const outcome: RunOutcome | null =
    !active && runDetail ? describeRunOutcome(runDetail.run, runDetail.summary) : null;

  // Run-level watchdog (belt to the SSE stall watchdog, which only catches a
  // dead socket). If a run is shown active but its stream has gone quiet past
  // WATCHDOG_IDLE_MS — the terminal frame lost on a still-open socket, or a run
  // genuinely stuck server-side — re-read the store and settle. A still-running
  // quiet turn (a long Bash step) reads back non-terminal and stays untouched.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (Date.now() - lastEventAtRef.current >= WATCHDOG_IDLE_MS) void refetch();
    }, WATCHDOG_TICK_MS);
    return () => clearInterval(timer);
  }, [active, liveRun?.runId, refetch]);

  // Tick the elapsed clock once a second while a run is active (a long turn
  // shows it is progressing, not hung).
  useEffect(() => {
    if (!active) return;
    setClock(Date.now());
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active, liveRun?.runId]);

  // palette registration (B1-12): stable wrappers over refs so re-registration
  // happens only when availability flips, not on every keystroke
  const sendRef = useRef(send);
  sendRef.current = send;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  // A non-empty draft can always be sent when the project is ready — if a run is
  // active it queues behind it rather than being blocked.
  const canSend = draft.trim() !== '' && projectStatus === 'ready';
  useEffect(() => {
    registerCommands({
      focusComposer: () => composerRef.current?.focus(),
      sendDraft: canSend ? () => void sendRef.current() : null,
      cancelRun: active ? () => cancelRef.current() : null,
      toggleInspector: () => setInspectorOpen((v) => !v),
    });
    return () => registerCommands(null);
  }, [registerCommands, canSend, active]);

  return (
    <>
      <main className="thread">
        <header>
          <button className="back" onClick={onBack} aria-label="Back">
            ‹
          </button>
          {editingTitle === null ? (
            // Heading stays a heading (landmark); the rename trigger is a real
            // button inside it so keyboard and AT users can rename too (a11y).
            <h2 className="thread-title-h">
              <button
                type="button"
                className="thread-title"
                title="Rename conversation"
                onClick={() => setEditingTitle(conversation.title)}
              >
                {conversation.title}
              </button>
            </h2>
          ) : (
            <input
              className="thread-title-edit"
              aria-label="Conversation name"
              autoFocus
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void saveTitle();
                } else if (e.key === 'Escape') {
                  setEditingTitle(null);
                }
              }}
            />
          )}
          <button
            className="mini text-size"
            onClick={onCycleTextSize}
            title={`Text size: ${textSize.toUpperCase()} — tap to change`}
            aria-label={`Text size ${textSize}, tap to change`}
          >
            <span className="text-size-a1">A</span>
            <span className="text-size-a2">A</span>
          </button>
          <button className="mini" onClick={() => setInspectorOpen((v) => !v)}>
            {inspectorOpen ? 'Hide activity' : 'Activity'}
          </button>
        </header>

        <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
          {hasMore && (
            <button
              type="button"
              className="load-earlier"
              onClick={loadEarlier}
              disabled={loadingEarlier}
            >
              {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
            </button>
          )}
          {messages.map((m) =>
            m.role === 'assistant' && m.segments ? (
              // a tool-using turn: ordered bubbles (text → tool → text), A
              <Fragment key={m.id}>
                <Segments segments={m.segments} />
              </Fragment>
            ) : (
              <div key={m.id} className={`msg msg-${m.role}`}>
                {m.role === 'assistant' ? <Markdown>{m.content}</Markdown> : <pre>{m.content}</pre>}
                {m.role === 'user' && m.runId && queuedRunIds.has(m.runId) && (
                  <span className="queued-pill">queued</span>
                )}
              </div>
            ),
          )}
          {liveRun && (
            <>
              <Segments segments={liveRun.segments} live />
              <div className="live-badge">
                <RunStateBadge run={liveRun} now={clock} />
              </div>
            </>
          )}
          {outcome && (
            <div className="run-outcome-row">
              <RunOutcomeChip outcome={outcome} onOpenActivity={() => setInspectorOpen(true)} />
              {outcome.tone !== 'ok' && (
                <button
                  type="button"
                  className="retry"
                  onClick={retry}
                  title="Re-send the last message — the agent resumes with its partial work"
                >
                  ↻ Retry
                </button>
              )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {!atBottom && (
          <button className="jump-latest" onClick={jumpToLatest} aria-label="Jump to latest">
            ↓ Latest
          </button>
        )}

        <footer className="composer">
          {sendError && (
            <p className="error">
              {sendError.text} — {sendError.restored ? 'message restored, try again.' : 'click Retry again.'}
            </p>
          )}
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={
              projectStatus !== 'ready'
                ? `Project is ${projectStatus}…`
                : active
                  ? 'Queue a follow-up… (runs after the current one)'
                  : 'Message the agent…'
            }
            disabled={projectStatus !== 'ready'}
          />
          <div className="composer-actions">
            {active && (
              <button className="cancel" onClick={cancel}>
                Cancel run
              </button>
            )}
            <button onClick={() => void send()} disabled={draft.trim() === '' || projectStatus !== 'ready'}>
              {active ? 'Queue' : 'Send'}
            </button>
          </div>
        </footer>
      </main>

      <Inspector open={inspectorOpen} detail={runDetail} onClose={() => setInspectorOpen(false)} />
    </>
  );
}

/** UX-03: every state visually distinct; UX-06: cancelled cost unknown.
 *  `now` is a 1 s tick so an active run shows a live elapsed clock. */
function RunStateBadge({ run, now }: { run: LiveRun; now: number }): React.JSX.Element {
  const labels: Record<RunState, string> = {
    queued: 'Queued — waiting for the project workspace',
    starting: 'Starting…',
    streaming: 'Working…',
    completed: 'Completed',
    completed_with_denials: 'Completed with denials — partial (see activity)',
    cancelled: `Cancelled${run.killOutcome ? ` (${run.killOutcome})` : ''} — cost unknown`,
    interrupted: 'Recovering…',
    failed: `Failed${run.error ? ` (${run.error})` : ''} — you can re-send`,
  };
  const ticking = run.state === 'starting' || run.state === 'streaming';
  const elapsed = ticking && run.startedAt ? formatElapsed(now - run.startedAt) : null;
  return (
    <span className={`badge state-${run.state}`}>
      {ticking && <span className="spinner" />}
      {labels[run.state]}
      {elapsed && <span className="elapsed">{elapsed}</span>}
    </span>
  );
}

/**
 * The persistent terminal chip (11 §6): how the last run ended, pinned under
 * the thread until the next turn — the durable trace the transient live badge
 * never left. Clicking opens the activity inspector for the full detail.
 */
function RunOutcomeChip({
  outcome,
  onOpenActivity,
}: {
  outcome: RunOutcome;
  onOpenActivity: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`run-outcome badge state-${outcome.state}`}
      onClick={onOpenActivity}
      title="Open activity"
    >
      <span className="run-outcome-label">{outcome.label}</span>
      {outcome.hint && <span className="run-outcome-hint">{outcome.hint}</span>}
    </button>
  );
}

/**
 * A turn as ordered bubbles (A, 11 §6): each run of assistant text is its own
 * Markdown bubble; the tool steps between them (L4 — Bash/Edit/Grep/… and
 * blocked tools) render as a grouped step list. So a multi-step turn reads as a
 * visible sequence — text → tool → text — instead of one growing blob. The same
 * component renders the live turn and a reloaded turn's persisted segments, so
 * they look identical. (An interactive approval pause is N6's job, not here.)
 */
function Segments({ segments, live }: { segments: TurnSegment[]; live?: boolean }): React.JSX.Element {
  const out: React.JSX.Element[] = [];
  for (let i = 0; i < segments.length; ) {
    const seg = segments[i]!;
    if (seg.kind === 'text') {
      out.push(
        <div key={i} className={`msg msg-assistant${live ? ' msg-live' : ''}`}>
          <Markdown>{seg.text}</Markdown>
        </div>,
      );
      i += 1;
    } else {
      const start = i;
      const steps: Exclude<TurnSegment, { kind: 'text' }>[] = [];
      while (i < segments.length && segments[i]!.kind !== 'text') {
        steps.push(segments[i] as Exclude<TurnSegment, { kind: 'text' }>);
        i += 1;
      }
      out.push(
        <ul key={`s${start}`} className="run-steps">
          {steps.map((s, j) => {
            const { icon, label } = describeStep(s);
            return (
              <li key={j} className={`step step-${s.kind}`}>
                <span className="step-icon" aria-hidden="true">
                  {icon}
                </span>
                <span className="step-label">{label}</span>
              </li>
            );
          })}
        </ul>,
      );
    }
  }
  return <>{out}</>;
}
