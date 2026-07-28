// @vitest-environment jsdom
/**
 * Thread core behaviors (the component's first full suite — it was the
 * coverage gap #1): message rendering (including the run-less assistant
 * outcome notes, ADR-009), optimistic send with failure restore (11 §5),
 * the live run lifecycle off SSE frames (streaming badge, delta text,
 * terminal refetch), queue-behind-active (B), cancel (UX-04), and the
 * task kickoff affordance (N5b-2b). The SSE mock exposes the frame
 * handler so tests drive the stream directly; REST recovery fires once on
 * subscribe, exactly like the real client's connect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Thread } from './Thread.js';
import { api, type Conversation, type Message, type Task } from '../lib/api.js';

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getConversation: vi.fn(),
      conversationTasks: vi.fn(),
      sendMessage: vi.fn(),
      cancelRun: vi.fn(),
      getRun: vi.fn(),
    },
  };
});

/** The captured frame handler — tests push SSE frames through it. */
let emitFrame: ((e: unknown) => void) | null = null;
vi.mock('../lib/sse.js', () => ({
  subscribeConversation: (_id: string, onEvent: (e: unknown) => void, onRecover: () => void) => {
    emitFrame = onEvent;
    queueMicrotask(onRecover); // initial load rides REST recovery on connect
    return { close: () => {} };
  },
}));

// jsdom has no scrollIntoView; the thread auto-scrolls on new content
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const mockedApi = api as unknown as {
  getConversation: ReturnType<typeof vi.fn>;
  conversationTasks: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  cancelRun: ReturnType<typeof vi.fn>;
  getRun: ReturnType<typeof vi.fn>;
};

const CONVERSATION: Conversation = {
  id: 'c1',
  projectId: 'p1',
  title: 't',
  agentId: 'dev',
  mode: 'automatic',
  status: 'active',
};

function msg(over: Partial<Message> & { id: string }): Message {
  return {
    conversationId: 'c1',
    role: 'user',
    content: 'hello',
    runId: null,
    taskStepId: null,
    createdAt: '2026-07-27T00:00:00.000Z',
    ...over,
  };
}

function renderThread(messages: Message[] = [], tasks: Task[] = []) {
  mockedApi.getConversation.mockResolvedValue({
    conversation: CONVERSATION,
    messages,
    hasMore: false,
  });
  mockedApi.conversationTasks.mockResolvedValue({ tasks });
  // fetched on terminal/summary frames; the detail pane is not under test
  mockedApi.getRun.mockReturnValue(new Promise(() => {}));
  render(
    <Thread
      conversation={CONVERSATION}
      projectStatus="ready"
      onBack={() => {}}
      onRenamed={() => {}}
      onStartNewTask={() => Promise.resolve(true)}
      textSize="md"
      onCycleTextSize={() => {}}
      registerCommands={() => {}}
    />,
  );
}

const composer = () => screen.getByPlaceholderText(/Message the agent|Queue a follow-up/);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  emitFrame = null;
});

describe('Thread — rendering', () => {
  it('renders user and assistant messages, including a run-less assistant note (ADR-009)', async () => {
    renderThread([
      msg({ id: 'm1', content: 'implement X' }),
      msg({ id: 'm2', role: 'assistant', content: 'Started task tsk_1.', runId: 'run_1' }),
      // the outcome note: assistant, NO run — the Hub speaking for itself
      msg({ id: 'm3', role: 'assistant', content: 'Task tsk_1 passed QA and is awaiting your review.' }),
    ]);
    expect(await screen.findByText('implement X')).toBeTruthy();
    expect(screen.getByText(/Started task tsk_1/)).toBeTruthy();
    expect(screen.getByText(/awaiting your review/)).toBeTruthy();
  });

  it('hides task step prompts/outputs — the thread is the owner\'s conversation (#151)', async () => {
    renderThread([
      msg({ id: 'm1', content: 'implement X' }),
      msg({ id: 'm2', role: 'assistant', content: 'Started task tsk_1.', runId: 'run_1' }),
      // the dev step's prompt (a duplicate of the objective) and its output —
      // both hosted by the conversation, both marked with the step link
      msg({ id: 'm3', content: 'implement X', runId: 'run_2', taskStepId: 'step_1' }),
      msg({ id: 'm4', role: 'assistant', content: 'step output text', runId: 'run_2', taskStepId: 'step_1' }),
      msg({ id: 'm5', role: 'assistant', content: 'Task tsk_1 passed QA and is awaiting your review.' }),
    ]);
    expect(await screen.findByText(/awaiting your review/)).toBeTruthy();
    // exactly ONE bubble carries the objective — the duplicate step prompt is hidden
    expect(screen.getAllByText('implement X')).toHaveLength(1);
    expect(screen.queryByText('step output text')).toBeNull();
  });

  it('hangs the View-task affordance on the kickoff message (N5b-2b)', async () => {
    renderThread(
      [msg({ id: 'm1', content: 'implement X' })],
      [
        {
          id: 'task_1',
          projectId: 'p1',
          sourceConversationId: 'c1',
          sourceMessageId: 'm1',
          state: 'implementing',
          pullRequestUrl: null,
          createdAt: 't',
          updatedAt: 't',
        },
      ],
    );
    const affordance = await screen.findByRole('button', { name: /View task/ });
    expect(affordance.textContent).toContain('implementing');
  });
});

