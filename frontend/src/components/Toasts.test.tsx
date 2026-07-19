// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toasts } from './Toasts.js';
import { dismissToast, pushToast, subscribeToasts, type Toast } from '../lib/toast.js';

afterEach(() => {
  cleanup();
  // drain the module-level toast store between tests
  let current: Toast[] = [];
  subscribeToasts((t) => (current = t))();
  current.forEach((t) => dismissToast(t.id));
});

describe('<Toasts> (component-test harness smoke)', () => {
  it('renders nothing when there are no toasts', () => {
    const { container } = render(<Toasts />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a pushed toast as an alert carrying its message', () => {
    render(<Toasts />);
    act(() => {
      pushToast('Something broke', 'error');
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke');
  });

  it('removes the toast when its dismiss button is clicked', async () => {
    render(<Toasts />);
    act(() => {
      pushToast('go away');
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
