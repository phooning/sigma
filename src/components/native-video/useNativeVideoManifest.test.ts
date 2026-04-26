import { describe, expect, it } from "vitest";
import type { MediaItem } from "../../utils/media.types";
import { computeNativeVideoBounds } from "./useNativeVideoManifest";

const videoItem: MediaItem = {
  id: "video-1",
  type: "video",
  filePath: "/tmp/video.mp4",
  url: "asset:///tmp/video.mp4",
  x: 100,
  y: 80,
  width: 640,
  height: 360,
};

describe("native video geometry", () => {
  it("computes screen-space bounds immediately from the viewport", () => {
    expect(
      computeNativeVideoBounds(
        videoItem,
        { x: -25, y: 10, zoom: 2 },
        { width: 1920, height: 1080 },
      ),
    ).toEqual({
      screenX: 150,
      screenY: 180,
      renderedWidthPx: 1280,
      renderedHeightPx: 720,
      visibleAreaPx: 921_600,
    });
  });

  it("returns null when the video is outside the visible canvas", () => {
    expect(
      computeNativeVideoBounds(
        { ...videoItem, x: 2_000 },
        { x: 0, y: 0, zoom: 1 },
        { width: 800, height: 600 },
      ),
    ).toBeNull();
  });
});