describe('Thread — optimistic send (11 §5)', () => {
  it('renders the message immediately, posts it, and clears the composer', async () => {
    mockedApi.sendMessage.mockResolvedValue({ messageId: 'm9', runId: 'run_9', runState: 'queued' });
    renderThread();
    await userEvent.type(composer(), 'do the thing');
    await userEvent.click(screen.getByRole('button', { name: /Send message/ }));

    expect(screen.getByText('do the thing')).toBeTruthy(); // optimistic, pre-202
    expect((composer() as HTMLTextAreaElement).value).toBe('');
    await waitFor(() => expect(mockedApi.sendMessage).toHaveBeenCalledWith('c1', 'do the thing'));
  });

  it('on failure: removes the optimistic message, restores the draft, says so', async () => {
    mockedApi.sendMessage.mockRejectedValue(new Error('seam down'));
    renderThread();
    await userEvent.type(composer(), 'important text');
    await userEvent.click(screen.getByRole('button', { name: /Send message/ }));

    await screen.findByText(/message restored/);
    expect((composer() as HTMLTextAreaElement).value).toBe('important text'); // never lost
    expect(screen.queryByText('important text', { selector: 'pre' })).toBeNull(); // bubble gone
  });
});

describe('Thread — the live run off SSE frames', () => {
  it('streaming frame lights the working badge; deltas append text; terminal refetches', async () => {
    renderThread([msg({ id: 'm1' })]);
    await screen.findByText('hello');
    const callsBefore = mockedApi.getConversation.mock.calls.length;

    act(() => emitFrame!({ event: 'run.state', data: { runId: 'run_1', state: 'streaming' } }));
    expect(await screen.findByText('Working…')).toBeTruthy();

    act(() => emitFrame!({ event: 'message.delta', data: { runId: 'run_1', text: 'partial answer' } }));
    expect(await screen.findByText(/partial answer/)).toBeTruthy();

    act(() => emitFrame!({ event: 'run.state', data: { runId: 'run_1', state: 'completed' } }));
    // the terminal frame is authoritative-state, not content: re-read the store
    await waitFor(() =>
      expect(mockedApi.getConversation.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it('cancel appears while active and posts the kill (UX-04)', async () => {
    mockedApi.cancelRun.mockResolvedValue({ accepted: true });
    renderThread();
    act(() => emitFrame!({ event: 'run.state', data: { runId: 'run_1', state: 'streaming' } }));
    const stop = await screen.findByRole('button', { name: /Cancel run/ });
    await userEvent.click(stop);
    expect(mockedApi.cancelRun).toHaveBeenCalledWith('run_1');
  });

  it('a send during an active run queues behind it (B): the queued pill shows', async () => {
    mockedApi.sendMessage.mockResolvedValue({ messageId: 'm9', runId: 'run_2', runState: 'queued' });
    renderThread();
    act(() => emitFrame!({ event: 'run.state', data: { runId: 'run_1', state: 'streaming' } }));
    await screen.findByText('Working…');

    await userEvent.type(composer(), 'follow-up');
    await userEvent.click(screen.getByRole('button', { name: /Queue message/ }));

    expect(await screen.findByText('queued')).toBeTruthy(); // the pill on the follow-up
    // the live stage still belongs to run_1
    expect(screen.getByText('Working…')).toBeTruthy();
  });
});
