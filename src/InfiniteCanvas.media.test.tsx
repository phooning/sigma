import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  dropFiles,
  getCanvasContainer,
  getMediaItem,
  getMediaVideo,
  getMediaVideos,
  invoke,
  mockCanvasRect,
  open,
  renderCanvas,
  revealItemInDirMock,
  setViewportSize
} from './test/infiniteCanvasHarness';

describe('InfiniteCanvas media loading', () => {
  it('drops multiple videos as playable video elements without eager thumbnail work', async () => {
    const videoPath = new URL(
      '../fixtures/generated-lod-test-1080p.mp4',
      import.meta.url
    ).pathname;

    setViewportSize({ width: 3000 });
    renderCanvas();
    await dropFiles([videoPath, videoPath]);

    await waitFor(() => {
      expect(document.querySelectorAll('.media-item')).toHaveLength(2);
      expect(getMediaVideos()).toHaveLength(2);
    });

    getMediaVideos().forEach((video) => {
      expect(video).toHaveAttribute('src', `asset://${videoPath}`);
    });
    expect(document.querySelector('.video-lod-thumbnail')).not.toBeInTheDocument();
    expect(document.querySelector('.video-lod-proxy')).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith(
      'generate_video_thumbnail',
      expect.anything()
    );
  });

  it('pauses selected videos with the spacebar', async () => {
    const videoPath = '/path/to/spacebar-video.mp4';

    renderCanvas();
    await dropFiles([videoPath]);

    const video = await waitFor(() => {
      const found = document.querySelector('video.media-content') as HTMLVideoElement | null;
      expect(found).toBeInTheDocument();
      return found!;
    });
    const pause = vi.fn();
    Object.defineProperty(video, 'paused', {
      configurable: true,
      get: () => false
    });
    Object.defineProperty(video, 'pause', {
      configurable: true,
      value: pause
    });

    const mediaItem = getMediaItem();
    await act(async () => {
      fireEvent.pointerDown(mediaItem, { button: 0, clientX: 10, clientY: 10, pointerId: 21 });
    });

    expect(mediaItem).toHaveClass('selected');

    await act(async () => {
      fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    });

    expect(pause).toHaveBeenCalledOnce();
  });

  it('drops large videos as deferred load proxies until playback is requested', async () => {
    const heavyVideoPath = new URL(
      '../fixtures/heavy_video.mkv',
      import.meta.url
    ).pathname;

    setViewportSize({ width: 3000 });
    renderCanvas();
    await dropFiles([heavyVideoPath]);

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
      expect(getMediaVideos()).toHaveLength(1);
    });
    expect(getMediaVideo()).toHaveAttribute('src', `asset://${heavyVideoPath}`);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
});

describe('InfiniteCanvas media item interactions', () => {
  beforeEach(async () => {
    renderCanvas();
    await dropFiles(['/path/to/test.png']);
    await screen.findByAltText('canvas item');
  });

  it('resizes the image back to correct aspect ratio on rescale button click', async () => {
    const mediaItem = getMediaItem();
    expect(mediaItem).toBeInTheDocument();

    expect(mediaItem.style.width).toBe('1280px');
    expect(mediaItem.style.height).toBe('960px');

    const handle = document.querySelector('.resize-handle') as HTMLElement;
    mockCanvasRect(getCanvasContainer());

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

    const resetBtn = document.querySelector('.reset-btn') as HTMLElement;

    await act(async () => {
      fireEvent.pointerDown(resetBtn, { pointerId: 4, button: 0 });
      fireEvent.click(resetBtn);
    });

    expect(mediaItem.style.width).toBe('1280px');
    expect(mediaItem.style.height).toBe('960px');
  });

  it('locks the current resized aspect ratio when resizing with shift held', async () => {
    const mediaItem = getMediaItem();
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

    const mediaItem = getMediaItem();
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
    const mediaItem = getMediaItem();
    const image = screen.getByAltText('canvas item') as HTMLImageElement;
    const cropBox = image.parentElement as HTMLDivElement;
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
    expect(cropBox.style.left).toBe('-120px');
    expect(cropBox.style.width).toBe('1280px');

    const northWestHandle = document.querySelector('.crop-handle-nw') as HTMLElement;

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
    expect(cropBox.style.left).toBe('-70px');
    expect(cropBox.style.top).toBe('-80px');
  });

  it('keeps the crop box stable while cropping a resized frame', async () => {
    const mediaItem = getMediaItem();
    const image = screen.getByAltText('canvas item') as HTMLImageElement;
    const cropBox = image.parentElement as HTMLDivElement;
    const resizeHandle = document.querySelector('.resize-handle') as HTMLElement;

    await act(async () => {
      fireEvent.pointerDown(resizeHandle, {
        clientX: 0,
        clientY: 0,
        pointerId: 13,
        button: 0
      });
    });
    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: 100,
        clientY: 200,
        pointerId: 13,
        button: 0
      });
    });
    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 13, button: 0 });
    });

    const cropBtn = document.querySelector('.crop-btn') as HTMLElement;
    await act(async () => {
      fireEvent.click(cropBtn);
    });

    expect(cropBox.style.left).toBe('0px');
    expect(cropBox.style.width).toBe('1380px');

    const eastHandle = document.querySelector('.crop-handle-e') as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(eastHandle, {
        clientX: 0,
        clientY: 0,
        pointerId: 14,
        button: 0
      });
    });
    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: -120,
        clientY: 0,
        pointerId: 14,
        button: 0
      });
    });
    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 14, button: 0 });
    });

    expect(mediaItem.style.width).toBe('1260px');
    expect(cropBox.style.left).toBe('0px');
    expect(cropBox.style.width).toBe('1380px');

    const startLeft = parseFloat(mediaItem.style.left);
    const westHandle = document.querySelector('.crop-handle-w') as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(westHandle, {
        clientX: 0,
        clientY: 0,
        pointerId: 15,
        button: 0
      });
    });
    await act(async () => {
      fireEvent.pointerMove(mediaItem, {
        clientX: 120,
        clientY: 0,
        pointerId: 15,
        button: 0
      });
    });
    await act(async () => {
      fireEvent.pointerUp(mediaItem, { pointerId: 15, button: 0 });
    });

    expect(mediaItem.style.left).toBe(`${startLeft + 120}px`);
    expect(mediaItem.style.width).toBe('1140px');
    expect(cropBox.style.left).toBe('-120px');
    expect(cropBox.style.width).toBe('1380px');
  });
});
