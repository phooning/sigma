import { describe, expect, it, vi } from "vitest";
import { buildNativeImageManifest } from "./manifest";
import type { MediaItem } from "../../utils/media.types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

const baseImage = (overrides: Partial<MediaItem> = {}): MediaItem => ({
  id: "image-1",
  type: "image",
  filePath: "/images/example.png",
  url: "asset:///images/example.png",
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  sourceWidth: 1600,
  sourceHeight: 1200,
  ...overrides,
});

describe("buildNativeImageManifest", () => {
  it("derives cropped source ratios and preview requests for visible images", () => {
    const item = baseImage({
      crop: {
        top: 30,
        right: 40,
        bottom: 50,
        left: 20,
      },
    });

    const { manifest, previewRequests } = buildNativeImageManifest({
      items: [item],
      viewport: { x: 0, y: 0, zoom: 0.5 },
      canvasSize: { width: 1200, height: 800 },
      selectedItems: new Set<string>(),
      draggingItemId: null,
      resizingItemId: null,
      croppingItemId: null,
      editingCropItemId: null,
    });

    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0]).toMatchObject({
      path: "/images/example.png",
      url: "asset:///images/example.png",
      cropLeftRatio: 20 / 460,
      cropTopRatio: 30 / 380,
      cropWidthRatio: 400 / 460,
      cropHeightRatio: 300 / 380,
    });
    expect(previewRequests).toEqual([{ item, maxDimension: 1024 }]);
  });

  it("skips images currently managed by React and boosts selected draw order", () => {
    const background = baseImage({
      id: "background",
    });
    const selected = baseImage({
      id: "selected",
      x: 50,
      y: 20,
    });
    const dragging = baseImage({
      id: "dragging",
      x: 100,
      y: 40,
    });

    const { manifest } = buildNativeImageManifest({
      items: [background, selected, dragging],
      viewport: { x: 0, y: 0, zoom: 2 },
      canvasSize: { width: 1400, height: 900 },
      selectedItems: new Set<string>(["selected"]),
      draggingItemId: "dragging",
      resizingItemId: null,
      croppingItemId: null,
      editingCropItemId: null,
    });

    expect(manifest.assets.map((asset) => asset.id)).toEqual([
      "background",
      "selected",
    ]);
    expect(manifest.assets[1].drawOrder).toBeGreaterThan(
      manifest.assets[0].drawOrder,
    );
    expect(manifest.assets[1].focusWeight).toBe(2.5);
  });
});
