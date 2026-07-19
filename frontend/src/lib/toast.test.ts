import { afterEach, describe, expect, it } from 'vitest';
import { dismissToast, pushToast, subscribeToasts, toastError, type Toast } from './toast.js';

// module-level state — drain between tests
afterEach(() => {
  let current: Toast[] = [];
  subscribeToasts((t) => (current = t))();
  current.forEach((t) => dismissToast(t.id));
});

function snapshot(): Toast[] {
  let current: Toast[] = [];
  subscribeToasts((t) => (current = t))();
  return current;
}

describe('toast pub/sub', () => {
  it('pushes and notifies subscribers with the new toast', () => {
    const seen: Toast[][] = [];
    const unsub = subscribeToasts((t) => seen.push(t));
    const id = pushToast('boom', 'error');
    unsub();
    expect(seen.at(-1)).toHaveLength(1);
    expect(seen.at(-1)![0]).toMatchObject({ id, message: 'boom', kind: 'error' });
  });

  it('dismiss removes the toast', () => {
    const id = pushToast('x');
    dismissToast(id);
    expect(snapshot()).toHaveLength(0);
  });

  it('toastError formats an Error with its message', () => {
    toastError(new Error('nope'), 'Could not X');
    expect(snapshot().at(-1)).toMatchObject({ message: 'Could not X — nope', kind: 'error' });
  });

  it('toastError falls back for a non-Error value', () => {
    toastError('weird', 'Could not Y');
    expect(snapshot().at(-1)?.message).toBe('Could not Y — something went wrong');
  });

  it('subscribe replays current state immediately', () => {
    pushToast('present');
    expect(snapshot().some((t) => t.message === 'present')).toBe(true);
  });
});
