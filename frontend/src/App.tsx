/**
 * Agent Hub frontend shell (doc 11): project-first navigation (ADR-005) —
 * Mac three-pane layout (projects · conversation · inspector); the same
 * components collapse to the iPhone single-column flow via CSS (UX-07).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  clearToken,
  getToken,
  setToken,
  type Conversation,
  type Project,
  type SessionListing,
  type Specialist,
  type WorkspaceChoice,
  type WorkspaceTemplate,
} from './lib/api.js';
import { Sidebar } from './components/Sidebar.js';
import { Thread, type ThreadCommands } from './components/Thread.js';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette.js';
import { ArchivedView } from './components/ArchivedView.js';

function TokenGate({ onReady }: { onReady: () => void }): React.JSX.Element {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    setToken(value.trim());
    try {
      await api.agents(); // authenticated probe
      onReady();
    } catch {
      clearToken();
      setError('Token rejected');
    }
  };
  return (
    <div className="token-gate">
      <h1>Agent Hub</h1>
      <p>Enter the Hub API token.</p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
        placeholder="API token"
        autoFocus
      />
      <button onClick={() => void submit()} disabled={value.trim() === ''}>
        Connect
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState(getToken() !== null);
  // Behind Cloudflare Access (ADR-011), the browser's requests carry a signed
  // Access JWT that the backend verifies — no pasted token needed. Probe an
  // authenticated endpoint once with no token; a 200 means Access already
  // authorized us, so skip the token gate. A 401 (dev/local, no Access) falls
  // through to the gate. `probed` gates the first render so the form doesn't
  // flash before the probe resolves.
  const [probed, setProbed] = useState(getToken() !== null);
  useEffect(() => {
    if (authed) return;
    let cancelled = false;
    void api
      .agents()
      .then(() => {
        if (!cancelled) setAuthed(true);
      })
      .catch(() => {
        /* not behind Access → show the token gate */
      })
      .finally(() => {
        if (!cancelled) setProbed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [authed]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [templates, setTemplates] = useState<WorkspaceTemplate[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [threadCommands, setThreadCommands] = useState<ThreadCommands | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  // session discovery (N1, FR-48): null until the first fetch resolves
  const [sessionListing, setSessionListing] = useState<SessionListing | null>(null);
  // specialists (N3, ADR-008): reusable professional identities
  const [specialists, setSpecialists] = useState<Specialist[]>([]);

  const refreshProjects = useCallback(async () => {
    const { projects } = await api.listProjects();
    setProjects(projects);
    return projects;
  }, []);

  const refreshSpecialists = useCallback(async () => {
    const { specialists } = await api.listSpecialists();
    setSpecialists(specialists);
  }, []);

  // bind or create a specialist's personal session (N3b-1), then refresh
  const bindSpecialistSession = useCallback(
    async (specialistId: string, workspace: WorkspaceChoice) => {
      await api.bindSpecialistSession(specialistId, workspace);
      await refreshSpecialists();
    },
    [refreshSpecialists],
  );

  // start a direct conversation with a specialist (N3b-2) and open it
  const chatWithSpecialist = useCallback(async (specialistId: string) => {
    const { conversation } = await api.createSpecialistConversation(specialistId);
    setSelectedProject(null); // a specialist conversation has no project
    setSelectedConversation(conversation);
  }, []);

  useEffect(() => {
    if (!authed) return;
    void refreshProjects();
    void api.agents().then((r) => setAgents(r.agents));
    // a project must declare its workspace (ADR-006, FR-45) — offer the choice
    void api.workspaceTemplates().then((r) => setTemplates(r.workspaceTemplates));
    // discovery is read-only and non-critical: a seam hiccup must not take
    // the projects home down with it (FR-48; the list simply stays absent)
    void api
      .listSessions()
      .then(setSessionListing)
      .catch(() => setSessionListing(null));
    void api
      .listSpecialists()
      .then((r) => setSpecialists(r.specialists))
      .catch(() => setSpecialists([]));
  }, [authed, refreshProjects]);

  // poll provisioning projects until they settle (UC-01; SSE needs a conversation)
  useEffect(() => {
    if (!projects.some((p) => p.status === 'provisioning')) return;
    const t = setInterval(() => void refreshProjects(), 1200);
    return () => clearInterval(t);
  }, [projects, refreshProjects]);

  const openProject = useCallback(async (project: Project) => {
    setSelectedProject(project);
    setSelectedConversation(null);
    const detail = await api.getProject(project.id);
    setSelectedProject(detail.project);
    setConversations(detail.conversations);
  }, []);

  const createProject = useCallback(
    async (name: string, workspace: WorkspaceChoice) => {
      const defaultAgent = agents[0]?.id ?? 'dev';
      await api.createProject(name, defaultAgent, workspace);
      await refreshProjects();
      // a bind marks the session with its project (external_ref) and the
      // binding column — refresh so the Sessions list reflects it
      void api
        .listSessions()
        .then(setSessionListing)
        .catch(() => {});
    },
    [agents, refreshProjects],
  );

  const createConversation = useCallback(async () => {
    if (!selectedProject) return;
    const { conversation } = await api.createConversation(selectedProject.id);
    setConversations((prev) => [...prev, conversation]);
    setSelectedConversation(conversation);
  }, [selectedProject]);

  // A restore has to land in the view the user returns to, not just vanish
  // from the archived list. Projects reappear via refreshProjects(); a
  // restored CONVERSATION would not — `conversations` is populated only by
  // openProject(), so without re-reading the open project the sidebar keeps
  // its pre-restore snapshot and the user has to re-navigate to see the item
  // they just restored. "Restorable" has to mean it comes back where you look.
  const refreshAfterRestore = useCallback(async () => {
    await refreshProjects();
    if (selectedProject) {
      const detail = await api.getProject(selectedProject.id);
      setSelectedProject(detail.project);
      setConversations(detail.conversations);
    }
  }, [refreshProjects, selectedProject]);

  const backToProjects = useCallback(() => {
    setSelectedProject(null);
    setSelectedConversation(null);
    setConversations([]);
  }, []);

  const archiveProject = useCallback(
    async (project: Project) => {
      // FR-40 — archiving stops the session; confirm before that happens.
      // Reversible since FR-43, and the prompt must say so: claiming false
      // permanence is as misleading as implying it merely leaves the list.
      if (
        !window.confirm(
          `Archive "${project.name}"? Its session stops. You can restore it later from Archived.`,
        )
      ) {
        return;
      }
      await api.archiveProject(project.id);
      if (selectedProject?.id === project.id) backToProjects();
      await refreshProjects();
    },
    [selectedProject, backToProjects, refreshProjects],
  );

  const archiveConversation = useCallback(
    async (conversation: Conversation) => {
      // Confirm, and say it is recoverable (FR-43) — parity with the project path.
      if (
        !window.confirm(
          `Archive "${conversation.title}"? You can restore it later from Archived.`,
        )
      ) {
        return;
      }
      await api.archiveConversation(conversation.id);
      setConversations((prev) => prev.filter((c) => c.id !== conversation.id));
      setSelectedConversation((cur) => (cur?.id === conversation.id ? null : cur));
    },
    [],
  );

  // ⌘K / Ctrl+K opens the command palette (11 §4, B1-12)
  useEffect(() => {
    if (!authed) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [authed]);

  // the palette drives the same handlers as the pointer UI — no parallel paths
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const cmds: PaletteCommand[] = [];
    if (threadCommands) {
      if (threadCommands.sendDraft)
        cmds.push({ id: 'send', label: 'Send draft message', run: threadCommands.sendDraft });
      if (threadCommands.cancelRun)
        cmds.push({ id: 'cancel', label: 'Cancel active run', run: threadCommands.cancelRun });
      cmds.push({ id: 'compose', label: 'Focus composer', run: threadCommands.focusComposer });
      cmds.push({
        id: 'inspector',
        label: 'Toggle activity panel',
        run: threadCommands.toggleInspector,
      });
    }
    cmds.push({
      id: 'new-project',
      label: 'New project…',
      // the palette cannot ask two questions; it uses the first template and
      // the sidebar form is where a choice (template vs bind, FR-49) is made
      ...(templates[0]
        ? {
            input: {
              placeholder: 'Project name',
              run: (name: string) =>
                void createProject(name, { kind: 'template', id: templates[0]!.id }),
            },
          }
        : { hint: 'no workspace templates configured', run: () => {} }),
    });
    if (selectedProject?.status === 'ready') {
      cmds.push({
        id: 'new-conversation',
        label: 'New conversation',
        hint: selectedProject.name,
        run: () => void createConversation(),
      });
    }
    if (selectedProject) {
      cmds.push({ id: 'all-projects', label: 'Go to all projects', run: backToProjects });
      cmds.push({
        id: 'archive-project',
        label: `Archive project: ${selectedProject.name}`,
        run: () => void archiveProject(selectedProject),
      });
      if (selectedConversation) {
        cmds.push({
          id: 'archive-conversation',
          label: `Archive conversation: ${selectedConversation.title}`,
          run: () => void archiveConversation(selectedConversation),
        });
      }
    }
    for (const p of projects) {
      if (p.id === selectedProject?.id) continue;
      cmds.push({
        id: `jump-p-${p.id}`,
        label: `Jump to project: ${p.name}`,
        hint: p.status !== 'ready' ? p.status : undefined,
        run: () => void openProject(p),
      });
    }
    for (const c of conversations) {
      if (c.id === selectedConversation?.id) continue;
      cmds.push({
        id: `jump-c-${c.id}`,
        label: `Jump to conversation: ${c.title}`,
        hint: selectedProject?.name,
        run: () => setSelectedConversation(c),
      });
    }
    return cmds;
  }, [
    threadCommands,
    projects,
    conversations,
    selectedProject,
    selectedConversation,
    createProject,
    templates,
    createConversation,
    openProject,
    backToProjects,
    archiveProject,
    archiveConversation,
  ]);

  // wait for the Access probe before deciding gate-vs-app (avoids a flash)
  if (!authed && !probed) return <div className="token-gate" />;
  if (!authed) return <TokenGate onReady={() => setAuthed(true)} />;

  if (archivedOpen) {
    return (
      <div className="app archived-only">
        <ArchivedView
          onClose={() => setArchivedOpen(false)}
          onRestored={() => void refreshAfterRestore()}
        />
      </div>
    );
  }

  return (
    <div className={`app ${selectedConversation ? 'has-conversation' : ''}`}>
      <Sidebar
        onOpenArchived={() => setArchivedOpen(true)}
        sessionListing={sessionListing}
        specialists={specialists}
        onBindSpecialistSession={(id, w) => void bindSpecialistSession(id, w)}
        onChatWithSpecialist={(id) => void chatWithSpecialist(id)}
        projects={projects}
        conversations={conversations}
        selectedProject={selectedProject}
        selectedConversation={selectedConversation}
        onOpenProject={(p) => void openProject(p)}
        onOpenConversation={setSelectedConversation}
        templates={templates}
        onCreateProject={(name, workspace) => void createProject(name, workspace)}
        onCreateConversation={() => void createConversation()}
        onBackToProjects={backToProjects}
        onArchiveProject={(p) => void archiveProject(p)}
        onArchiveConversation={(c) => void archiveConversation(c)}
      />
      {selectedConversation ? (
        <Thread
          key={selectedConversation.id}
          conversation={selectedConversation}
          projectStatus={selectedProject?.status ?? 'ready'}
          onBack={() => setSelectedConversation(null)}
          registerCommands={setThreadCommands}
        />
      ) : (
        <main className="empty-state">
          <p>
            {selectedProject
              ? selectedProject.status === 'provisioning'
                ? 'Provisioning the project workspace…'
                : selectedProject.status === 'error'
                  ? 'Provisioning failed — check the project.'
                  : 'Pick or create a conversation.'
              : 'Pick or create a project.'}
          </p>
        </main>
      )}
      <CommandPalette
        open={paletteOpen}
        commands={paletteCommands}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}
