import { describe, expect, it } from "vitest";
import type { MediaItem, Viewport } from "./media.types";
import { computeMinimapLayout } from "./minimap";

const viewport: Viewport = {
  x: 0,
  y: 0,
  zoom: 1,
};

const items: MediaItem[] = [
  {
    id: "image-1",
    type: "image",
    filePath: "/tmp/image-1.png",
    url: "asset:///tmp/image-1.png",
    x: -400,
    y: 100,
    width: 200,
    height: 120,
  },
  {
    id: "video-1",
    type: "video",
    filePath: "/tmp/video-1.mp4",
    url: "asset:///tmp/video-1.mp4",
    x: 1200,
    y: 900,
    width: 300,
    height: 160,
  },
];

describe("computeMinimapLayout", () => {
  it("fits the furthest asset bounds into the minimap frame", () => {
    const layout = computeMinimapLayout({
      items,
      viewport,
      canvasSize: {
        width: 1600,
        height: 1000,
      },
      minimapWidth: 220,
      minimapHeight: 160,
      padding: 12,
    });

    expect(layout.frame.x).toBeGreaterThanOrEqual(12);
    expect(layout.frame.y).toBeGreaterThanOrEqual(12);
    expect(layout.frame.x + layout.frame.width).toBeLessThanOrEqual(208);
    expect(layout.frame.y + layout.frame.height).toBeLessThanOrEqual(148);

    expect(layout.assetRects).toHaveLength(2);
    expect(layout.assetRects[0].id).toBe("image-1");
    expect(layout.assetRects[1].id).toBe("video-1");
    expect(layout.assetRects[0].x).toBeLessThan(layout.assetRects[1].x);
    expect(layout.assetRects[0].y).toBeLessThan(layout.assetRects[1].y);
  });

  it("keeps the current viewport represented even when there are no items", () => {
    const layout = computeMinimapLayout({
      items: [],
      viewport: {
        x: -240,
        y: -120,
        zoom: 2,
      },
      canvasSize: {
        width: 1600,
        height: 1000,
      },
      minimapWidth: 220,
      minimapHeight: 160,
      padding: 12,
    });

    expect(layout.assetRects).toHaveLength(0);
    expect(layout.viewportRect.width).toBeGreaterThan(0);
    expect(layout.viewportRect.height).toBeGreaterThan(0);
    expect(layout.viewportRect.x).toBeGreaterThanOrEqual(layout.frame.x);
    expect(layout.viewportRect.y).toBeGreaterThanOrEqual(layout.frame.y);
  });

  it("clamps the viewport indicator so it never escapes the minimap frame", () => {
    const layout = computeMinimapLayout({
      items: [
        {
          id: "asset-1",
          type: "image",
          filePath: "/tmp/asset-1.png",
          url: "asset:///tmp/asset-1.png",
          x: 0,
          y: 0,
          width: 120,
          height: 120,
        },
      ],
      viewport: {
        x: -6000,
        y: -4000,
        zoom: 1,
      },
      canvasSize: {
        width: 1600,
        height: 1000,
      },
      minimapWidth: 220,
      minimapHeight: 160,
      padding: 12,
    });

    expect(layout.viewportRect.x).toBeGreaterThanOrEqual(layout.frame.x);
    expect(layout.viewportRect.y).toBeGreaterThanOrEqual(layout.frame.y);
    expect(
      layout.viewportRect.x + layout.viewportRect.width,
    ).toBeLessThanOrEqual(layout.frame.x + layout.frame.width);
    expect(
      layout.viewportRect.y + layout.viewportRect.height,
    ).toBeLessThanOrEqual(layout.frame.y + layout.frame.height);
  });
});
