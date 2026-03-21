import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import InfiniteCanvas from './InfiniteCanvas';

// Mock Tauri APIs
let dropCallback: any = null;

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: any) => {
      dropCallback = cb;
      return Promise.resolve(vi.fn());
    }
  })
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
  open: vi.fn()
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(),
  readTextFile: vi.fn()
}));

describe('InfiniteCanvas Application', () => {
  beforeAll(() => {
    // Mock HTMLImageElement properties and onload for tests
    Object.defineProperty(globalThis.Image.prototype, 'src', {
      set(src) {
        if (src) {
          setTimeout(() => {
            if (this.onload) this.onload(new Event('load'));
          }, 0);
        }
      }
    });

    Object.defineProperty(globalThis.Image.prototype, 'width', { get: () => 640 });
    Object.defineProperty(globalThis.Image.prototype, 'height', { get: () => 480 });
    Object.defineProperty(globalThis.Image.prototype, 'naturalWidth', { get: () => 640 });
    Object.defineProperty(globalThis.Image.prototype, 'naturalHeight', { get: () => 480 });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dropCallback = null;
  });

  // 1. Panning with middle click
  it('pans the canvas on middle click + drag', () => {
    render(<InfiniteCanvas />);
    
    const containerEl = document.querySelector('.canvas-container') as HTMLElement;
    expect(containerEl).toBeInTheDocument();

    const world = document.querySelector('.canvas-world') as HTMLElement;
    expect(world.style.transform).toContain('translate(0px, 0px)');

    // Start middle click pan
    fireEvent.pointerDown(containerEl, { button: 1, clientX: 100, clientY: 100, pointerId: 1 });
    
    // Move pointer
    fireEvent.pointerMove(containerEl, { clientX: 160, clientY: 180, pointerId: 1 });
    
    // Finish drag
    fireEvent.pointerUp(containerEl, { pointerId: 1 });

    // Assuming zoom is 1, dx = 60, dy = 80
    expect(world.style.transform).toContain('translate(60px, 80px)');
  });

  // 2. Selection box
  it('creates and sizes a selection box on left click + drag', () => {
    render(<InfiniteCanvas />);
    
    const containerEl = document.querySelector('.canvas-container') as HTMLElement;
    // Mock getBoundingClientRect
    containerEl.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => {}
    });

    // Start left click drag
    fireEvent.pointerDown(containerEl, { button: 0, clientX: 200, clientY: 200, pointerId: 2 });
    
    let selBox = document.querySelector('.selection-box') as HTMLElement;
    expect(selBox).toBeInTheDocument();
    expect(selBox.style.width).toBe('0px');
    expect(selBox.style.height).toBe('0px');

    // Drag to create box
    fireEvent.pointerMove(containerEl, { clientX: 350, clientY: 280, pointerId: 2 });
    
    selBox = document.querySelector('.selection-box') as HTMLElement;
    expect(selBox.style.width).toBe('150px');
    expect(selBox.style.height).toBe('80px');

    // Finish drag
    fireEvent.pointerUp(containerEl, { pointerId: 2 });
    
    expect(document.querySelector('.selection-box')).not.toBeInTheDocument();
  });

  // 3 & 4. Item interactions
  describe('Media Item Interactions', () => {
    beforeEach(async () => {
      render(<InfiniteCanvas />);
      
      // Simulate dropping an image
      await act(async () => {
        if (dropCallback) {
          dropCallback({ payload: { type: 'drop', paths: ['/path/to/test.png'] } });
        }
      });
      
      // Wait for image item to mount
      await screen.findByAltText('canvas item');
    });

    it('resizes the image back to correct aspect ratio on rescale button click', async () => {
      const mediaItem = document.querySelector('.media-item') as HTMLElement;
      expect(mediaItem).toBeInTheDocument();

      // Original dimensions: 1280w x 960h (since 480/640 * 1280 = 960)
      expect(mediaItem.style.width).toBe('1280px');
      expect(mediaItem.style.height).toBe('960px');

      // Emulate resize to distort aspect ratio
      const handle = document.querySelector('.resize-handle') as HTMLElement;
      const containerEl = document.querySelector('.canvas-container') as HTMLElement;
      containerEl.getBoundingClientRect = () => ({
        left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, x: 0, y: 0, toJSON: () => {}
      });

      // Pointer down on image handle to select it and start resize
      await act(async () => {
        fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 3, button: 0 });
      });
      await act(async () => {
        fireEvent.pointerMove(mediaItem, { clientX: 100, clientY: 200, pointerId: 3, button: 0 });
      });
      await act(async () => {
        fireEvent.pointerUp(mediaItem, { pointerId: 3, button: 0 });
      });

      expect(mediaItem.style.width).toBe('1380px');
      expect(mediaItem.style.height).toBe('1160px');

      // Click reset button
      const resetBtn = document.querySelector('.reset-btn') as HTMLElement;
      
      // The event listener prevents bubbling natively and stops propagation, 
      // check if pointer capture breaks the click. By firing pointerDown and click 
      // on the button, it shouldn't be captured by the container anymore!
      await act(async () => {
        fireEvent.pointerDown(resetBtn, { pointerId: 4, button: 0 });
        fireEvent.click(resetBtn);
      });

      // Reset to 1280/960
      expect(mediaItem.style.width).toBe('1280px');
      expect(mediaItem.style.height).toBe('960px');
    });

    it('deletes the media item on delete button click', async () => {
      const delBtn = document.querySelector('.delete-btn') as HTMLElement;
      expect(delBtn).toBeInTheDocument();

      await act(async () => {
        fireEvent.pointerDown(delBtn, { pointerId: 5, button: 0 });
        fireEvent.click(delBtn);
      });

      expect(screen.queryByAltText('canvas item')).not.toBeInTheDocument();
    });
  });
});
