import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import packageJson from '../package.json';
import InfiniteCanvas from './InfiniteCanvas';

// Mock Tauri APIs
let dropCallback: any = null;
const { revealItemInDirMock } = vi.hoisted(() => ({
  revealItemInDirMock: vi.fn()
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: any) => {
      dropCallback = cb;
      return Promise.resolve(vi.fn());
    }
  })
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(() => Promise.resolve(null))
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  message: vi.fn(),
  save: vi.fn(),
  open: vi.fn()
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: revealItemInDirMock
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(),
  readTextFile: vi.fn()
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: vi.fn(() => ({
      execute: vi.fn(() => Promise.resolve({ stdout: '' }))
    }))
  }
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

  it('opens the settings modal from the toolbar cog', () => {
    render(<InfiniteCanvas />);

    fireEvent.click(screen.getByRole('button', { name: /open settings/i }));

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hotkeys' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Debug' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByText(`Version ${packageJson.version}`)).toBeInTheDocument();
  });

  it('toggles development stats from the debug settings section', () => {
    render(<InfiniteCanvas />);

    fireEvent.click(screen.getByRole('button', { name: /open settings/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Debug' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /development mode/i }));

    expect(screen.getByLabelText('Development stats')).toBeInTheDocument();
    expect(screen.getByText('FPS')).toBeInTheDocument();
    expect(screen.getByText('Frame time (ms)')).toBeInTheDocument();
    expect(screen.getByText('Video count')).toBeInTheDocument();
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

    it('locks the current resized aspect ratio when resizing with shift held', async () => {
      const mediaItem = document.querySelector('.media-item') as HTMLElement;
      const handle = document.querySelector('.resize-handle') as HTMLElement;

      await act(async () => {
        fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 6, button: 0 });
      });
      await act(async () => {
        fireEvent.pointerMove(mediaItem, { clientX: 100, clientY: 200, pointerId: 6, button: 0 });
      });
      await act(async () => {
        fireEvent.pointerUp(mediaItem, { pointerId: 6, button: 0 });
      });

      expect(mediaItem.style.width).toBe('1380px');
      expect(mediaItem.style.height).toBe('1160px');

      const resizedRatio = 1380 / 1160;

      await act(async () => {
        fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 7, button: 0 });
      });
      await act(async () => {
        fireEvent.pointerMove(mediaItem, {
          clientX: 100,
          clientY: 0,
          pointerId: 7,
          button: 0,
          shiftKey: true
        });
      });
      await act(async () => {
        fireEvent.pointerUp(mediaItem, { pointerId: 7, button: 0 });
      });

      const width = parseFloat(mediaItem.style.width);
      const height = parseFloat(mediaItem.style.height);
      expect(width).toBeCloseTo(1480);
      expect(width / height).toBeCloseTo(resizedRatio);
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

    it('reveals the media file in the system file browser', async () => {
      const revealBtn = document.querySelector('.reveal-btn') as HTMLElement;
      expect(revealBtn).toBeInTheDocument();

      await act(async () => {
        fireEvent.pointerDown(revealBtn, { pointerId: 10, button: 0 });
        fireEvent.click(revealBtn);
      });

      expect(revealItemInDirMock).toHaveBeenCalledWith('/path/to/test.png');
    });

    it('crops an image in place from side and corner handles', async () => {
      const mediaItem = document.querySelector('.media-item') as HTMLElement;
      const image = screen.getByAltText('canvas item') as HTMLImageElement;
      const cropBtn = document.querySelector('.crop-btn') as HTMLElement;

      expect(cropBtn).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(cropBtn);
      });

      expect(document.querySelectorAll('.crop-handle')).toHaveLength(8);

      const startLeft = parseFloat(mediaItem.style.left);
      const startTop = parseFloat(mediaItem.style.top);
      const westHandle = document.querySelector('.crop-handle-w') as HTMLElement;

      await act(async () => {
        fireEvent.pointerDown(westHandle, {
          clientX: 0,
          clientY: 0,
          pointerId: 8,
          button: 0
        });
      });
      await act(async () => {
        fireEvent.pointerMove(mediaItem, {
          clientX: 120,
          clientY: 0,
          pointerId: 8,
          button: 0
        });
      });
      await act(async () => {
        fireEvent.pointerUp(mediaItem, { pointerId: 8, button: 0 });
      });

      expect(mediaItem.style.left).toBe(`${startLeft + 120}px`);
      expect(mediaItem.style.width).toBe('1160px');
      expect(image.style.left).toBe('-120px');
      expect(image.style.width).toBe('1280px');

      const northWestHandle = document.querySelector(
        '.crop-handle-nw'
      ) as HTMLElement;

      await act(async () => {
        fireEvent.pointerDown(northWestHandle, {
          clientX: 120,
          clientY: 0,
          pointerId: 9,
          button: 0
        });
      });
      await act(async () => {
        fireEvent.pointerMove(mediaItem, {
          clientX: 70,
          clientY: 80,
          pointerId: 9,
          button: 0
        });
      });
      await act(async () => {
        fireEvent.pointerUp(mediaItem, { pointerId: 9, button: 0 });
      });

      expect(mediaItem.style.left).toBe(`${startLeft + 70}px`);
      expect(mediaItem.style.top).toBe(`${startTop + 80}px`);
      expect(mediaItem.style.width).toBe('1210px');
      expect(mediaItem.style.height).toBe('880px');
      expect(image.style.left).toBe('-70px');
      expect(image.style.top).toBe('-80px');
    });
  });
});
