// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandPalette, type PaletteCommand } from './CommandPalette.js';

afterEach(cleanup);

function buildCommands(): PaletteCommand[] {
  return [
    { id: 'alpha', label: 'Alpha command', run: vi.fn() },
    { id: 'beta', label: 'Beta command', run: vi.fn() },
    {
      id: 'new-project',
      label: 'New project…',
      input: { placeholder: 'Project name', run: vi.fn() },
    },
  ];
}

function renderPalette(commands: PaletteCommand[], onClose = vi.fn()) {
  render(<CommandPalette open commands={commands} onClose={onClose} />);
  return { onClose, input: screen.getByRole('textbox') };
}

describe('<CommandPalette> filtering', () => {
  it('filters commands by label case-insensitively', async () => {
    const { input } = renderPalette(buildCommands());
    await userEvent.type(input, 'ALPHA');

    expect(screen.getByRole('option', { name: /alpha command/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /beta command/i })).not.toBeInTheDocument();
  });

  it('shows "No matching command." when nothing matches the filter', async () => {
    const { input } = renderPalette(buildCommands());
    await userEvent.type(input, 'zzz');

    expect(screen.getByText('No matching command.')).toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });
});

describe('<CommandPalette> keyboard navigation', () => {
  it('clamps ArrowUp at the first item and ArrowDown at the last item', async () => {
    const { input } = renderPalette(buildCommands());
    await userEvent.click(input);

    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('option', { name: /alpha command/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('option', { name: /new project/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('runs the active command and closes the palette on Enter', async () => {
    const commands = buildCommands();
    const { input, onClose } = renderPalette(commands, vi.fn());
    await userEvent.click(input);

    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(commands[1]!.run).toHaveBeenCalledTimes(1);
    expect(commands[0]!.run).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('<CommandPalette> two-step (input) commands', () => {
  it('Enter on a two-step command enters input mode instead of running it', async () => {
    const commands = buildCommands();
    const { input, onClose } = renderPalette(commands);
    await userEvent.click(input);

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(commands[2]!.input!.run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Project name')).toBeInTheDocument();
    expect(screen.getByText(/new project… — enter to confirm, esc to go back\./i)).toBeInTheDocument();
  });

  it('Enter with a typed value submits it to run() and closes the palette', async () => {
    const commands = buildCommands();
    const { input, onClose } = renderPalette(commands);
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    const valueInput = screen.getByPlaceholderText('Project name');
    await userEvent.type(valueInput, 'My Project{Enter}');

    expect(commands[2]!.input!.run).toHaveBeenCalledWith('My Project');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape exits input mode without closing the whole palette', async () => {
    const commands = buildCommands();
    const { input, onClose } = renderPalette(commands);
    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    const valueInput = screen.getByPlaceholderText('Project name');
    await userEvent.type(valueInput, 'partial');
    await userEvent.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
    expect(commands[2]!.input!.run).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Type a command…')).toBeInTheDocument();

    // second Escape, now back at the top level, closes the palette
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
