/**
 * Renders the live toasts (11 §13). Mounted once at the app root; each toast is
 * a `role="alert"` so a screen reader announces it, and auto-dismisses (errors
 * linger a little longer) but can be closed early.
 */

import { useEffect, useState } from 'react';
import { dismissToast, subscribeToasts, type Toast } from '../lib/toast.js';

function ToastRow({ toast }: { toast: Toast }): React.JSX.Element {
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(toast.id), toast.kind === 'error' ? 7000 : 4000);
    return () => clearTimeout(timer);
  }, [toast.id, toast.kind]);
  return (
    <div className={`toast toast-${toast.kind}`} role="alert">
      <span className="toast-msg">{toast.message}</span>
      <button
        className="toast-close"
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss notification"
      >
        ×
      </button>
    </div>
  );
}

export function Toasts(): React.JSX.Element | null {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => subscribeToasts(setToasts), []);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  );
}
