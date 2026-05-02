import type {
  ImageLodState,
  MediaItem,
  VideoLodState,
} from "../utils/media.types";

const VIDEO_LOD = {
  proxy: {
    enter: (width: number, height: number) => width <= 96 || height <= 72,
    exit: (width: number, height: number) => width > 120 && height > 88,
  },
  thumbnail: {
    enter: (width: number) => width <= 144,
    exit: (width: number) => width > 176,
  },
};

export const IMAGE_LOD = {
  preview256: {
    enter: (width: number, height: number) => width <= 256 || height <= 144,
    exit: (width: number, height: number) => width > 320 && height > 176,
  },
  preview1024: {
    enter: (longEdge: number) => longEdge <= 768,
    exit: (longEdge: number) => longEdge > 1100,
  },
  full: {
    enter: (longEdge: number) => longEdge > 1100,
    exit: (longEdge: number) => longEdge < 768,
  },
};

export type VideoLod = VideoLodState;
export type ImageLod = ImageLodState;

export interface LoopState {
  enabled: boolean;
  a: number | null;
  b: number | null;
}

export const initialLoopState: LoopState = {
  enabled: false,
  a: null,
  b: null,
};

export const clampVideoTime = (time: number, duration: number) => {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  return Math.min(Math.max(time, 0), duration);
};

export const formatVideoTime = (
  time: number,
  { includeSubseconds = false }: { includeSubseconds?: boolean } = {},
) => {
  const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0;
  const roundedTime = includeSubseconds
    ? Number(safeTime.toFixed(1))
    : Math.floor(safeTime);
  const wholeSeconds = Math.floor(roundedTime);
  const minutes = Math.floor(wholeSeconds / 60);
  const seconds = wholeSeconds % 60;
  const tenths = Math.round(roundedTime * 10) % 10;

  if (includeSubseconds && tenths > 0) {
    return `${minutes}:${seconds.toString().padStart(2, "0")}.${tenths}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

export const getFiniteDuration = (duration: number | undefined) =>
  typeof duration === "number" && Number.isFinite(duration) && duration > 0
    ? duration
    : 0;

export const getVideoLod = (
  zoom: number,
  hasThumbnail: boolean,
  item: MediaItem,
  currentLod: VideoLod = item.videoLod ?? "video",
): VideoLod => {
  const screenWidth = item.width * zoom;
  const screenHeight = item.height * zoom;

  if (
    currentLod === "proxy" &&
    !VIDEO_LOD.proxy.exit(screenWidth, screenHeight)
  ) {
    return "proxy";
  }

  if (currentLod === "thumbnail") {
    if (!hasThumbnail || VIDEO_LOD.proxy.enter(screenWidth, screenHeight)) {
      return "proxy";
    }

    if (!VIDEO_LOD.thumbnail.exit(screenWidth)) {
      return "thumbnail";
    }

    return "video";
  }

  if (
    currentLod === "video" &&
    !VIDEO_LOD.thumbnail.enter(screenWidth) &&
    !VIDEO_LOD.proxy.enter(screenWidth, screenHeight)
  ) {
    return "video";
  }

  if (VIDEO_LOD.proxy.enter(screenWidth, screenHeight)) {
    return "proxy";
  }

  if (VIDEO_LOD.thumbnail.enter(screenWidth)) {
    return hasThumbnail ? "thumbnail" : "proxy";
  }

  return "video";
};

export const shouldRequestVideoThumbnail = (zoom: number, item: MediaItem) => {
  const screenWidth = item.width * zoom;
  const screenHeight = item.height * zoom;

  return screenWidth <= 144 && screenWidth > 96 && screenHeight > 72;
};

export const getLoopRange = (loop: LoopState) => {
  if (loop.a === null || loop.b === null || loop.a === loop.b) {
    return null;
  }

  return {
    start: Math.min(loop.a, loop.b),
    end: Math.max(loop.a, loop.b),
  };
};

export const getImageLod = (
  zoom: number,
  item: MediaItem,
  currentLod: ImageLod = item.imageLod ?? "full",
): ImageLod => {
  const screenWidth = item.width * zoom;
  const screenHeight = item.height * zoom;
  const longEdge = Math.max(screenWidth, screenHeight);

  if (
    currentLod === "preview256" &&
    !IMAGE_LOD.preview256.exit(screenWidth, screenHeight)
  ) {
    return "preview256";
  }

  if (currentLod === "preview1024") {
    if (IMAGE_LOD.preview256.enter(screenWidth, screenHeight)) {
      return "preview256";
    }

    if (!IMAGE_LOD.preview1024.exit(longEdge)) {
      return "preview1024";
    }

    return "full";
  }

  if (currentLod === "full" && !IMAGE_LOD.full.exit(longEdge)) {
    return "full";
  }

  if (IMAGE_LOD.preview256.enter(screenWidth, screenHeight)) {
    return "preview256";
  }

  if (IMAGE_LOD.full.enter(longEdge)) {
    return "full";
  }

  return "preview1024";
};
