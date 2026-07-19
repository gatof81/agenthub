import { afterEach, describe, expect, it } from 'vitest';
import { confirmDialog, settleConfirm, subscribeConfirm, type ConfirmRequest } from './confirm.js';

afterEach(() => settleConfirm(false)); // close anything left open

function track(): (ConfirmRequest | null)[] {
  const seen: (ConfirmRequest | null)[] = [];
  subscribeConfirm((r) => seen.push(r)); // stay subscribed to catch the emit
  return seen;
}

describe('confirmDialog', () => {
  it('emits the request and resolves true when confirmed', async () => {
    const seen = track();
    const p = confirmDialog('Archive?', { confirmLabel: 'Archive', danger: true });
    expect(seen.at(-1)).toMatchObject({ message: 'Archive?', confirmLabel: 'Archive', danger: true });
    settleConfirm(true);
    await expect(p).resolves.toBe(true);
  });

  it('resolves false when cancelled', async () => {
    const p = confirmDialog('Archive?');
    settleConfirm(false);
    await expect(p).resolves.toBe(false);
  });

  it('defaults confirmLabel to Confirm and danger to false', () => {
    const seen = track();
    void confirmDialog('Sure?');
    expect(seen.at(-1)).toMatchObject({ confirmLabel: 'Confirm', danger: false });
  });

  it('superseding an open dialog cancels the previous one', async () => {
    const p1 = confirmDialog('First?');
    const p2 = confirmDialog('Second?');
    await expect(p1).resolves.toBe(false);
    settleConfirm(true);
    await expect(p2).resolves.toBe(true);
  });
});
