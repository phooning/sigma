import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
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
  invoke: vi.fn((command: string, args?: { path?: string }) => {
    if (command === 'probe_media') {
      return Promise.resolve({
        width: args?.path?.includes('heavy_video.mkv') ? 3840 : 1920,
        height: args?.path?.includes('heavy_video.mkv') ? 2160 : 1080,
        duration: args?.path?.includes('heavy_video.mkv') ? 2400 : 8,
        size: args?.path?.includes('heavy_video.mkv')
          ? 373 * 1024 * 1024
          : 838 * 1024
      });
    }

    if (command === 'generate_video_thumbnail') {
      return Promise.resolve(`/tmp/${args?.path?.includes('heavy_video.mkv') ? 'heavy' : 'video'}-thumb.jpg`);
    }

    if (command === 'save_media_screenshot') {
      return Promise.resolve('/shots/test-screenshot.png');
    }

    return Promise.resolve(null);
  })
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
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage.set(key, value);
        }),
        removeItem: vi.fn((key: string) => {
          storage.delete(key);
        }),
        clear: vi.fn(() => {
          storage.clear();
        })
      }
    });

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

    Object.defineProperty(globalThis.HTMLVideoElement.prototype, 'videoWidth', { get: () => 1920 });
    Object.defineProperty(globalThis.HTMLVideoElement.prototype, 'videoHeight', { get: () => 1080 });
    Object.defineProperty(globalThis.HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: vi.fn(() => Promise.resolve())
    });
    Object.defineProperty(globalThis.HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: vi.fn()
    });
    Object.defineProperty(globalThis.HTMLMediaElement.prototype, 'src', {
      configurable: true,
      set(src) {
        if (src) {
          setTimeout(() => {
            if (this.onloadedmetadata) this.onloadedmetadata(new Event('loadedmetadata'));
          }, 0);
        }
      }
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
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

  it('chooses a screenshot directory from general settings', async () => {
    vi.mocked(open).mockResolvedValue('/shots');

    render(<InfiniteCanvas />);

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

  it('drops multiple videos as playable video elements without eager thumbnail work', async () => {
    const originalInnerWidth = window.innerWidth;
    const videoPath = new URL(
      '../fixtures/generated-lod-test-1080p.mp4',
      import.meta.url
    ).pathname;
    const droppedVideos = [videoPath, videoPath];
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 3000
    });

    render(<InfiniteCanvas />);

    await act(async () => {
      if (dropCallback) {
        dropCallback({
          payload: {
            type: 'drop',
            paths: droppedVideos
          }
        });
      }
    });

    await waitFor(() => {
      expect(document.querySelectorAll('.media-item')).toHaveLength(2);
      expect(document.querySelectorAll('video.media-content')).toHaveLength(2);
    });

    document.querySelectorAll('video.media-content').forEach((video) => {
      expect(video).toHaveAttribute('src', `asset://${videoPath}`);
    });
    expect(document.querySelector('.video-lod-thumbnail')).not.toBeInTheDocument();
    expect(document.querySelector('.video-lod-proxy')).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith(
      'generate_video_thumbnail',
      expect.anything()
    );

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth
    });
  });

  it('drops large videos as deferred load proxies until playback is requested', async () => {
    const originalInnerWidth = window.innerWidth;
    const heavyVideoPath = new URL(
      '../fixtures/heavy_video.mkv',
      import.meta.url
    ).pathname;

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 3000
    });

    render(<InfiniteCanvas />);

    await act(async () => {
      if (dropCallback) {
        dropCallback({
          payload: {
            type: 'drop',
            paths: [heavyVideoPath]
          }
        });
      }
    });

    await waitFor(() => {
      expect(document.querySelectorAll('.media-item')).toHaveLength(1);
      expect(screen.getByRole('button', { name: /load video/i })).toBeInTheDocument();
    });

    expect(document.querySelector('video.media-content')).not.toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('probe_media', {
      path: heavyVideoPath
    });

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('generate_video_thumbnail', {
        path: heavyVideoPath
      });
      expect(document.querySelector('.video-load-thumbnail')).toHaveAttribute(
        'src',
        'asset:///tmp/heavy-thumb.jpg'
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /load video/i }));
    });

    await waitFor(() => {
      expect(document.querySelectorAll('video.media-content')).toHaveLength(1);
    });
    expect(document.querySelector('video.media-content')).toHaveAttribute(
      'src',
      `asset://${heavyVideoPath}`
    );
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth
    });
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

    it('saves a cropped screenshot using source-size crop ratios', async () => {
      vi.mocked(open).mockResolvedValue('/shots');

      const mediaItem = document.querySelector('.media-item') as HTMLElement;
      const cropBtn = document.querySelector('.crop-btn') as HTMLElement;

      await act(async () => {
        fireEvent.click(cropBtn);
      });

      const westHandle = document.querySelector('.crop-handle-w') as HTMLElement;
      await act(async () => {
        fireEvent.pointerDown(westHandle, {
          clientX: 0,
          clientY: 0,
          pointerId: 11,
          button: 0
        });
      });
      await act(async () => {
        fireEvent.pointerMove(mediaItem, {
          clientX: 120,
          clientY: 0,
          pointerId: 11,
          button: 0
        });
      });
      await act(async () => {
        fireEvent.pointerUp(mediaItem, { pointerId: 11, button: 0 });
      });

      const screenshotBtn = document.querySelector('.screenshot-btn') as HTMLElement;
      await act(async () => {
        fireEvent.pointerDown(screenshotBtn, { pointerId: 12, button: 0 });
        fireEvent.click(screenshotBtn);
      });

      expect(open).toHaveBeenCalledWith({
        directory: true,
        multiple: false,
        title: 'Choose screenshot directory'
      });
      expect(invoke).toHaveBeenCalledWith('save_media_screenshot', {
        path: '/path/to/test.png',
        mediaType: 'image',
        outputDirectory: '/shots',
        currentTime: 0,
        crop: {
          x: 120 / 1280,
          y: 0,
          width: 1160 / 1280,
          height: 1,
          boxWidth: 1280,
          boxHeight: 960
        }
      });
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
