/**
 * Conversation thread (11 §4): streaming assistant output, distinct run
 * states (UX-03), optimistic send (11 §5), cancel whenever active (UX-04),
 * activity inspector as a peel-back detail (UX-01/02) — a side panel on
 * Mac, a tap-to-expand sheet on iPhone.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type Conversation,
  type Message,
  type Project,
  type RunDetail,
  type RunState,
  type Task,
  type TurnSegment,
} from '../lib/api.js';
import { subscribeConversation, type SseEvent } from '../lib/sse.js';
import {
  appendDelta,
  collapseSegments,
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
import { formatRelativeTime } from '../lib/time.js';
import { Inspector } from './Inspector.js';
import { TaskView, taskStateTone } from './TaskView.js';
import { Markdown } from './Markdown.js';
import { CopyButton } from './CopyButton.js';
import { SendIcon, StopIcon } from './icons.js';

/**
 * The conversation SSE frames this handler consumes, as a discriminated union
 * keyed on `event`, so each payload is read with a checked type instead of a
 * per-branch `as` cast — one boundary assertion (`e as ConversationEvent`)
 * replaces four. It models the fields this handler reads from each 08 §3 frame,
 * not the full wire payload (e.g. `message.delta`'s `messageId` and
 * `run.state`'s `sweepResult` are carried on the wire but unused here).
 */
type ConversationEvent =
  | { event: 'run.state'; data: { runId: string; state: RunState; killOutcome?: string; error?: string } }
  | { event: 'message.delta'; data: { runId: string; text: string } }
  | { event: 'activity.item'; data: { runId: string } & LiveStep }
  | { event: 'run.summary' | 'run.usage'; data: { runId: string } };

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
  /**
   * The explicit early task split (#128, ADR-014): start a NEW task in a
   * fresh conversation, carrying the current draft as its first message.
   * Shown only while this conversation has an active task — everything typed
   * here steers that task (I-14); this is the deliberate escape hatch.
   * Resolves true only on success — the draft is cleared on that signal, so
   * a failed split never loses what the user typed.
   */
  onStartNewTask: (draft: string) => Promise<boolean>;
  /** reader-chosen text size (11 §11) and the cycler behind the header "Aa" */
  textSize: TextSize;
  onCycleTextSize: () => void;
  registerCommands: (commands: ThreadCommands | null) => void;
}

// While a run is shown active but its stream has gone silent this long, the
// watchdog re-reads the store — the belt for the un-replayable terminal frame.
const WATCHDOG_IDLE_MS = 15_000;
const WATCHDOG_TICK_MS = 5_000;

/** Task states that no longer hold the conversation (I-14): a new task may start. */
const TERMINAL_TASK_STATES: ReadonlySet<Task['state']> = new Set(['approved', 'rejected', 'failed', 'cancelled']);

