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
} from '../lib/api.js';
import { subscribeConversation, type SseEvent } from '../lib/sse.js';
import {
  describeRunOutcome,
  isTerminalRun,
  reconcileLiveRun,
  type LiveRun,
  type RunOutcome,
} from '../lib/runStatus.js';
import type { TextSize } from '../lib/textSize.js';
import { Inspector } from './Inspector.js';
import { Markdown } from './Markdown.js';

/** Contextual actions the thread exposes to the command palette (11 §4, B1-12). */
export interface ThreadCommands {
  focusComposer: () => void;
  /** null while unavailable (empty draft, run active, or project not ready). */
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
  const [sendError, setSendError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
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
      setLiveRun((prev) => reconcileLiveRun(prev, runDetail.run));
    }
  }, [conversation.id]);

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
        setLiveRun((prev) =>
          prev?.runId === d.runId
            ? { ...prev, state: d.state, killOutcome: d.killOutcome, error: d.error }
            : { runId: d.runId, state: d.state, deltaText: '', killOutcome: d.killOutcome, error: d.error },
        );
        if (isTerminalRun(d.state)) {
          // refetch pulls the finalized message and reconciles the indicator to
          // the store's terminal state (→ null); it also settles the case where
          // this very frame was the one a reconnecting client had missed.
          void refetch();
        }
      } else if (e.event === 'message.delta') {
        const d = e.data as { runId: string; text: string };
        setLiveRun((prev) =>
          prev && prev.runId === d.runId
            ? { ...prev, deltaText: prev.deltaText + d.text }
            : { runId: d.runId, state: 'streaming', deltaText: d.text },
        );
      } else if (e.event === 'run.summary' || e.event === 'run.usage' || e.event === 'activity.item') {
        const d = e.data as { runId: string };
        void api.getRun(d.runId).then(setRunDetail);
      }
    };
    const handle = subscribeConversation(conversation.id, onEvent, () => void refetch());
    return () => handle.close();
  }, [conversation.id, refetch]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, liveRun?.deltaText]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (content === '') return;
    setDraft('');
    setSendError(null);
    // optimistic render (11 §5); confirmed by the 202 + run.state event
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
      setLiveRun({ runId: res.runId, state: res.runState, deltaText: '' });
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setDraft(content);
      setSendError(err instanceof Error ? err.message : 'send failed');
    }
  }, [conversation.id, draft]);

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

  // palette registration (B1-12): stable wrappers over refs so re-registration
  // happens only when availability flips, not on every keystroke
  const sendRef = useRef(send);
  sendRef.current = send;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  const canSend = draft.trim() !== '' && !active && projectStatus === 'ready';
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
            <h2
              className="thread-title"
              title="Rename conversation"
              onClick={() => setEditingTitle(conversation.title)}
            >
              {conversation.title}
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
            className={`mini text-size text-size-${textSize}`}
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

        <div className="messages">
          {messages.map((m) => (
            <div key={m.id} className={`msg msg-${m.role}`}>
              {m.role === 'assistant' ? <Markdown>{m.content}</Markdown> : <pre>{m.content}</pre>}
            </div>
          ))}
          {liveRun && (
            <div className="msg msg-assistant msg-live">
              {liveRun.deltaText !== '' && <Markdown>{liveRun.deltaText}</Markdown>}
              <RunStateBadge run={liveRun} />
            </div>
          )}
          {outcome && (
            <RunOutcomeChip outcome={outcome} onOpenActivity={() => setInspectorOpen(true)} />
          )}
          <div ref={bottomRef} />
        </div>

        <footer className="composer">
          {sendError && <p className="error">{sendError} — message restored, try again.</p>}
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
              projectStatus === 'ready' ? 'Message the agent…' : `Project is ${projectStatus}…`
            }
            disabled={projectStatus !== 'ready'}
          />
          {active ? (
            <button className="cancel" onClick={cancel}>
              Cancel run
            </button>
          ) : (
            <button onClick={() => void send()} disabled={draft.trim() === '' || projectStatus !== 'ready'}>
              Send
            </button>
          )}
        </footer>
      </main>

      <Inspector open={inspectorOpen} detail={runDetail} onClose={() => setInspectorOpen(false)} />
    </>
  );
}

/** UX-03: every state visually distinct; UX-06: cancelled cost unknown. */
function RunStateBadge({ run }: { run: LiveRun }): React.JSX.Element {
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
  return (
    <span className={`badge state-${run.state}`}>
      {(run.state === 'starting' || run.state === 'streaming') && <span className="spinner" />}
      {labels[run.state]}
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
