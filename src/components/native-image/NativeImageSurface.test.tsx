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
  beforeEach(() => {
    vi.stubGlobal("Worker", WorkerStub);
    vi.stubGlobal("createImageBitmap", vi.fn());
    vi.spyOn(window, "requestAnimationFrame");
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

    expect(requestImagePreview).toHaveBeenCalledTimes(2);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("does not transfer the same canvas again after resize rerenders", () => {
    const transferControlToOffscreen = vi.mocked(
      HTMLCanvasElement.prototype.transferControlToOffscreen,
    );
    const offscreenCanvas = {} as OffscreenCanvas;
    transferControlToOffscreen
      .mockReturnValueOnce(offscreenCanvas)
      .mockImplementation(() => {
        throw new DOMException(
          "Cannot transfer control from a canvas for more than one time.",
          "InvalidStateError",
        );
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

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
        requestImagePreview={vi.fn()}
      />,
    );

    rerender(
      <NativeImageSurface
        items={[imageItem]}
        viewport={{ x: 0, y: 0, zoom: 0.1 }}
        canvasSize={{ width: 1280, height: 720 }}
        selectedItems={new Set<string>()}
        draggingItemId={null}
        resizingItemId={null}
        croppingItemId={null}
        editingCropItemId={null}
        requestImagePreview={vi.fn()}
      />,
    );

    expect(transferControlToOffscreen).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
