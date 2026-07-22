// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Inspector } from './Inspector.js';
import { api, type RunDetail, type RunHistoryEntry } from '../lib/api.js';

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      conversationRuns: vi.fn(),
      getRun: vi.fn(),
    },
  };
});

const mockedApi = api as unknown as {
  conversationRuns: ReturnType<typeof vi.fn>;
  getRun: ReturnType<typeof vi.fn>;
};

function entry(over: {
  id: string;
  state?: RunHistoryEntry['run']['state'];
  summary?: Partial<NonNullable<RunHistoryEntry['summary']>> | null;
  taskStepId?: string | null;
  specialistId?: string | null;
}): RunHistoryEntry {
  const state = over.state ?? 'completed';
  return {
    run: {
      id: over.id,
      conversationId: 'conv_1',
      messageId: `msg_${over.id}`,
      state,
      model: null,
      killOutcome: null,
      errorCode: null,
      errorDetail: null,
      targetDecision: over.specialistId
        ? {
            specialistId: over.specialistId,
            selectedSessionId: 'sess_1',
            reason: 'r',
            alternativesConsidered: [],
            workspaceStrategy: 'project-primary',
          }
        : null,
      taskStepId: over.taskStepId ?? null,
      createdAt: '2026-07-22T10:00:00.000Z',
      startedAt: null,
      endedAt: null,
    },
    summary:
      over.summary === null
        ? null
        : {
            objective: 'do the thing',
            outcome: state,
            costUsd: 0.12,
            numTurns: 3,
            durationMs: 4200,
            denialCount: 0,
            ...over.summary,
          },
  };
}

function detailFor(id: string, state: RunDetail['run']['state'] = 'completed'): RunDetail {
  return {
    run: {
      id,
      conversationId: 'conv_1',
      messageId: `msg_${id}`,
      state,
      killOutcome: null,
      errorCode: null,
      errorDetail: null,
      targetSessionId: null,
      targetDecision: null,
      startedAt: null,
    },
    activity: {
      commands: ['npm test'],
      files: [],
      denials: [],
      items: [
        { kind: 'command', detail: 'npm test', tool: 'Bash', seq: 1 },
        { kind: 'file', detail: 'src/a.ts', tool: 'Edit', seq: 2 },
      ],
    },
    segments: [],
    usage: null,
    summary: null,
  };
}

const baseProps = {
  open: true,
  conversationId: 'conv_1',
  refreshKey: 0,
  liveRun: null,
  focusRunId: null,
  onClose: () => {},
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Inspector — run history (activity panel)', () => {
  it('lists the runs newest-first as the API returns them, with outcome and meta', async () => {
    mockedApi.conversationRuns.mockResolvedValue({
      runs: [
        entry({ id: 'run_2', state: 'streaming', summary: null }),
        entry({ id: 'run_1', state: 'failed', summary: { outcome: 'failed' }, specialistId: 'dev' }),
      ],
      hasMore: false,
    });
    mockedApi.getRun.mockResolvedValue(detailFor('run_2', 'streaming'));
    render(<Inspector {...baseProps} />);

    await waitFor(() => expect(screen.getByText('Working…')).toBeTruthy());
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('@dev')).toBeTruthy();
    const heads = screen.getAllByRole('button', { name: /Working…|Failed/ });
    // newest (the working one) renders above the failed one
    expect(heads[0]!.textContent).toContain('Working…');
  });

  it('auto-expands the newest entry and shows its ordered step timeline', async () => {
    mockedApi.conversationRuns.mockResolvedValue({
      runs: [entry({ id: 'run_1' })],
      hasMore: false,
    });
    mockedApi.getRun.mockResolvedValue(detailFor('run_1'));
    render(<Inspector {...baseProps} />);

    await waitFor(() => expect(screen.getByText('Steps (2)')).toBeTruthy());
    expect(mockedApi.getRun).toHaveBeenCalledWith('run_1');
    expect(screen.getByText('Bash: npm test')).toBeTruthy();
    expect(screen.getByText('Edit: src/a.ts')).toBeTruthy();
  });

  it('focusRunId wins over the auto-expand — the chip-opened run is the expanded one', async () => {
    mockedApi.conversationRuns.mockResolvedValue({
      runs: [entry({ id: 'run_2' }), entry({ id: 'run_1' })],
      hasMore: false,
    });
    mockedApi.getRun.mockResolvedValue(detailFor('run_1'));
    render(<Inspector {...baseProps} focusRunId="run_1" />);

    await waitFor(() => expect(mockedApi.getRun).toHaveBeenCalledWith('run_1'));
    expect(mockedApi.getRun).not.toHaveBeenCalledWith('run_2');
  });

  it('expands an entry on click and collapses it again', async () => {
    mockedApi.conversationRuns.mockResolvedValue({
      runs: [entry({ id: 'run_2' }), entry({ id: 'run_1', summary: { objective: 'older turn' } })],
      hasMore: false,
    });
    mockedApi.getRun.mockImplementation((id: string) => Promise.resolve(detailFor(id)));
    render(<Inspector {...baseProps} />);
    await waitFor(() => expect(screen.getByText('Steps (2)')).toBeTruthy());

    const older = screen.getByText('older turn').closest('button')!;
    await userEvent.click(older);
    await waitFor(() => expect(mockedApi.getRun).toHaveBeenCalledWith('run_1'));
    expect(older.getAttribute('aria-expanded')).toBe('true');

    await userEvent.click(older);
    expect(older.getAttribute('aria-expanded')).toBe('false');
  });

  it('marks a task-step run and a denial count on the row', async () => {
    mockedApi.conversationRuns.mockResolvedValue({
      runs: [entry({ id: 'run_1', taskStepId: 'step_1', summary: { denialCount: 2 } })],
      hasMore: false,
    });
    mockedApi.getRun.mockResolvedValue(detailFor('run_1'));
    render(<Inspector {...baseProps} />);

    await waitFor(() => expect(screen.getByText('task step')).toBeTruthy());
    expect(screen.getByText('⛔ 2')).toBeTruthy();
  });

  it('renders nothing while closed and an empty state with no runs', async () => {
    mockedApi.conversationRuns.mockResolvedValue({ runs: [], hasMore: false });
    const { container } = render(<Inspector {...baseProps} open={false} />);
    expect(container.innerHTML).toBe('');
    expect(mockedApi.conversationRuns).not.toHaveBeenCalled();

    render(<Inspector {...baseProps} />);
    await waitFor(() => expect(screen.getByText('No runs yet.')).toBeTruthy());
  });
});
