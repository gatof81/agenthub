/**
 * Archived view (B4-03, UX-08, FR-43): archive is the product's delete and is
 * reversible — this is what makes that true on screen rather than only in the
 * database. Without a way to see and restore archived items, "reversible" is
 * a property of the store that the person looking at the UI cannot use.
 *
 * FR-44 is the part worth getting right: a project whose substrate session was
 * hard-deleted upstream cannot be restored — its workspace went with it. The
 * API says so (`409 session_gone`) and this surfaces that verbatim instead of
 * a generic failure, because "we cannot bring this back" is information the
 * owner needs, not an error to swallow.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Conversation, type Project } from '../lib/api.js';

interface Props {
  onClose: () => void;
  /** the caller refreshes its own lists after a successful restore */
  onRestored: () => void;
}

export function ArchivedView(props: Props): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [errorFor, setErrorFor] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([
      api.listProjects({ archived: true }),
      api.listArchivedConversations(),
    ]);
    setProjects(p.projects.filter((x) => x.status === 'archived'));
    setConversations(c.conversations.filter((x) => x.status === 'archived'));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = useCallback(
    async (kind: 'project' | 'conversation', id: string) => {
      setBusy(id);
      setErrorFor((e) => ({ ...e, [id]: '' }));
      try {
        if (kind === 'project') await api.restoreProject(id);
        else await api.restoreConversation(id);
        await load();
        props.onRestored();
      } catch (err) {
        // Say what actually happened. `session_gone` is permanent — the
        // workspace is gone, so no amount of retrying helps and the owner
        // should stop expecting it back. `project_archived` is a step order,
        // not a failure: restore the project first (I-12).
        const e = err as ApiError;
        const detail =
          e.code === 'session_gone'
            ? 'Its workspace was deleted upstream — this project cannot be restored.'
            : e.code === 'project_archived'
              ? 'Restore its project first — the session they share is stopped.'
              : (e.message || 'Restore failed.');
        setErrorFor((prev) => ({ ...prev, [id]: detail }));
      } finally {
        setBusy(null);
      }
    },
    [load, props],
  );

  const rows = (
    kind: 'project' | 'conversation',
    items: Array<{ id: string; label: string }>,
  ): React.JSX.Element => (
    <ul className="nav-list">
      {items.map((it) => (
        <li key={it.id} className="archived-row">
          <div className="archived-main">
            <span className="archived-name">{it.label}</span>
            {errorFor[it.id] && <span className="archived-error">{errorFor[it.id]}</span>}
          </div>
          <button
            className="mini"
            disabled={busy === it.id}
            onClick={() => void restore(kind, it.id)}
          >
            {busy === it.id ? 'Restoring…' : 'Restore'}
          </button>
        </li>
      ))}
      {items.length === 0 && <li className="empty-hint">Nothing archived.</li>}
    </ul>
  );

  return (
    <div className="archived-view">
      <header>
        <h2>Archived</h2>
        <button className="mini" onClick={props.onClose}>
          Done
        </button>
      </header>
      {loading ? (
        <p className="empty-hint">Loading…</p>
      ) : (
        <>
          <h3>Projects</h3>
          <p className="empty-hint">
            Restoring a project restarts its session; its files and history come back with it.
          </p>
          {rows(
            'project',
            projects.map((p) => ({ id: p.id, label: p.name })),
          )}
          <h3>Conversations</h3>
          {rows(
            'conversation',
            conversations.map((c) => ({ id: c.id, label: c.title })),
          )}
        </>
      )}
    </div>
  );
}
