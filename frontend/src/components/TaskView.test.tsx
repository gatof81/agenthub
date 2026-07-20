// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskView } from './TaskView.js';
import { api, type TaskDetail } from '../lib/api.js';

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getTask: vi.fn(),
      approveTask: vi.fn(),
      rejectTask: vi.fn(),
      requestTaskChanges: vi.fn(),
    },
  };
});

const mockedApi = api as unknown as {
  getTask: ReturnType<typeof vi.fn>;
  approveTask: ReturnType<typeof vi.fn>;
  rejectTask: ReturnType<typeof vi.fn>;
  requestTaskChanges: ReturnType<typeof vi.fn>;
};

function detail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    task: {
      id: 'task_1',
      projectId: 'p1',
      sourceConversationId: 'c1',
      sourceMessageId: 'm1',
      state: 'awaiting_human_approval',
      createdAt: 't',
      updatedAt: 't',
    },
    steps: [
      {
        id: 's0',
        taskId: 'task_1',
        seq: 0,
        kind: 'implementation',
        specialistId: 'dev',
        workspaceAccess: {
          accessMode: 'worktree-write',
          branch: 'hub/task/task_1',
          path: '/home/developer/workspace/.hub-task-worktrees/task_1',
          pathBounds: [],
          expiresAt: null,
        },
        createdAt: 't',
      },
      { id: 's1', taskId: 'task_1', seq: 1, kind: 'qa', specialistId: 'qa', workspaceAccess: null, createdAt: 't' },
    ],
    workProducts: [
      {
        id: 'wp0',
        taskId: 'task_1',
        taskStepId: 's0',
        kind: 'implementation_report',
        producerSpecialistId: 'dev',
        runId: 'run_x',
        body: {
          objective: 'add X',
          summary: 'implemented X',
          filesChanged: ['a.ts'],
          commandsRun: ['npm test'],
          testsRun: ['unit'],
          knownRisks: [],
          commitOrPatch: null,
        },
        createdAt: 't',
      },
      {
        id: 'wp1',
        taskId: 'task_1',
        taskStepId: 's1',
        kind: 'qa_report',
        producerSpecialistId: 'qa',
        runId: 'run_y',
        body: {
          requirementsReviewed: ['R1'],
          testsRun: ['npm test'],
          passed: ['npm test'],
          failed: [],
          regressions: [],
          verdict: 'passed',
        },
        createdAt: 't',
      },
    ],
    ...over,
  };
}

afterEach(cleanup);

describe('TaskView (N5b-2b)', () => {
  it('renders the task state, steps with their grant, and both work products', async () => {
    mockedApi.getTask.mockResolvedValue(detail());
    render(<TaskView taskId="task_1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('awaiting human approval')).toBeInTheDocument());
    // steps + the worktree grant surfaced
    expect(screen.getByText('Implementation')).toBeInTheDocument();
    expect(screen.getByText('QA')).toBeInTheDocument();
    expect(screen.getByText(/worktree-write · hub\/task\/task_1/)).toBeInTheDocument();
    // work products, including the QA verdict
    expect(screen.getByText('Implementation report')).toBeInTheDocument();
    expect(screen.getByText('implemented X')).toBeInTheDocument();
    expect(screen.getByText('QA report')).toBeInTheDocument();
    expect(screen.getByText('passed')).toBeInTheDocument();
  });

  it('refetches when refreshKey changes (live progress)', async () => {
    mockedApi.getTask.mockResolvedValue(detail());
    const { rerender } = render(<TaskView taskId="task_1" refreshKey={0} onClose={() => {}} />);
    await waitFor(() => expect(mockedApi.getTask).toHaveBeenCalled());
    const before = mockedApi.getTask.mock.calls.length;

    rerender(<TaskView taskId="task_1" refreshKey={1} onClose={() => {}} />);
    await waitFor(() => expect(mockedApi.getTask.mock.calls.length).toBeGreaterThan(before));
  });

  it('closes on the Close button', async () => {
    mockedApi.getTask.mockResolvedValue(detail());
    const onClose = vi.fn();
    render(<TaskView taskId="task_1" onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('Close')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the verdict actions only when awaiting_human_approval', async () => {
    mockedApi.getTask.mockResolvedValue(detail({ task: { ...detail().task, state: 'approved' } }));
    render(<TaskView taskId="task_1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('approved')).toBeInTheDocument());
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
  });

  it('approve calls the API and re-reads the task', async () => {
    mockedApi.getTask.mockResolvedValue(detail());
    mockedApi.approveTask.mockResolvedValue({ task: { ...detail().task, state: 'approved' } });
    render(<TaskView taskId="task_1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Approve')).toBeInTheDocument());
    const before = mockedApi.getTask.mock.calls.length;
    await userEvent.click(screen.getByText('Approve'));
    expect(mockedApi.approveTask).toHaveBeenCalledWith('task_1');
    await waitFor(() => expect(mockedApi.getTask.mock.calls.length).toBeGreaterThan(before));
  });

  it('request changes reveals a note field and sends it', async () => {
    mockedApi.getTask.mockResolvedValue(detail());
    mockedApi.requestTaskChanges.mockResolvedValue({ task: { ...detail().task, state: 'changes_requested_by_user' } });
    render(<TaskView taskId="task_1" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Request changes')).toBeInTheDocument());
    await userEvent.click(screen.getByText('Request changes'));
    const box = await screen.findByPlaceholderText(/Describe the changes/);
    await userEvent.type(box, 'rename foo to bar');
    await userEvent.click(screen.getByText('Send request'));
    expect(mockedApi.requestTaskChanges).toHaveBeenCalledWith('task_1', 'rename foo to bar');
  });
});
