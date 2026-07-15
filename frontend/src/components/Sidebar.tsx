/**
 * Two-level sidebar (owner UX feedback 2026-07-15, refining 11 §4):
 * - Projects home: just the project list + creation.
 * - Inside a project: only that project's context — the project name as a
 *   dropdown switcher (jump to another project / back to all), its
 *   conversations, and a clear "new conversation" affordance.
 */

import { useEffect, useRef, useState } from 'react';
import type { Conversation, Project } from '../lib/api.js';

interface Props {
  projects: Project[];
  conversations: Conversation[];
  selectedProject: Project | null;
  selectedConversation: Conversation | null;
  onOpenProject: (p: Project) => void;
  onOpenConversation: (c: Conversation) => void;
  onCreateProject: (name: string) => void;
  onCreateConversation: () => void;
  onBackToProjects: () => void;
}

export function Sidebar(props: Props): React.JSX.Element {
  return props.selectedProject === null ? (
    <ProjectsHome {...props} />
  ) : (
    <ProjectPane {...props} project={props.selectedProject} />
  );
}

function StatusBadge({ project }: { project: Project }): React.JSX.Element | null {
  if (project.status === 'ready') return null;
  return <span className={`badge status-${project.status}`}>{project.status}</span>;
}

function ProjectsHome(props: Props): React.JSX.Element {
  const [newProjectName, setNewProjectName] = useState('');
  return (
    <nav className="sidebar">
      <h2>Projects</h2>
      <ul className="nav-list">
        {props.projects.map((p) => (
          <li key={p.id}>
            <button onClick={() => props.onOpenProject(p)}>
              <span>{p.name}</span>
              <StatusBadge project={p} />
            </button>
          </li>
        ))}
        {props.projects.length === 0 && <li className="empty-hint">No projects yet.</li>}
      </ul>
      <div className="new-item">
        <input
          value={newProjectName}
          onChange={(e) => setNewProjectName(e.target.value)}
          placeholder="New project name…"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newProjectName.trim() !== '') {
              props.onCreateProject(newProjectName.trim());
              setNewProjectName('');
            }
          }}
        />
      </div>
      <p className="palette-hint muted">⌘K / Ctrl+K — commands</p>
    </nav>
  );
}

function ProjectPane(props: Props & { project: Project }): React.JSX.Element {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!switcherOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSwitcherOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [switcherOpen]);

  const others = props.projects.filter((p) => p.id !== props.project.id);

  return (
    <nav className="sidebar">
      <div className="project-switcher" ref={switcherRef}>
        <button
          className="switcher-button"
          onClick={() => setSwitcherOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={switcherOpen}
        >
          <span className="switcher-name">{props.project.name}</span>
          <StatusBadge project={props.project} />
          <span className="chevron" aria-hidden>
            ▾
          </span>
        </button>
        {switcherOpen && (
          <div className="switcher-menu" role="listbox" aria-label="Switch project">
            {others.map((p) => (
              <button
                key={p.id}
                role="option"
                aria-selected={false}
                onClick={() => {
                  setSwitcherOpen(false);
                  props.onOpenProject(p);
                }}
              >
                <span>{p.name}</span>
                <StatusBadge project={p} />
              </button>
            ))}
            {others.length === 0 && <p className="empty-hint">No other projects.</p>}
            <div className="switcher-divider" />
            <button
              className="switcher-all"
              onClick={() => {
                setSwitcherOpen(false);
                props.onBackToProjects();
              }}
            >
              ‹ All projects
            </button>
          </div>
        )}
      </div>

      <h2>Conversations</h2>
      <ul className="nav-list">
        {props.conversations.map((c) => (
          <li key={c.id}>
            <button
              className={props.selectedConversation?.id === c.id ? 'selected' : ''}
              onClick={() => props.onOpenConversation(c)}
            >
              {c.title}
            </button>
          </li>
        ))}
        {props.conversations.length === 0 && (
          <li className="empty-hint">No conversations yet.</li>
        )}
      </ul>
      <button className="new-conversation" onClick={props.onCreateConversation}>
        + New conversation
      </button>
      <p className="palette-hint muted">⌘K / Ctrl+K — commands</p>
    </nav>
  );
}
