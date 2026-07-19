/**
 * Renders the active confirm request (11 §14) as a modal dialog. Mounted once at
 * the app root. Escape or a click outside cancels; Cancel is auto-focused so the
 * safe answer is the default.
 */

import { useEffect, useState } from 'react';
import { settleConfirm, subscribeConfirm, type ConfirmRequest } from '../lib/confirm.js';

export function ConfirmDialog(): React.JSX.Element | null {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  useEffect(() => subscribeConfirm(setRequest), []);
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') settleConfirm(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request]);

  if (!request) return null;
  return (
    <div className="modal-overlay" onClick={() => settleConfirm(false)}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="modal-msg">{request.message}</p>
        <div className="modal-actions">
          <button className="mini" onClick={() => settleConfirm(false)} autoFocus>
            Cancel
          </button>
          <button
            className={request.danger ? 'danger' : ''}
            onClick={() => settleConfirm(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
