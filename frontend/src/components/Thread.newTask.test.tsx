// @vitest-environment jsdom
/**
 * The explicit early task split (#128, ADR-014): while the conversation has an
 * active task, the composer offers "New task ↗" — the deliberate escape hatch
 * that starts a NEW task in a fresh conversation, taking the draft with it.
 * With no active task (or only terminal ones) the affordance is absent:
 * ordinary messages route normally.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Thread } from './Thread.js';
import { api, type Conversation, type Task } from '../lib/api.js';

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getConversation: vi.fn(),
      conversationTasks: vi.fn(),
      getRun: vi.fn(),
    },
  };
});

// The initial load rides the stream's onRecover (REST recovery on connect) —
// fire it once on subscribe; live frames themselves are irrelevant here.
vi.mock('../lib/sse.js', () => ({
  subscribeConversation: (_id: string, _onEvent: unknown, onRecover: () => void) => {
    queueMicrotask(onRecover);
    return { close: () => {} };
  },
}));

// jsdom has no scrollIntoView; the thread auto-scrolls on mount
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const mockedApi = api as unknown as {
  getConversation: ReturnType<typeof vi.fn>;
  conversationTasks: ReturnType<typeof vi.fn>;
};

const CONVERSATION: Conversation = {
  id: 'c1',
  projectId: 'p1',
  title: 't',
  agentId: 'dev',
  mode: 'automatic',
  status: 'active',
};

function task(state: Task['state']): Task {
  return {
    id: 'task_1',
    projectId: 'p1',
    sourceConversationId: 'c1',
    sourceMessageId: 'm1',
    state,
    pullRequestUrl: null,
    createdAt: 't',
    updatedAt: 't',
  };
}

function renderThread(tasks: Task[], onStartNewTask = vi.fn().mockResolvedValue(true)) {
  mockedApi.getConversation.mockResolvedValue({
    conversation: CONVERSATION,
    messages: [],
    hasMore: false,
  });
  mockedApi.conversationTasks.mockResolvedValue({ tasks });
  render(
    <Thread
      conversation={CONVERSATION}
      projectStatus="ready"
      onBack={() => {}}
      onRenamed={() => {}}
      onStartNewTask={onStartNewTask}
      textSize="md"
      onCycleTextSize={() => {}}
      registerCommands={() => {}}
    />,
  );
  return { onStartNewTask };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the explicit early task split (#128, ADR-014)', () => {
  it('offers "New task" while a task is active, and hands the draft over on click', async () => {
    const { onStartNewTask } = renderThread([task('implementing')]);
    const button = await screen.findByRole('button', { name: /New task/ });

    const composer = screen.getByPlaceholderText(/Message the agent|Queue a follow-up/);
    await userEvent.type(composer, 'and also add dark mode');
    await userEvent.click(button);

    expect(onStartNewTask).toHaveBeenCalledWith('and also add dark mode');
    // the draft moved to the new conversation — the composer here is cleared
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(''));
  });

  it('keeps the draft when the split fails — nothing typed is ever lost', async () => {
    renderThread([task('implementing')], vi.fn().mockResolvedValue(false));
    const button = await screen.findByRole('button', { name: /New task/ });
    const composer = screen.getByPlaceholderText(/Message the agent|Queue a follow-up/);
    await userEvent.type(composer, 'a long task description');
    await userEvent.click(button);
    // the failure toast is App's; the composer must still hold the text
    expect((composer as HTMLTextAreaElement).value).toBe('a long task description');
  });

  it('is absent when the conversation has only terminal tasks (a new message routes normally)', async () => {
    renderThread([task('approved'), task('failed')]);
    await waitFor(() => expect(mockedApi.conversationTasks).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /New task/ })).toBeNull();
  });
});
