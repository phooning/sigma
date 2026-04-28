import { act, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  getCanvasContainer,
  getCanvasWorld,
  mockCanvasRect,
  renderCanvas
} from './test/infiniteCanvasHarness';
import { useCanvasSessionStore } from './stores/useCanvasSessionStore';

describe('InfiniteCanvas canvas interactions', () => {
  it('pans the canvas on middle click + drag', () => {
    vi.useFakeTimers();

    try {
      renderCanvas();
      vi.mocked(localStorage.setItem).mockClear();

      const containerEl = getCanvasContainer();
      expect(containerEl).toBeInTheDocument();

      const world = getCanvasWorld();
      expect(world.style.transform).toContain('translate(0px, 0px)');

      fireEvent.pointerDown(containerEl, { button: 1, clientX: 100, clientY: 100, pointerId: 1 });
      fireEvent.pointerMove(containerEl, { clientX: 130, clientY: 140, pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.pointerMove(containerEl, { clientX: 160, clientY: 180, pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(useCanvasSessionStore.getState().viewport).toEqual({ x: 0, y: 0, zoom: 1 });
      expect(localStorage.setItem).not.toHaveBeenCalledWith(
        'sigma:canvas-session',
        expect.any(String)
      );

      fireEvent.pointerUp(containerEl, { pointerId: 1 });

      expect(world.style.transform).toContain('translate(60px, 80px)');
      expect(useCanvasSessionStore.getState().viewport).toEqual({ x: 60, y: 80, zoom: 1 });
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'sigma:canvas-session',
        expect.stringContaining('"viewport":{"x":60,"y":80,"zoom":1}')
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates and sizes a selection box on left click + drag', () => {
    renderCanvas();

    const containerEl = getCanvasContainer();
    mockCanvasRect(containerEl);

    fireEvent.pointerDown(containerEl, { button: 0, clientX: 200, clientY: 200, pointerId: 2 });

    let selBox = document.querySelector('.selection-box') as HTMLElement;
    expect(selBox).toBeInTheDocument();
    expect(selBox.style.width).toBe('0px');
    expect(selBox.style.height).toBe('0px');

    fireEvent.pointerMove(containerEl, { clientX: 350, clientY: 280, pointerId: 2 });

    selBox = document.querySelector('.selection-box') as HTMLElement;
    expect(selBox.style.width).toBe('150px');
    expect(selBox.style.height).toBe('80px');

    fireEvent.pointerUp(containerEl, { pointerId: 2 });

    expect(document.querySelector('.selection-box')).not.toBeInTheDocument();
  });
});
