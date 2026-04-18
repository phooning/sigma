import { describe, expect, it } from "vitest";
import { MediaItem } from "../utils/media.types";
import { getVideoLod } from "./Video";

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

describe("video level of detail", () => {
  it("keeps full video for visible media while it still has useful screen detail", () => {
    expect(getVideoLod(0.5, true, true, videoItem)).toBe("video");
  });

  it("uses thumbnails only once the rendered video is near thumbnail size", () => {
    expect(getVideoLod(0.25, true, true, videoItem)).toBe("thumbnail");
  });

  it("uses the proxy only when the rendered video is extremely small", () => {
    expect(getVideoLod(0.05, true, true, videoItem)).toBe("proxy");
  });

  it("allows offscreen mounted videos to use thumbnails instead of decoding video", () => {
    expect(getVideoLod(1, false, true, videoItem)).toBe("thumbnail");
  });
});
