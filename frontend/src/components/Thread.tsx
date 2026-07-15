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
import { Inspector } from './Inspector.js';

interface LiveRun {
  runId: string;
  state: RunState;
  deltaText: string;
  killOutcome?: string;
  error?: string;
}

interface Props {
  conversation: Conversation;
  projectStatus: Project['status'];
  onBack: () => void;
}

const TERMINAL: RunState[] = ['completed', 'completed_with_denials', 'cancelled', 'failed'];

export function Thread({ conversation, projectStatus, onBack }: Props): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([]);
  const [liveRun, setLiveRun] = useState<LiveRun | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refetch = useCallback(async () => {
    const detail = await api.getConversation(conversation.id);
    setMessages(detail.messages);
    const lastRunId = detail.messages.findLast((m) => m.runId)?.runId;
    if (lastRunId) setRunDetail(await api.getRun(lastRunId));
  }, [conversation.id]);

  useEffect(() => {
    const onEvent = (e: SseEvent): void => {
      if (e.event === 'run.state') {
        const d = e.data as { runId: string; state: RunState; killOutcome?: string; error?: string };
        setLiveRun((prev) =>
          prev?.runId === d.runId
            ? { ...prev, state: d.state, killOutcome: d.killOutcome, error: d.error }
            : { runId: d.runId, state: d.state, deltaText: '', killOutcome: d.killOutcome, error: d.error },
        );
        if (TERMINAL.includes(d.state)) {
          void refetch().then(() => setLiveRun(null));
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

  const active = liveRun !== null && !TERMINAL.includes(liveRun.state);

  return (
    <>
      <main className="thread">
        <header>
          <button className="back" onClick={onBack} aria-label="Back">
            ‹
          </button>
          <h2>{conversation.title}</h2>
          <button className="mini" onClick={() => setInspectorOpen((v) => !v)}>
            {inspectorOpen ? 'Hide activity' : 'Activity'}
          </button>
        </header>

        <div className="messages">
          {messages.map((m) => (
            <div key={m.id} className={`msg msg-${m.role}`}>
              <pre>{m.content}</pre>
            </div>
          ))}
          {liveRun && (
            <div className="msg msg-assistant msg-live">
              {liveRun.deltaText !== '' && <pre>{liveRun.deltaText}</pre>}
              <RunStateBadge run={liveRun} />
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <footer className="composer">
          {sendError && <p className="error">{sendError} — message restored, try again.</p>}
          <textarea
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
