import { act, render } from '@testing-library/react';
import { beforeAll, beforeEach, vi } from 'vitest';
import InfiniteCanvas from '../InfiniteCanvas';
import { useAudioPlaybackStore } from '../stores/useAudioPlaybackStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useVideoExportStore } from '../stores/useVideoExportStore';
import type { DropCallback, ViewportSize } from './infiniteCanvasHarness.types';

const {
  dragDropState,
  invokeMock,
  openMock,
  revealItemInDirMock,
  saveMock,
  toastMock,
  writeTextFileMock
} = vi.hoisted(() => {
  const invokeMock = vi.fn((command: string, args?: { path?: string }) => {
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
      return Promise.resolve(
        `/tmp/${args?.path?.includes('heavy_video.mkv') ? 'heavy' : 'video'}-thumb.jpg`
      );
    }

    if (command === 'save_media_screenshot') {
      return Promise.resolve('/shots/test-screenshot.png');
    }

    if (command === 'export_video') {
      return Promise.resolve('/exports/test-video.mp4');
    }

    return Promise.resolve(null);
  });

  return {
    dragDropState: {
      callback: null as DropCallback | null
    },
    invokeMock,
    openMock: vi.fn(),
    revealItemInDirMock: vi.fn(),
    saveMock: vi.fn(),
    toastMock: {
      success: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn()
    },
    writeTextFileMock: vi.fn()
  };
});

const DEFAULT_RECT = {
  left: 0,
  top: 0,
  right: 1000,
  bottom: 1000,
  width: 1000,
  height: 1000,
  x: 0,
  y: 0,
  toJSON: () => {}
};

let defaultViewport: Required<ViewportSize>;

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: DropCallback) => {
      dragDropState.callback = cb;
      return Promise.resolve(vi.fn());
    }
  })
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: invokeMock
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: saveMock,
  open: openMock
}));

vi.mock('sonner', () => ({
  toast: toastMock
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  revealItemInDir: revealItemInDirMock
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: writeTextFileMock,
  readTextFile: vi.fn()
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: vi.fn(() => ({
      execute: vi.fn(() => Promise.resolve({ stdout: '' }))
    }))
  }
}));

beforeAll(() => {
  defaultViewport = {
    width: window.innerWidth,
    height: window.innerHeight
  };

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
  setViewportSize(defaultViewport);
  useSettingsStore.getState().resetSettings();
  useAudioPlaybackStore.getState().resetAudioPlayback();
  useVideoExportStore.getState().resetVideoExportState();
  dragDropState.callback = null;
});

export {
  invokeMock as invoke,
  openMock as open,
  revealItemInDirMock,
  saveMock as save,
  toastMock as toast,
  writeTextFileMock as writeTextFile
};

export const renderCanvas = () => render(<InfiniteCanvas />);

export const dropFiles = async (paths: string[]) => {
  await act(async () => {
    if (!dragDropState.callback) {
      throw new Error('Drag/drop callback was not registered. Render InfiniteCanvas first.');
    }

    dragDropState.callback({
      payload: {
        type: 'drop',
        paths
      }
    });
  });
};

export const setViewportSize = ({ width, height }: ViewportSize) => {
  if (width !== undefined) {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: width
    });
  }

  if (height !== undefined) {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: height
    });
  }
};

export const mockCanvasRect = (element: HTMLElement) => {
  element.getBoundingClientRect = () => DEFAULT_RECT;
};

export const getCanvasContainer = () =>
  document.querySelector('.canvas-container') as HTMLElement;

export const getCanvasWorld = () =>
  document.querySelector('.canvas-world') as HTMLElement;

export const getMediaItem = () =>
  document.querySelector('.media-item') as HTMLElement;

export const getMediaVideo = () =>
  document.querySelector('video.media-content') as HTMLVideoElement;

export const getMediaVideos = () =>
  Array.from(document.querySelectorAll('video.media-content')) as HTMLVideoElement[];
