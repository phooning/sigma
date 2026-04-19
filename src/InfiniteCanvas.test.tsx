import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import packageJson from '../package.json';
import {
  open,
  renderCanvas,
  save,
  toast,
  writeTextFile
} from './test/infiniteCanvasHarness';

describe('InfiniteCanvas settings and persistence', () => {
  it('opens the settings modal from the toolbar cog', () => {
    renderCanvas();

    fireEvent.click(screen.getByRole('button', { name: /open settings/i }));

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Hotkeys' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Debug' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByText(`Version ${packageJson.version}`)).toBeInTheDocument();
  });

  it('toggles development stats from the debug settings section', () => {
    renderCanvas();

    fireEvent.click(screen.getByRole('button', { name: /open settings/i }));
    fireEvent.click(screen.getByRole('tab', { name: 'Debug' }));
    fireEvent.click(screen.getByRole('switch', { name: /development mode/i }));

    expect(screen.getByLabelText('Development stats')).toBeInTheDocument();
    expect(screen.getByText('FPS')).toBeInTheDocument();
    expect(screen.getByText('Frame time (ms)')).toBeInTheDocument();
    expect(screen.getByText('Video count')).toBeInTheDocument();
  });

  it('lists available hotkeys in settings', async () => {
    renderCanvas();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open settings/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Hotkeys' }));
    });

    expect(screen.getByText('Ctrl/Cmd+S')).toBeInTheDocument();
    expect(screen.getByText('Save the current canvas configuration.')).toBeInTheDocument();
    expect(screen.getByText('Spacebar')).toBeInTheDocument();
    expect(screen.getByText('Pause selected videos.')).toBeInTheDocument();
    expect(screen.getByText('Ctrl/Cmd+A')).toBeInTheDocument();
    expect(screen.getByText('Select every item on the canvas.')).toBeInTheDocument();
    expect(screen.getByText('Delete/Backspace')).toBeInTheDocument();
    expect(screen.getByText('Delete the selected items.')).toBeInTheDocument();
  });

  it('chooses a screenshot directory from general settings', async () => {
    vi.mocked(open).mockResolvedValue('/shots');

    renderCanvas();

    fireEvent.click(screen.getByRole('button', { name: /open settings/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose' }));
    });

    expect(open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Choose screenshot directory',
      defaultPath: undefined
    });
    expect(screen.getByText('/shots')).toBeInTheDocument();
    expect(localStorage.getItem('sigma:screenshot-directory')).toBe('/shots');
  });

  it('saves from the keyboard shortcut', async () => {
    vi.mocked(save).mockResolvedValue('/tmp/canvas.json');

    renderCanvas();

    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    });

    await waitFor(() => {
      expect(writeTextFile).toHaveBeenCalledOnce();
    });
    expect(writeTextFile).toHaveBeenCalledWith(
      '/tmp/canvas.json',
      expect.stringContaining('"items"')
    );
    expect(toast.success).toHaveBeenCalledWith('Save completed', {
      description: 'Config saved successfully.'
    });
  });

  it('switches the canvas background from dots to grid', async () => {
    renderCanvas();

    expect(document.querySelector('.canvas-background.dots')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /open settings/i }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Grid background' }));
    });

    expect(document.querySelector('.canvas-background.grid')).toBeInTheDocument();
    expect(document.querySelector('.canvas-grid-plus')).not.toBeInTheDocument();
    expect(localStorage.getItem('sigma:canvas-background-pattern')).toBe('grid');
  });
});
