/**
 * Agent Hub frontend shell (doc 11): project-first navigation (ADR-005) —
 * Mac three-pane layout (projects · conversation · inspector); the same
 * components collapse to the iPhone single-column flow via CSS (UX-07).
 */

import { useCallback, useEffect, useState } from 'react';
import { api, clearToken, getToken, setToken, type Conversation, type Project } from './lib/api.js';
import { Sidebar } from './components/Sidebar.js';
import { Thread } from './components/Thread.js';

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
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);

  const refreshProjects = useCallback(async () => {
    const { projects } = await api.listProjects();
    setProjects(projects);
    return projects;
  }, []);

  useEffect(() => {
    if (!authed) return;
    void refreshProjects();
    void api.agents().then((r) => setAgents(r.agents));
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
    async (name: string) => {
      const defaultAgent = agents[0]?.id ?? 'dev';
      await api.createProject(name, defaultAgent);
      await refreshProjects();
    },
    [agents, refreshProjects],
  );

  const createConversation = useCallback(async () => {
    if (!selectedProject) return;
    const { conversation } = await api.createConversation(selectedProject.id);
    setConversations((prev) => [...prev, conversation]);
    setSelectedConversation(conversation);
  }, [selectedProject]);

  if (!authed) return <TokenGate onReady={() => setAuthed(true)} />;

  return (
    <div className={`app ${selectedConversation ? 'has-conversation' : ''}`}>
      <Sidebar
        projects={projects}
        conversations={conversations}
        selectedProject={selectedProject}
        selectedConversation={selectedConversation}
        onOpenProject={(p) => void openProject(p)}
        onOpenConversation={setSelectedConversation}
        onCreateProject={(name) => void createProject(name)}
        onCreateConversation={() => void createConversation()}
      />
      {selectedConversation ? (
        <Thread
          key={selectedConversation.id}
          conversation={selectedConversation}
          projectStatus={selectedProject?.status ?? 'ready'}
          onBack={() => setSelectedConversation(null)}
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
    </div>
  );
}
