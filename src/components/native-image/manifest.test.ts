import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../../utils/media.types";
import { buildNativeImageManifest } from "./manifest";

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
      path: expect.stringMatching(/^data:image\/svg\+xml/),
      url: expect.stringMatching(/^data:image\/svg\+xml/),
      cropLeftRatio: 20 / 460,
      cropTopRatio: 30 / 380,
      cropWidthRatio: 400 / 460,
      cropHeightRatio: 300 / 380,
    });
    expect(previewRequests).toEqual([{ item, maxDimension: 256 }]);
  });

  it("uses a preview or placeholder instead of full-res below 1x zoom", () => {
    const missingPreview = baseImage({
      width: 6000,
      height: 4000,
      sourceWidth: 6000,
      sourceHeight: 4000,
    });
    const withPreview = baseImage({
      id: "with-preview",
      width: 6000,
      height: 4000,
      sourceWidth: 6000,
      sourceHeight: 4000,
      imagePreview1024Path: "/images/example-1024.png",
      imagePreview1024Url: "asset:///images/example-1024.png",
    });

    const { manifest, previewRequests } = buildNativeImageManifest({
      items: [missingPreview, withPreview],
      viewport: { x: 0, y: 0, zoom: 0.1 },
      canvasSize: { width: 1200, height: 800 },
      selectedItems: new Set<string>(),
      draggingItemId: null,
      resizingItemId: null,
      croppingItemId: null,
      editingCropItemId: null,
    });

    expect(manifest.assets[0]).toMatchObject({
      id: "image-1",
      path: expect.stringMatching(/^data:image\/svg\+xml/),
      url: expect.stringMatching(/^data:image\/svg\+xml/),
    });
    expect(manifest.assets[1]).toMatchObject({
      id: "with-preview",
      path: "/images/example-1024.png",
      url: "asset:///images/example-1024.png",
    });
    expect(manifest.assets.map((asset) => asset.path)).not.toContain(
      "/images/example.png",
    );
    expect(previewRequests).toEqual([
      { item: missingPreview, maxDimension: 1024 },
    ]);
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
