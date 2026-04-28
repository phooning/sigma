import type {
  NativeControllerSnapshot,
  NativeVideoManifest,
  NativeVideoProfile,
} from "../components/native-video/types";
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

export const createBenchNativeVideoManifest = (
  assetCount: number,
): NativeVideoManifest => ({
  canvasWidth: BENCH_CANVAS_SIZE.width,
  canvasHeight: BENCH_CANVAS_SIZE.height,
  viewportZoom: BENCH_VIEWPORT.zoom,
  assets: createBenchItems(assetCount, "video").map((item, index) => ({
    id: item.id,
    path: item.filePath,
    sourceWidth: item.sourceWidth ?? 1920,
    sourceHeight: item.sourceHeight ?? 1080,
    screenX: (item.x + BENCH_VIEWPORT.x) * BENCH_VIEWPORT.zoom,
    screenY: (item.y + BENCH_VIEWPORT.y) * BENCH_VIEWPORT.zoom,
    renderedWidthPx: item.width * BENCH_VIEWPORT.zoom,
    renderedHeightPx: item.height * BENCH_VIEWPORT.zoom,
    visibleAreaPx: item.width * item.height * BENCH_VIEWPORT.zoom,
    focusWeight: index % 6 === 0 ? 2.5 : 1,
    centerWeight: 0.75,
    targetFps: 60,
  })),
});

export const createBenchNativeVideoProfile = (): NativeVideoProfile => ({
  baseCaseValidated: true,
  safeBudgetBytesPerSec: 16 * 1024 * 1024 * 1024,
});

export const createBenchNativeControllerSnapshot = (
  assetCount: number,
): NativeControllerSnapshot => ({
  profile: createBenchNativeVideoProfile(),
  allocations: Array.from({ length: assetCount }, (_, index) => ({
    assetId: `video-${index}`,
    streamId: index + 1,
    state: index % 4 === 0 ? "thumbnail" : "active",
    decodeWidth: index % 4 === 0 ? 426 : 1280,
    decodeHeight: index % 4 === 0 ? 240 : 720,
    fps: 60,
  })),
});

export const createBenchProbeImagePaths = (count: number) =>
  Array.from({ length: count }, (_, index) => `/bench/image-${index}.png`);
