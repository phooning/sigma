import { describe, expect, it } from "vitest";
import { MediaItem } from "../utils/media.types";
import { clampVideoTime, getVideoLod, shouldRequestVideoThumbnail } from "./Video";

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
    expect(shouldRequestVideoThumbnail(thumbnailBandZoom, videoItem)).toBe(true);
    expect(shouldRequestVideoThumbnail(0.5, videoItem)).toBe(false);
    expect(shouldRequestVideoThumbnail(0.05, videoItem)).toBe(false);
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
