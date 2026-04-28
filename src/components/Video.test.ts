import { describe, expect, it } from "vitest";
import type { MediaItem } from "../utils/media.types";
import { getImageLod } from "../utils/videoUtils";
import {
  clampVideoTime,
  getVideoLod,
  shouldRequestVideoThumbnail,
} from "./Video";

const videoItem: MediaItem = {
  id: "video-1",
  type: "video",
  filePath: "/tmp/video.mp4",
  url: "asset:///tmp/video.mp4",
  x: 0,
  y: 0,
  width: 1280,
  height: 720,
};

const thumbnailBandZoom = 0.11;

describe("video level of detail", () => {
  it("keeps full video for visible media while it still has useful screen detail", () => {
    expect(getVideoLod(0.5, true, videoItem)).toBe("video");
  });

  it("uses thumbnails only once the rendered video is near thumbnail size", () => {
    expect(getVideoLod(thumbnailBandZoom, true, videoItem)).toBe("thumbnail");
  });

  it("uses the proxy only when the rendered video is extremely small", () => {
    expect(getVideoLod(0.05, true, videoItem)).toBe("proxy");
  });

  it("uses the proxy while a thumbnail is needed but not generated yet", () => {
    expect(getVideoLod(thumbnailBandZoom, false, videoItem)).toBe("proxy");
  });

  it("requests thumbnails only in the thumbnail-size band", () => {
    expect(shouldRequestVideoThumbnail(thumbnailBandZoom, videoItem)).toBe(
      true,
    );
    expect(shouldRequestVideoThumbnail(0.5, videoItem)).toBe(false);
    expect(shouldRequestVideoThumbnail(0.05, videoItem)).toBe(false);
  });

  it("uses hysteresis so video LOD changes once per zoom boundary crossing", () => {
    const zooms = [
      0.2, 0.13, 0.12, 0.115, 0.112, 0.11, 0.112, 0.115, 0.12, 0.13, 0.2,
    ];
    let current = getVideoLod(zooms[0], true, videoItem);
    let transitions = 0;

    for (const zoom of zooms.slice(1)) {
      const next = getVideoLod(zoom, true, videoItem, current);
      if (next !== current) transitions += 1;
      current = next;
    }

    expect(transitions).toBe(2);
    expect(current).toBe("video");
  });
});

describe("image level of detail", () => {
  const imageItem: MediaItem = {
    id: "image-1",
    type: "image",
    filePath: "/tmp/image.png",
    url: "asset:///tmp/image.png",
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
  };

  it("uses hysteresis so image LOD changes once per zoom boundary crossing", () => {
    const zooms = [1, 0.8, 0.7, 0.64, 0.63, 0.64, 0.7, 0.8, 0.92, 0.93, 1];
    let current = getImageLod(zooms[0], imageItem);
    let transitions = 0;

    for (const zoom of zooms.slice(1)) {
      const next = getImageLod(zoom, imageItem, current);
      if (next !== current) transitions += 1;
      current = next;
    }

    expect(transitions).toBe(2);
    expect(current).toBe("full");
  });
});

describe("video timeline helpers", () => {
  it("clamps scrub times to the playable range", () => {
    expect(clampVideoTime(-5, 20)).toBe(0);
    expect(clampVideoTime(8, 20)).toBe(8);
    expect(clampVideoTime(25, 20)).toBe(20);
  });

  it("treats invalid durations as the start of the video", () => {
    expect(clampVideoTime(5, 0)).toBe(0);
    expect(clampVideoTime(5, Number.NaN)).toBe(0);
  });
});