export function Thread({
  conversation,
  projectStatus,
  onBack,
  onRenamed,
  onStartNewTask,
  textSize,
  onCycleTextSize,
  registerCommands,
}: Props): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([]);
  // Tasks this conversation spawned (N5b-2b): a "view task" affordance hangs on
  // the kickoff turn (matched by sourceMessageId); the open one refetches on
  // `taskRefresh` so it tracks live progress off the run-state stream.
  const [tasks, setTasks] = useState<Task[]>([]);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [taskRefresh, setTaskRefresh] = useState(0);
  const [liveRun, setLiveRun] = useState<LiveRun | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // The run a steps chip asked the activity panel to focus; null = just open.
  const [focusRunId, setFocusRunId] = useState<string | null>(null);
  // Bumped on run SSE frames so the activity panel refetches its history list.
  const [activityRefresh, setActivityRefresh] = useState(0);
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
  // The composer grows with its content up to a cap (11 §12) — a multi-line
  // draft is comfortable without a fixed tall box stealing the thread.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);
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
  // Every activity.item / run.summary / run.usage frame triggers a getRun, and
  // those responses can resolve out of order — an older, fuller-vs-thinner
  // snapshot could clobber a newer one. A monotonic token drops any response
  // that a later request has already superseded.
  const runDetailSeqRef = useRef(0);
  const fetchRunDetail = useCallback((runId: string) => {
    const seq = (runDetailSeqRef.current += 1);
    void api.getRun(runId).then((detail) => {
      if (seq === runDetailSeqRef.current) setRunDetail(detail);
    });
  }, []);

  const refetch = useCallback(async () => {
    const detail = await api.getConversation(conversation.id);
    // step-run prompts/outputs stay out of the thread (#151) — the owner's
    // messages, envelope notes and outcome notes are the conversation; step
    // detail lives in the task view. Tracking below still reads the full list.
    setMessages(detail.messages.filter((m) => !m.taskStepId));
    setHasMore(detail.hasMore);
    // pull the conversation's tasks (N5b-2b): drives the kickoff-turn affordance
    // and, for the open task view, its refetch. Best-effort — never blocks the thread.
    api.conversationTasks(conversation.id).then((r) => setTasks(r.tasks)).catch(() => {});
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
      const seq = (runDetailSeqRef.current += 1);
      const runDetail = await api.getRun(trackedRunId);
      if (seq === runDetailSeqRef.current) setRunDetail(runDetail);
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
      setMessages((prev) => [...older.messages.filter((m) => !m.taskStepId), ...prev]);
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
      const ev = e as ConversationEvent;
      if (ev.event === 'run.state') {
        const d = ev.data;
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
          // a step run finishing advances the task — nudge the open task view (N5b-2b)
          setTaskRefresh((n) => n + 1);
        }
        // any state change reorders/relabels the activity panel's history
        setActivityRefresh((n) => n + 1);
      } else if (ev.event === 'message.delta') {
        // fold streamed text into the turn's bubbles (A)
        const d = ev.data;
        setLiveRun((prev) =>
          prev && prev.runId === d.runId
            ? { ...prev, segments: appendDelta(prev.segments, d.text) }
            : { runId: d.runId, state: 'streaming', segments: appendDelta([], d.text), startedAt: Date.now() },
        );
      } else if (ev.event === 'activity.item') {
        // a tool step closes the current text bubble and becomes its own segment
        // (A) — a multi-step turn reads as text → tool → text, not one blob
        const d = ev.data;
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
        fetchRunDetail(d.runId);
        setActivityRefresh((n) => n + 1);
      } else if (ev.event === 'run.summary' || ev.event === 'run.usage') {
        const d = ev.data;
        fetchRunDetail(d.runId);
        setActivityRefresh((n) => n + 1);
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
        taskStepId: null,
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
        // "Busy" means a DIFFERENT run holds the live stage. If the SSE stream
        // already lit up THIS run while the POST was in flight, it is not queued
        // behind anything — don't mark it queued (it is already streaming) and
        // don't overwrite the live state SSE seeded.
        const live = liveRunRef.current;
        const busy = live !== null && live.runId !== res.runId && !isTerminalRun(live.state);
        if (busy) {
          setQueuedRunIds((q) => new Set(q).add(res.runId));
        } else if (live?.runId !== res.runId) {
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

  // Map a kickoff message → the task it spawned, so the affordance hangs on the
  // turn that started it (task.sourceMessageId is the user's task message).
  const taskByMessage = new Map<string, Task>(
    tasks.filter((t) => t.sourceMessageId).map((t) => [t.sourceMessageId!, t]),
  );

  // While a task is live, everything typed here steers it (I-14) — the "New
  // task" affordance is the explicit split ADR-014 reserves for the user.
  const activeTask = tasks.find((t) => !TERMINAL_TASK_STATES.has(t.state)) ?? null;

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
          {conversation.mode === 'automatic' ? (
            <span
              className="mode-badge"
              title="Automatic routing (N4b): the router picks the specialist for each message — see Activity for who ran and why."
            >
              Auto-routing
            </span>
          ) : (
            <span className="mode-badge direct" title={`Direct: pinned to ${conversation.agentId}`}>
              @{conversation.agentId}
            </span>
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

        {/* role="log" + polite live region: a screen reader announces new
            messages and the run's state changes as they stream in (a11y) */}
        <div
          className="messages"
          ref={messagesRef}
          onScroll={onMessagesScroll}
          role="log"
          aria-live="polite"
          aria-label="Conversation messages"
        >
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
              // a tool-using turn: its words as bubbles, its tool work folded
              // into a steps chip that opens the activity panel on this run
              // (conversation-declutter). The group is wrapped so its footer
              // has a container to anchor to, rather than floating as a bare
              // sibling in the scroll region.
              <div key={m.id} className="msg-turn">
                <Segments
                  segments={m.segments}
                  onOpenActivity={() => {
                    setFocusRunId(m.runId);
                    setInspectorOpen(true);
                  }}
                />
                <MessageMeta createdAt={m.createdAt} copyText={m.content} />
              </div>
            ) : (
              <div key={m.id} className={`msg msg-${m.role}`}>
                {m.role === 'assistant' ? <Markdown>{m.content}</Markdown> : <pre>{m.content}</pre>}
                {m.role === 'user' && m.runId && queuedRunIds.has(m.runId) && (
                  <span className="queued-pill">queued</span>
                )}
                {taskByMessage.has(m.id) && (
                  <button
                    type="button"
                    className="task-affordance"
                    onClick={() => setOpenTaskId(taskByMessage.get(m.id)!.id)}
                  >
                    View task
                    <span className={`badge task-state ${taskStateTone(taskByMessage.get(m.id)!.state)}`}>
                      {taskByMessage.get(m.id)!.state.replace(/_/g, ' ')}
                    </span>
                  </button>
                )}
                <MessageMeta
                  createdAt={m.createdAt}
                  copyText={m.role === 'assistant' ? m.content : undefined}
                />
              </div>
            ),
          )}
          {liveRun && (
            <>
              <Segments
                segments={liveRun.segments}
                live={!isTerminalRun(liveRun.state)}
                onOpenActivity={() => {
                  setFocusRunId(liveRun.runId);
                  setInspectorOpen(true);
                }}
              />
              <div className="live-badge">
                <RunStateBadge run={liveRun} now={clock} />
              </div>
            </>
          )}
          {outcome && (
            <div className="run-outcome-row">
              <RunOutcomeChip
                outcome={outcome}
                onOpenActivity={() => {
                  setFocusRunId(runDetail?.run.id ?? null);
                  setInspectorOpen(true);
                }}
              />
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
          <div className="composer-field">
            <textarea
              ref={composerRef}
              rows={1}
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
                    ? 'Queue a follow-up…'
                    : 'Message the agent…'
              }
              disabled={projectStatus !== 'ready'}
            />
            <div className="composer-actions">
              {activeTask && (
                <button
                  className="new-task-btn"
                  onClick={() => {
                    // clear only on success — a failed split keeps the draft
                    // here so the user can retry without retyping
                    void onStartNewTask(draft).then((ok) => {
                      if (ok) setDraft('');
                    });
                  }}
                  disabled={projectStatus !== 'ready'}
                  title="Messages here steer the running task — this starts a NEW task in a fresh conversation, taking your draft with it"
                >
                  New task ↗
                </button>
              )}
              {active && (
                <button
                  className="icon-btn stop"
                  onClick={cancel}
                  title="Cancel run"
                  aria-label="Cancel run"
                >
                  <StopIcon />
                </button>
              )}
              <button
                className="icon-btn send"
                onClick={() => void send()}
                disabled={draft.trim() === '' || projectStatus !== 'ready'}
                title={active ? 'Queue message' : 'Send message'}
                aria-label={active ? 'Queue message' : 'Send message'}
              >
                <SendIcon />
              </button>
            </div>
          </div>
        </footer>
      </main>

      <Inspector
        open={inspectorOpen}
        conversationId={conversation.id}
        refreshKey={activityRefresh}
        liveRun={liveRun}
        focusRunId={focusRunId}
        onClose={() => {
          setInspectorOpen(false);
          setFocusRunId(null);
        }}
      />
      {openTaskId && (
        <TaskView taskId={openTaskId} refreshKey={taskRefresh} onClose={() => setOpenTaskId(null)} />
      )}
    </>
  );
}

/** A message's footer (11 §15): a relative timestamp (absolute on hover) and,
 *  for assistant messages, a copy-the-whole-message affordance. */
function MessageMeta({
  createdAt,
  copyText,
}: {
  createdAt: string;
  copyText?: string;
}): React.JSX.Element {
  return (
    <div className="msg-meta">
      <time className="msg-time" dateTime={createdAt} title={new Date(createdAt).toLocaleString()}>
        {formatRelativeTime(createdAt, Date.now())}
      </time>
      {copyText !== undefined && copyText !== '' && (
        <CopyButton text={copyText} className="msg-copy" label="Copy" ariaLabel="Copy message" />
      )}
    </div>
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
 * A turn as ordered bubbles (A, 11 §6), DECLUTTERED: each run of assistant
 * text is its own Markdown bubble, but the tool steps between them fold into a
 * compact "N steps" chip that opens the activity panel on this run — the full
 * ordered timeline lives there now, not in the thread. Two exceptions stay in
 * the conversation because the reader may need them:
 *
 * - denials (⛔) render individually — a blocked tool can require the owner
 *   to act (allowlist change), so it must not hide behind a count;
 * - on the LIVE turn, the trailing group also shows its current step as a
 *   single replaced line — "what is it doing right now", without the noise
 *   of an accumulating list.
 */
function Segments({
  segments,
  live,
  onOpenActivity,
}: {
  segments: TurnSegment[];
  live?: boolean;
  onOpenActivity: () => void;
}): React.JSX.Element {
  const collapsed = collapseSegments(segments);
  return (
    <>
      {collapsed.map((seg, i) => {
        if (seg.kind === 'text') {
          return (
            <div key={i} className={`msg msg-assistant${live ? ' msg-live' : ''}`}>
              <Markdown>{seg.text}</Markdown>
            </div>
          );
        }
        const isTrailing = i === collapsed.length - 1;
        const current = live && isTrailing ? describeStep(seg.current) : null;
        return (
          <div key={i} className="steps-fold">
            {seg.denials.map((d, j) => {
              const { icon, label } = describeStep(d);
              return (
                <span key={j} className="step step-denial">
                  <span className="step-icon" aria-hidden="true">
                    {icon}
                  </span>
                  <span className="step-label">{label}</span>
                </span>
              );
            })}
            <button
              type="button"
              className="steps-chip"
              onClick={onOpenActivity}
              title="Open activity"
            >
              ⚙ {seg.count} step{seg.count === 1 ? '' : 's'}
            </button>
            {current && (
              <span className={`step step-current step-${seg.current.kind}`}>
                <span className="step-icon" aria-hidden="true">
                  {current.icon}
                </span>
                <span className="step-label">{current.label}</span>
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
