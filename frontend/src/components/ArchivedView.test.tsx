// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArchivedView } from './ArchivedView.js';
import { api, ApiError, type Conversation, type Project } from '../lib/api.js';

vi.mock('../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listProjects: vi.fn(),
      listArchivedConversations: vi.fn(),
      restoreProject: vi.fn(),
      restoreConversation: vi.fn(),
    },
  };
});

const mockedApi = api as unknown as {
  listProjects: ReturnType<typeof vi.fn>;
  listArchivedConversations: ReturnType<typeof vi.fn>;
  restoreProject: ReturnType<typeof vi.fn>;
  restoreConversation: ReturnType<typeof vi.fn>;
};

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Proj',
    status: 'archived',
    defaultAgentId: 'dev',
    sessionBinding: { sessionId: null },
    ...over,
  };
}

function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    projectId: null,
    title: 'Convo',
    agentId: 'dev',
    mode: 'direct',
    status: 'archived',
    ...over,
  };
}

beforeEach(() => {
  mockedApi.listProjects.mockReset().mockResolvedValue({ projects: [] });
  mockedApi.listArchivedConversations.mockReset().mockResolvedValue({ conversations: [] });
  mockedApi.restoreProject.mockReset();
  mockedApi.restoreConversation.mockReset();
});

afterEach(cleanup);

describe('<ArchivedView> restore success', () => {
  it('reloads both lists and notifies the parent after a successful restore', async () => {
    const onRestored = vi.fn();
    const p = project();
    mockedApi.listProjects.mockResolvedValue({ projects: [p] });
    mockedApi.restoreProject.mockResolvedValue({ project: { ...p, status: 'ready' } });

    render(<ArchivedView onClose={vi.fn()} onRestored={onRestored} />);
    const button = await screen.findByRole('button', { name: /^restore$/i });

    mockedApi.listProjects.mockClear();
    mockedApi.listArchivedConversations.mockClear();

    await userEvent.click(button);

    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(mockedApi.listProjects).toHaveBeenCalledTimes(1);
    expect(mockedApi.listArchivedConversations).toHaveBeenCalledTimes(1);
  });
});

describe('<ArchivedView> restore errors', () => {
  it('shows the permanent, unrecoverable message for session_gone', async () => {
    const p = project();
    mockedApi.listProjects.mockResolvedValue({ projects: [p] });
    mockedApi.restoreProject.mockRejectedValue(
      new ApiError(409, 'session_gone', 'gone'),
    );

    render(<ArchivedView onClose={vi.fn()} onRestored={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /^restore$/i }));

    expect(await screen.findByText(/cannot be restored/i)).toBeInTheDocument();
  });

  it('shows the step-order message for project_archived', async () => {
    const c = conversation();
    mockedApi.listArchivedConversations.mockResolvedValue({ conversations: [c] });
    mockedApi.restoreConversation.mockRejectedValue(
      new ApiError(409, 'project_archived', 'blocked'),
    );

    render(<ArchivedView onClose={vi.fn()} onRestored={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /^restore$/i }));

    expect(await screen.findByText(/restore its project first/i)).toBeInTheDocument();
  });

  it('falls back to the error message for any other code', async () => {
    const p = project();
    mockedApi.listProjects.mockResolvedValue({ projects: [p] });
    mockedApi.restoreProject.mockRejectedValue(
      new ApiError(500, 'boom', 'Something unexpected happened.'),
    );

    render(<ArchivedView onClose={vi.fn()} onRestored={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /^restore$/i }));

    expect(await screen.findByText('Something unexpected happened.')).toBeInTheDocument();
  });
});

describe('<ArchivedView> busy state', () => {
  it('disables the Restore button and labels it "Restoring…" while in flight', async () => {
    const p = project();
    mockedApi.listProjects.mockResolvedValue({ projects: [p] });
    let resolveRestore: (v: unknown) => void = () => {};
    mockedApi.restoreProject.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRestore = resolve;
        }),
    );

    render(<ArchivedView onClose={vi.fn()} onRestored={vi.fn()} />);
    const button = await screen.findByRole('button', { name: /^restore$/i });

    await userEvent.click(button);

    const busyButton = screen.getByRole('button', { name: /restoring/i });
    expect(busyButton).toBeDisabled();

    resolveRestore({ project: { ...p, status: 'ready' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^restore$/i })).toBeEnabled(),
    );
  });
});

describe('<ArchivedView> per-row isolation', () => {
  it('does not leak one row\'s error onto another row', async () => {
    const p1 = project({ id: 'p1', name: 'First' });
    const p2 = project({ id: 'p2', name: 'Second' });
    mockedApi.listProjects.mockResolvedValue({ projects: [p1, p2] });
    mockedApi.restoreProject.mockImplementation((id: string) =>
      id === 'p1'
        ? Promise.reject(new ApiError(409, 'session_gone', 'gone'))
        : Promise.resolve({ project: { ...p2, status: 'ready' } }),
    );

    render(<ArchivedView onClose={vi.fn()} onRestored={vi.fn()} />);
    await screen.findByText('First');
    const row1 = screen.getByText('First').closest('li')!;
    const row2 = screen.getByText('Second').closest('li')!;

    await userEvent.click(within(row1).getByRole('button', { name: /^restore$/i }));

    await within(row1).findByText(/cannot be restored/i);
    expect(within(row2).queryByText(/cannot be restored/i)).not.toBeInTheDocument();
    expect(within(row2).getByRole('button', { name: /^restore$/i })).toBeInTheDocument();
  });
});

describe('<ArchivedView> empty states', () => {
  it('shows the empty hint only for the projects list when conversations exist', async () => {
    mockedApi.listProjects.mockResolvedValue({ projects: [] });
    mockedApi.listArchivedConversations.mockResolvedValue({ conversations: [conversation()] });

    render(<ArchivedView onClose={vi.fn()} onRestored={vi.fn()} />);

    await screen.findByText('Convo');
    expect(screen.getAllByText('Nothing archived.')).toHaveLength(1);
  });

  it('shows the empty hint only for the conversations list when projects exist', async () => {
    mockedApi.listProjects.mockResolvedValue({ projects: [project()] });
    mockedApi.listArchivedConversations.mockResolvedValue({ conversations: [] });

    render(<ArchivedView onClose={vi.fn()} onRestored={vi.fn()} />);

    await screen.findByText('Proj');
    expect(screen.getAllByText('Nothing archived.')).toHaveLength(1);
  });
});
