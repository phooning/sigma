import type { MediaItem, MediaItemType, Viewport } from "../utils/media.types";

export const BENCH_CANVAS_SIZE = {
  width: 1920,
  height: 1080,
};

export const BENCH_VIEWPORT: Viewport = {
  x: -480,
  y: -320,
  zoom: 0.85,
};

export const createBenchItems = (
  count: number,
  type: MediaItemType = "image",
): MediaItem[] =>
  Array.from({ length: count }, (_, index) => {
    const column = index % 40;
    const row = Math.floor(index / 40);
    const width = 320 + (index % 5) * 40;
    const height = 180 + (index % 4) * 30;

    return {
      id: `${type}-${index}`,
      type,
      filePath: `/bench/${type}-${index}.${type === "image" ? "png" : "mp4"}`,
      url: `bench://${type}-${index}`,
      x: column * 360,
      y: row * 240,
      width,
      height,
      sourceWidth: width,
      sourceHeight: height,
      ...(type === "video" ? { duration: 10 } : {}),
    };
  });
