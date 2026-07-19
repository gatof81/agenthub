// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from './Sidebar.js';
import type { Project, WorkspaceTemplate } from '../lib/api.js';

afterEach(cleanup);

const TEMPLATES: WorkspaceTemplate[] = [{ id: 'tpl', name: 'Dev' }];

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Solo',
    status: 'ready',
    defaultAgentId: 'dev',
    sessionBinding: { sessionId: 's1' },
    ...over,
  };
}

function makeProps(over: Record<string, unknown> = {}): React.ComponentProps<typeof Sidebar> {
  return {
    sessionListing: null,
    specialists: [],
    onBindSpecialistSession: vi.fn(),
    onChatWithSpecialist: vi.fn(),
    projects: [],
    conversations: [],
    selectedProject: null,
    selectedConversation: null,
    onOpenProject: vi.fn(),
    onOpenConversation: vi.fn(),
    templates: TEMPLATES,
    onCreateProject: vi.fn(),
    onCreateConversation: vi.fn(),
    onBackToProjects: vi.fn(),
    onArchiveProject: vi.fn(),
    onArchiveConversation: vi.fn(),
    onOpenArchived: vi.fn(),
    ...over,
  } as React.ComponentProps<typeof Sidebar>;
}

describe('<Sidebar> projects home — create project', () => {
  it('keeps Create disabled until a name is entered, then creates with the chosen workspace', async () => {
    const onCreateProject = vi.fn();
    render(<Sidebar {...makeProps({ onCreateProject })} />);

    const button = screen.getByRole('button', { name: /create project/i });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(/new project name/i), 'My Project');
    expect(button).toBeEnabled();

    await userEvent.click(button);
    expect(onCreateProject).toHaveBeenCalledWith('My Project', { kind: 'template', id: 'tpl' });
  });
});

describe('<Sidebar> project switcher', () => {
  it('offers "All projects" instead of a dead-end when there are no other projects', async () => {
    const onBackToProjects = vi.fn();
    const p = project();
    render(
      <Sidebar {...makeProps({ selectedProject: p, projects: [p], onBackToProjects })} />,
    );

    // the switcher button is the one with the expanded state (not the back button)
    await userEvent.click(screen.getByRole('button', { name: /solo/i, expanded: false }));
    const allProjects = screen.getByRole('menuitem', { name: /all projects/i });
    expect(allProjects).toBeInTheDocument();

    await userEvent.click(allProjects);
    expect(onBackToProjects).toHaveBeenCalled();
  });
});
