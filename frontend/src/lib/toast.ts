/**
 * A tiny toast surface (11 §13): user-initiated actions that fail used to
 * `.catch(() => {})` silently, leaving the UI mute when the seam hiccups. This
 * is a module-level pub/sub (like the 401 handler) so any layer can raise a
 * dismissible notice; the `<Toasts>` component renders whatever is live. It does
 * NOT replace the deliberate inline messages (send-error banner, FR-44 restore
 * notice) — it catches the failures that had no surface at all.
 */

export type ToastKind = 'error' | 'info';

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

/** Show a dismissible toast; returns its id so a caller can dismiss it early. */
export function pushToast(message: string, kind: ToastKind = 'error'): number {
  const id = (seq += 1);
  toasts = [...toasts, { id, message, kind }];
  emit();
  return id;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Raise an error toast from a caught value, prefixed with what was attempted. */
export function toastError(error: unknown, context: string): void {
  const detail = error instanceof Error ? error.message : 'something went wrong';
  pushToast(`${context} — ${detail}`, 'error');
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
