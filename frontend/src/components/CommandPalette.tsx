/**
 * Command palette (11 §4, B1-12): keyboard-first access to the same flows
 * the pointer UI drives — create project/conversation, send, cancel, jump,
 * toggle panels. App owns the ⌘K/Ctrl+K shortcut and the command list;
 * zero-dependency by design (R-10 — a filtered list does not justify a
 * library).
 */

import { useEffect, useRef, useState } from 'react';

export interface PaletteCommand {
  id: string;
  label: string;
  /** Right-aligned context, e.g. the project a conversation belongs to. */
  hint?: string;
  /** Two-step commands (e.g. "New project…") collect a value before running. */
  input?: { placeholder: string; run: (value: string) => void };
  run?: () => void;
}

interface Props {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}

export function CommandPalette({ open, commands, onClose }: Props): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [inputFor, setInputFor] = useState<PaletteCommand | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      setInputFor(null);
    }
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, inputFor]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filtered = commands.filter((c) => c.label.toLowerCase().includes(q));
  const active = filtered[Math.min(index, filtered.length - 1)];

  const select = (cmd: PaletteCommand): void => {
    if (cmd.input) {
      setInputFor(cmd);
      setQuery('');
      return;
    }
    cmd.run?.();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (inputFor) setInputFor(null);
      else onClose();
    } else if (inputFor) {
      if (e.key === 'Enter' && query.trim() !== '') {
        e.preventDefault();
        inputFor.input?.run(query.trim());
        onClose();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && active) {
      e.preventDefault();
      select(active);
    }
  };

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={inputFor ? inputFor.input?.placeholder : 'Type a command…'}
          aria-label={inputFor ? inputFor.input?.placeholder : 'Search commands'}
        />
        {inputFor ? (
          <p className="palette-note muted">
            {inputFor.label} — Enter to confirm, Esc to go back.
          </p>
        ) : (
          <ul role="listbox">
            {filtered.map((c, i) => (
              <li key={c.id} role="option" aria-selected={c.id === active?.id}>
                <button
                  className={c.id === active?.id ? 'active' : ''}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => select(c)}
                >
                  <span>{c.label}</span>
                  {c.hint && <span className="hint">{c.hint}</span>}
                </button>
              </li>
            ))}
            {filtered.length === 0 && <li className="empty">No matching command.</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
