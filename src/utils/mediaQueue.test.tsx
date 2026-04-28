import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "./media.types";
import {
  advanceViewportGeneration,
  useImagePreviewQueue,
  useThumbnailQueue,
} from "./media";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: vi.fn(() => Promise.resolve("/tmp/preview-256.png")),
}));

const imageItem: MediaItem = {
  id: "image-1",
  type: "image",
  filePath: "/images/full-res.png",
  url: "asset:///images/full-res.png",
  x: 0,
  y: 0,
  width: 6000,
  height: 4000,
};

const videoItem: MediaItem = {
  id: "video-1",
  type: "video",
  filePath: "/videos/clip.mp4",
  url: "asset:///videos/clip.mp4",
  deferVideoLoad: true,
  x: 4000,
  y: 4000,
  width: 1920,
  height: 1080,
};

describe("media preview queues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops stale image preview requests before enqueueing decode work", async () => {
    const setItems = vi.fn();
    const { result } = renderHook(() => useImagePreviewQueue(setItems));
    const staleGeneration = advanceViewportGeneration() - 1;

    await act(async () => {
      result.current.requestImagePreview(imageItem, 256, {
        generation: staleGeneration,
      });
    });

    expect(invoke).not.toHaveBeenCalled();
  });

  it("forwards fresh image preview requests to the decode arbiter", async () => {
    const setItems = vi.fn();
    const { result } = renderHook(() => useImagePreviewQueue(setItems));
    const generation = advanceViewportGeneration();

    await act(async () => {
      result.current.requestImagePreview(imageItem, 256, {
        generation,
        viewBounds: {
          viewLeft: -10,
          viewTop: -10,
          viewRight: 1000,
          viewBottom: 1000,
        },
      });
    });

    expect(invoke).toHaveBeenCalledWith("request_decode", {
      itemId: "image-1",
      path: "/images/full-res.png",
      lod: 256,
      generation,
      priority: "visible",
    });
  });

  it("reuses an in-flight image preview request across viewport generations", async () => {
    let resolveDecode: ((path: string) => void) | null = null;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveDecode = resolve;
        }),
    );

    const setItems = vi.fn();
    const { result } = renderHook(() => useImagePreviewQueue(setItems));
    const firstGeneration = advanceViewportGeneration();

    await act(async () => {
      result.current.requestImagePreview(imageItem, 256, {
        generation: firstGeneration,
      });
    });

    const secondGeneration = advanceViewportGeneration();
    await act(async () => {
      result.current.requestImagePreview(imageItem, 256, {
        generation: secondGeneration,
      });
    });

    expect(invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDecode?.("/tmp/preview-256.png");
      await Promise.resolve();
    });

    expect(setItems).toHaveBeenCalledTimes(1);
    const updateItems = setItems.mock.calls[0][0] as (items: MediaItem[]) => MediaItem[];
    expect(updateItems([imageItem])[0]).toMatchObject({
      imagePreview256Path: "/tmp/preview-256.png",
      imagePreview256Url: "asset:///tmp/preview-256.png",
    });
  });

  it("skips background video thumbnail requests that are far off-canvas", async () => {
    const setItems = vi.fn();
    const { result } = renderHook(() => useThumbnailQueue(setItems));
    const generation = advanceViewportGeneration();

    await act(async () => {
      result.current.requestThumbnail(videoItem, {
        generation,
        viewBounds: {
          viewLeft: 0,
          viewTop: 0,
          viewRight: 1000,
          viewBottom: 1000,
        },
      });
    });

    expect(invoke).not.toHaveBeenCalled();
  });
});
