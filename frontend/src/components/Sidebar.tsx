/**
 * Two-level sidebar (owner UX feedback 2026-07-15, refining 11 §4):
 * - Projects home: just the project list + creation.
 * - Inside a project: a clear back affordance (an arrow icon before the
 *   project name), the project name as a switcher dropdown (jump projects),
 *   its conversations, and a new-conversation affordance.
 * - Archive is the product's "delete" (reversible, keeps history; archiving
 *   a project stops its session, FR-40). Archived items leave the lists.
 */

import { useEffect, useRef, useState } from 'react';
import { ownerVisibleSessions } from '../lib/api.js';
import type {
  Conversation,
  Project,
  SessionListing,
  Specialist,
  WorkspaceChoice,
  WorkspaceTemplate,
} from '../lib/api.js';
import { ArchiveIcon, BackIcon } from './icons.js';

interface Props {
  /** session discovery (N1, FR-48, ADR-007); null until loaded / on seam hiccup */
  sessionListing: SessionListing | null;
  /** reusable professional identities (N3, ADR-008) */
  specialists: Specialist[];
  /** bind/create a specialist's personal session (N3b-1) */
  onBindSpecialistSession: (specialistId: string, workspace: WorkspaceChoice) => void;
  /** start a direct conversation with a specialist (N3b-2) */
  onChatWithSpecialist: (specialistId: string) => void;
  projects: Project[];
  conversations: Conversation[];
  selectedProject: Project | null;
  selectedConversation: Conversation | null;
  onOpenProject: (p: Project) => void;
  onOpenConversation: (c: Conversation) => void;
  templates: WorkspaceTemplate[];
  /** a project declares its workspace at creation (ADR-006, FR-45): a template to create from, or an existing session to bind (FR-49) */
  onCreateProject: (name: string, workspace: WorkspaceChoice) => void;
  onCreateConversation: () => void;
  onBackToProjects: () => void;
  onArchiveProject: (p: Project) => void;
  onArchiveConversation: (c: Conversation) => void;
  /** archive is reversible (FR-43) — the way back has to be reachable (UX-08) */
  onOpenArchived: () => void;
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

/** A workspace to create from or bind (ADR-006, FR-45/FR-49). */
type WorkspaceOption = { key: string; label: string; choice: WorkspaceChoice };

/** The workspace has no default (ADR-006): the first option is a starting
 * selection, not a fallback, and `choice` is null only when there is nothing to
 * pick (creation/bind stays disabled rather than sending a guess the API 422s). */
function useWorkspaceChoice(options: WorkspaceOption[]): {
  effectiveKey: string;
  setKey: (key: string) => void;
  choice: WorkspaceChoice | null;
} {
  const [key, setKey] = useState('');
  const effectiveKey = key || (options[0]?.key ?? '');
  const choice = options.find((o) => o.key === effectiveKey)?.choice ?? null;
  return { effectiveKey, setKey, choice };
}

/** The template-or-session picker. One option needs no menu — a single-option
 * select asks a question with one answer — so it renders nothing at ≤1 option. */
function WorkspaceSelect({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: WorkspaceOption[];
  value: string;
  onChange: (key: string) => void;
  ariaLabel: string;
}): React.JSX.Element | null {
  if (options.length <= 1) return null;
  return (
    <select
      className="template-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function ProjectsHome(props: Props): React.JSX.Element {
  const [newProjectName, setNewProjectName] = useState('');
  // The workspace has no default (ADR-006): the first option is a starting
  // selection, not a fallback — with nothing to choose from, creation is
  // disabled rather than sending a guess the API would 422. Since N2 the
  // choice is template-or-session (FR-49): binding an existing owner
  // session creates nothing and is listed first — it is the corrected
  // model's primary path (ADR-007).
  const bindableSessions = (props.sessionListing?.sessions ?? []).filter(
    (s) => s.projectId === null,
  );
  const workspaceOptions: WorkspaceOption[] = [
    ...bindableSessions.map((s) => ({
      key: `s:${s.sessionId}`,
      label: `Bind session: ${s.name}${s.ownerUsername !== null ? ` (${s.ownerUsername})` : ''}`,
      choice: { kind: 'session', id: s.sessionId } as WorkspaceChoice,
    })),
    ...props.templates.map((t) => ({
      key: `t:${t.id}`,
      label: `New session: ${t.name}`,
      choice: { kind: 'template', id: t.id } as WorkspaceChoice,
    })),
  ];
  const {
    effectiveKey,
    setKey: setWorkspaceKey,
    choice: effectiveChoice,
  } = useWorkspaceChoice(workspaceOptions);
  return (
    <nav className="sidebar">
      <h2>Projects</h2>
      <ul className="nav-list">
        {props.projects.map((p) => (
          <li key={p.id} className="nav-row">
            <button className="nav-main" onClick={() => props.onOpenProject(p)}>
              <span>{p.name}</span>
              <StatusBadge project={p} />
            </button>
            <button
              className="row-action"
              title="Archive project"
              aria-label={`Archive project ${p.name}`}
              onClick={() => props.onArchiveProject(p)}
            >
              <ArchiveIcon />
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
            if (e.key === 'Enter' && newProjectName.trim() !== '' && effectiveChoice !== null) {
              props.onCreateProject(newProjectName.trim(), effectiveChoice);
              setNewProjectName('');
            }
          }}
        />
        {/* The workspace is the project's and has no default (ADR-006, FR-45):
            bind an existing session (FR-49) or create from a template. */}
        <WorkspaceSelect
          options={workspaceOptions}
          value={effectiveKey}
          onChange={setWorkspaceKey}
          ariaLabel="Project workspace"
        />
        {workspaceOptions.length === 0 && (
          <p className="empty-hint">
            No workspace templates configured and no bindable sessions visible — a project cannot
            declare a workspace, so creation is disabled. Add <code>workspaceTemplates:</code> to
            the deployment config or create a session in Shared Terminal.
          </p>
        )}
      </div>
      {props.specialists.length > 0 && (
        <SpecialistsSection
          specialists={props.specialists}
          workspaceOptions={workspaceOptions}
          onBind={props.onBindSpecialistSession}
          onChat={props.onChatWithSpecialist}
        />
      )}
      {props.sessionListing !== null && <SessionsSection listing={props.sessionListing} />}
      <button className="archived-link" onClick={props.onOpenArchived}>
        Archived
      </button>
      <p className="palette-hint muted">⌘K / Ctrl+K — commands</p>
    </nav>
  );
}

/**
 * Specialists (N3, ADR-008): reusable professional identities — name, role,
 * capabilities, and their optional personal session (N3b-1). An unbound
 * specialist offers a bind control (an existing owner session, or create one).
 * Direct conversation with a specialist arrives in N3b-2.
 */
function SpecialistsSection({
  specialists,
  workspaceOptions,
  onBind,
  onChat,
}: {
  specialists: Specialist[];
  workspaceOptions: Array<{ key: string; label: string; choice: WorkspaceChoice }>;
  onBind: (specialistId: string, workspace: WorkspaceChoice) => void;
  onChat: (specialistId: string) => void;
}): React.JSX.Element {
  return (
    <>
      <h2>Specialists</h2>
      <ul className="nav-list">
        {specialists.map((s) => (
          <li key={s.id} className="nav-row">
            <div className="nav-main session-row">
              <span className="session-name">
                {s.name}
                {s.role !== null ? <span className="muted"> — {s.role}</span> : null}
              </span>
              {s.capabilities.length > 0 && (
                <span className="muted session-meta">{s.capabilities.join(' · ')}</span>
              )}
              {s.session !== null ? (
                <div className="specialist-bind">
                  <span
                    className={`badge session-${s.session.status === 'available' ? 'running' : 'stopped'}`}
                  >
                    session: {s.session.status}
                  </span>
                  <button className="mini" onClick={() => onChat(s.id)}>
                    Chat
                  </button>
                </div>
              ) : (
                <SpecialistBind
                  workspaceOptions={workspaceOptions}
                  onBind={(w) => onBind(s.id, w)}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Compact bind control for an unbound specialist (N3b-1). */
function SpecialistBind({
  workspaceOptions,
  onBind,
}: {
  workspaceOptions: WorkspaceOption[];
  onBind: (workspace: WorkspaceChoice) => void;
}): React.JSX.Element {
  const { effectiveKey, setKey, choice } = useWorkspaceChoice(workspaceOptions);
  if (workspaceOptions.length === 0) {
    return <span className="muted session-meta">no session or template to bind</span>;
  }
  return (
    <div className="specialist-bind">
      <WorkspaceSelect
        options={workspaceOptions}
        value={effectiveKey}
        onChange={setKey}
        ariaLabel="Specialist session"
      />
      <button
        className="mini"
        onClick={() => choice !== null && onBind(choice)}
        disabled={choice === null}
      >
        Bind session
      </button>
    </div>
  );
}

/**
 * Session discovery (N1, FR-48): the real sessions the model corrected
 * toward (ADR-007) — name, owner, state, and which project uses each.
 * Read-only in N1; binding arrives with N2, the terminal deep link with
 * shared-terminal#419.
 */
function SessionsSection({ listing }: { listing: SessionListing }): React.JSX.Element {
  // The owner's own sessions only: the Hub's generic `legacy-technical`
  // sessions exist to back a project and are noise here (ADR-007).
  const sessions = ownerVisibleSessions(listing);
  return (
    <>
      <h2>Sessions</h2>
      {listing.scope === 'own' && (
        <p className="empty-hint">
          Showing only the Hub identity's own sessions — the seam account has no admin flag, so
          the owner's sessions are not visible yet (ADR-007).
        </p>
      )}
      <ul className="nav-list">
        {sessions.map((s) => (
          <li key={s.sessionId} className="nav-row">
            <div className="nav-main session-row">
              <span className="session-name">{s.name}</span>
              <span className="muted session-meta">
                {s.ownerUsername ?? 'unknown owner'}
                {s.projectName !== null ? ` · project: ${s.projectName}` : ''}
              </span>
            </div>
            <span className={`badge session-${s.status}`}>{s.status}</span>
          </li>
        ))}
        {sessions.length === 0 && <li className="empty-hint">No sessions visible.</li>}
      </ul>
    </>
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
      <div className="project-header">
        <button
          className="back-arrow"
          title="All projects"
          aria-label="Back to all projects"
          onClick={props.onBackToProjects}
        >
          <BackIcon />
        </button>
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
            </div>
          )}
        </div>
        <button
          className="row-action"
          title="Archive project"
          aria-label={`Archive project ${props.project.name}`}
          onClick={() => props.onArchiveProject(props.project)}
        >
          <ArchiveIcon />
        </button>
      </div>

      <h2>Conversations</h2>
      <ul className="nav-list">
        {props.conversations.map((c) => (
          <li key={c.id} className="nav-row">
            <button
              className={`nav-main ${props.selectedConversation?.id === c.id ? 'selected' : ''}`}
              onClick={() => props.onOpenConversation(c)}
            >
              {c.title}
            </button>
            <button
              className="row-action"
              title="Archive conversation"
              aria-label={`Archive conversation ${c.title}`}
              onClick={() => props.onArchiveConversation(c)}
            >
              <ArchiveIcon />
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
      <button className="archived-link" onClick={props.onOpenArchived}>
        Archived
      </button>
      <p className="palette-hint muted">⌘K / Ctrl+K — commands</p>
    </nav>
  );
}
