import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "./media.types";
import { advanceViewportGeneration, useImagePreviewQueue } from "./media";
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
});
