import { useCallback, useRef } from "react";
import {
  CropHandle,
  CropInsets,
  MediaItem,
  SetItems,
  VideoLodAssets,
} from "./media.types";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "mkv"];
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

export const getCrop = (item: MediaItem): CropInsets => item.crop ?? EMPTY_CROP;

export const getCropRatios = (item: MediaItem) => {
  const crop = getCrop(item);
  const fullWidth = item.width + crop.left + crop.right;
  const fullHeight = item.height + crop.top + crop.bottom;

  return {
    x: fullWidth > 0 ? crop.left / fullWidth : 0,
    y: fullHeight > 0 ? crop.top / fullHeight : 0,
    width: fullWidth > 0 ? item.width / fullWidth : 1,
    height: fullHeight > 0 ? item.height / fullHeight : 1,
    boxWidth: fullWidth,
    boxHeight: fullHeight,
  };
};

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export const CROP_HANDLES: CropHandle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];
export const MIN_MEDIA_SIZE = 100;
export const EMPTY_CROP: CropInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export const generateVideoThumbnail = async (
  filePath: string,
): Promise<VideoLodAssets> => {
  try {
    const thumbnailPath = await invoke<string | null>(
      "generate_video_thumbnail",
      { path: filePath },
    );

    if (!thumbnailPath) return {};

    return {
      thumbnailPath,
      thumbnailUrl: convertFileSrc(thumbnailPath),
    };
  } catch (err) {
    console.warn("Failed to generate video thumbnail:", err);
    return {};
  }
};

export const saveMediaScreenshot = ({
  item,
  outputDirectory,
  currentTime,
}: {
  item: MediaItem;
  outputDirectory?: string;
  currentTime?: number;
}) =>
  invoke<string>("save_media_screenshot", {
    path: item.filePath,
    mediaType: item.type,
    outputDirectory,
    currentTime: currentTime ?? 0,
    crop: getCropRatios(item),
  });

type VideoExportRange = {
  start: number;
  end: number;
} | null;

export const exportMediaVideo = ({
  item,
  outputPath,
  loopRange,
}: {
  item: MediaItem;
  outputPath: string;
  loopRange: VideoExportRange;
}) =>
  invoke<string>("export_video", {
    path: item.filePath,
    outputPath,
    crop: getCropRatios(item),
    startTime: loopRange?.start ?? null,
    endTime: loopRange?.end ?? null,
  });

export function useThumbnailQueue(setItems: SetItems) {
  const queueRef = useRef<MediaItem[]>([]);
  const requestedRef = useRef<Set<string>>(new Set());
  const processingRef = useRef(false);

  const processQueue = useCallback(async () => {
    if (processingRef.current) return;

    const item = queueRef.current.shift();
    if (!item) return;

    processingRef.current = true;
    try {
      const lodAssets = await generateVideoThumbnail(item.filePath);
      if (lodAssets.thumbnailUrl) {
        setItems((prev) =>
          prev.map((i) =>
            i.id === item.id && !i.thumbnailUrl ? { ...i, ...lodAssets } : i,
          ),
        );
      }
    } finally {
      processingRef.current = false;
      void processQueue();
    }
  }, [setItems]);

  const requestThumbnail = useCallback(
    (item: MediaItem) => {
      if (
        item.type !== "video" ||
        item.thumbnailUrl ||
        requestedRef.current.has(item.id)
      )
        return;

      requestedRef.current.add(item.id);
      queueRef.current.push(item);
      void processQueue();
    },
    [processQueue],
  );

  return { requestThumbnail };
}
