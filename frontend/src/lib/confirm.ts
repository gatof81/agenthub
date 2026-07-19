/**
 * A promise-based, in-app confirm (11 §14) — replaces the native `window.confirm`
 * so a destructive action (archive) asks in the app's own dark-theme dialog. A
 * module-level pub/sub (like the toast surface): `await confirmDialog(msg)`
 * resolves true/false when the user answers; `<ConfirmDialog>` renders it.
 */

export interface ConfirmRequest {
  message: string;
  confirmLabel: string;
  danger: boolean;
}

type Listener = (request: ConfirmRequest | null) => void;

let request: ConfirmRequest | null = null;
let resolver: ((ok: boolean) => void) | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(request);
}

export function confirmDialog(
  message: string,
  opts?: { confirmLabel?: string; danger?: boolean },
): Promise<boolean> {
  resolver?.(false); // a still-open dialog is superseded → treat as cancelled
  return new Promise((resolve) => {
    resolver = resolve;
    request = { message, confirmLabel: opts?.confirmLabel ?? 'Confirm', danger: opts?.danger ?? false };
    emit();
  });
}

export function settleConfirm(ok: boolean): void {
  const resolve = resolver;
  resolver = null;
  request = null;
  emit();
  resolve?.(ok);
}

export function subscribeConfirm(listener: Listener): () => void {
  listeners.add(listener);
  listener(request);
  return () => {
    listeners.delete(listener);
  };
}
