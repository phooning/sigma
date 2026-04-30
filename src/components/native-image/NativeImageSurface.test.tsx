import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../utils/media.types";
import { NativeImageSurface } from "./NativeImageSurface";

vi.mock("./manifest", () => ({
  buildNativeImageManifest: vi.fn(() => ({
    manifest: {
      canvasWidth: 1200,
      canvasHeight: 800,
      viewportZoom: 0.1,
      assets: [],
    },
    previewRequests: [
      {
        item: {
          id: "image-1",
          type: "image",
          filePath: "/images/full-res.png",
          url: "asset:///images/full-res.png",
          x: 0,
          y: 0,
          width: 6000,
          height: 4000,
        },
        maxDimension: 1024,
      },
    ],
  })),
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

class WorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  postMessage() {}

  terminate() {}
}

describe("NativeImageSurface", () => {
  const animationFrames: FrameRequestCallback[] = [];
  let animationFrameHandle = 0;
  const flushAnimationFrames = () => {
    const queued = animationFrames.splice(0);
    for (const callback of queued) {
      callback(performance.now());
    }
  };

  beforeEach(() => {
    animationFrames.length = 0;
    animationFrameHandle = 0;
    vi.stubGlobal("Worker", WorkerStub);
    vi.stubGlobal("createImageBitmap", vi.fn());
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      animationFrames.push(callback);
      animationFrameHandle += 1;
      return animationFrameHandle;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    HTMLCanvasElement.prototype.transferControlToOffscreen = vi
      .fn()
      .mockReturnValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reissues preview requests after viewport changes", () => {
    const requestImagePreview = vi.fn();

    const { rerender } = render(
      <NativeImageSurface
        items={[imageItem]}
        viewport={{ x: 0, y: 0, zoom: 0.1 }}
        canvasSize={{ width: 1200, height: 800 }}
        selectedItems={new Set<string>()}
        draggingItemId={null}
        resizingItemId={null}
        croppingItemId={null}
        editingCropItemId={null}
        requestImagePreview={requestImagePreview}
      />,
    );

    flushAnimationFrames();

    expect(requestImagePreview).toHaveBeenCalledTimes(1);

    rerender(
      <NativeImageSurface
        items={[imageItem]}
        viewport={{ x: 25, y: 10, zoom: 0.1 }}
        canvasSize={{ width: 1200, height: 800 }}
        selectedItems={new Set<string>()}
        draggingItemId={null}
        resizingItemId={null}
        croppingItemId={null}
        editingCropItemId={null}
        requestImagePreview={requestImagePreview}
      />,
    );

    flushAnimationFrames();

    expect(requestImagePreview).toHaveBeenCalledTimes(2);
  });
});
