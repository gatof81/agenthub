/** Project switcher + conversation list (11 §4): the project is the entry point (ADR-005). */

import { useState } from 'react';
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
}

export function Sidebar(props: Props): React.JSX.Element {
  const [newProjectName, setNewProjectName] = useState('');

  return (
    <nav className="sidebar">
      <h2>Projects</h2>
      <ul>
        {props.projects.map((p) => (
          <li key={p.id}>
            <button
              className={props.selectedProject?.id === p.id ? 'selected' : ''}
              onClick={() => props.onOpenProject(p)}
            >
              <span>{p.name}</span>
              {p.status !== 'ready' && <span className={`badge status-${p.status}`}>{p.status}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="new-project">
        <input
          value={newProjectName}
          onChange={(e) => setNewProjectName(e.target.value)}
          placeholder="New project name"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newProjectName.trim() !== '') {
              props.onCreateProject(newProjectName.trim());
              setNewProjectName('');
            }
          }}
        />
      </div>

      {props.selectedProject && (
        <>
          <h2>
            Conversations
            <button className="mini" onClick={props.onCreateConversation} title="New conversation">
              +
            </button>
          </h2>
          <ul>
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
          </ul>
        </>
      )}
      <p className="palette-hint muted">⌘K / Ctrl+K — commands</p>
    </nav>
  );
}
