import { MediaItem } from "../utils/media.types";

const THUMBNAIL_MAX_SCREEN_WIDTH = 144;
const PROXY_MAX_SCREEN_WIDTH = 96;
const PROXY_MAX_SCREEN_HEIGHT = 72;

export type VideoLod = "video" | "thumbnail" | "proxy";

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

export const formatVideoTime = (time: number) => {
  const safeTime = Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0;
  const minutes = Math.floor(safeTime / 60);
  const seconds = safeTime % 60;

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
): VideoLod => {
  const screenWidth = item.width * zoom;
  const screenHeight = item.height * zoom;

  if (
    screenWidth <= PROXY_MAX_SCREEN_WIDTH ||
    screenHeight <= PROXY_MAX_SCREEN_HEIGHT
  ) {
    return "proxy";
  }

  if (screenWidth <= THUMBNAIL_MAX_SCREEN_WIDTH) {
    return hasThumbnail ? "thumbnail" : "proxy";
  }

  return "video";
};

export const shouldRequestVideoThumbnail = (zoom: number, item: MediaItem) => {
  const screenWidth = item.width * zoom;
  const screenHeight = item.height * zoom;

  return (
    screenWidth <= THUMBNAIL_MAX_SCREEN_WIDTH &&
    screenWidth > PROXY_MAX_SCREEN_WIDTH &&
    screenHeight > PROXY_MAX_SCREEN_HEIGHT
  );
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
