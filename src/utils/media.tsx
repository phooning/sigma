import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { type CSSProperties, useCallback, useEffect, useRef } from "react";
import type {
  CropHandle,
  CropInsets,
  ImageLodAssets,
  ImagePreviewDimension,
  MediaItem,
  SetItems,
  VideoLodAssets,
} from "./media.types";
import { getImageLod, shouldRequestVideoThumbnail } from "./videoUtils";
import { getViewBounds } from "./viewport";
import type { ViewBounds } from "./viewport.types";

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

export const getCropBoxStyle = (
  item: MediaItem,
  crop: CropInsets,
): CSSProperties => ({
  left: -crop.left,
  top: -crop.top,
  width: item.width + crop.left + crop.right,
  height: item.height + crop.top + crop.bottom,
});

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

let viewportGeneration = 0;
const viewportGenerationListeners = new Set<(generation: number) => void>();

export const advanceViewportGeneration = () => {
  viewportGeneration += 1;
  for (const listener of viewportGenerationListeners) {
    listener(viewportGeneration);
  }
  return viewportGeneration;
};

export const getViewportGeneration = () => viewportGeneration;

const subscribeViewportGeneration = (
  listener: (generation: number) => void,
) => {
  viewportGenerationListeners.add(listener);
  return () => {
    viewportGenerationListeners.delete(listener);
  };
};

export type MediaQueueOptions = {
  generation?: number;
  viewBounds?: Pick<
    ViewBounds,
    "viewLeft" | "viewTop" | "viewRight" | "viewBottom"
  >;
};

type DecodePriority = "visible" | "prefetch" | "background";

const hasMatchingAssetSource = (
  currentItem: MediaItem,
  requestedItem: MediaItem,
) =>
  currentItem.id === requestedItem.id &&
  currentItem.type === requestedItem.type &&
  currentItem.filePath === requestedItem.filePath;

const intersectsViewBounds = (
  item: Pick<MediaItem, "x" | "y" | "width" | "height">,
  viewBounds?: MediaQueueOptions["viewBounds"],
  margin = 0,
) => {
  if (!viewBounds) return true;

  return (
    item.x + item.width >= viewBounds.viewLeft - margin &&
    item.x <= viewBounds.viewRight + margin &&
    item.y + item.height >= viewBounds.viewTop - margin &&
    item.y <= viewBounds.viewBottom + margin
  );
};

const computeDecodePriority = (
  item: Pick<MediaItem, "x" | "y" | "width" | "height">,
  viewBounds?: MediaQueueOptions["viewBounds"],
): DecodePriority => {
  if (!viewBounds) return "visible";
  if (intersectsViewBounds(item, viewBounds)) return "visible";

  const prefetchMargin = Math.max(
    viewBounds.viewRight - viewBounds.viewLeft,
    viewBounds.viewBottom - viewBounds.viewTop,
  );

  return intersectsViewBounds(item, viewBounds, prefetchMargin)
    ? "prefetch"
    : "background";
};

export const computeLod = (
  item: MediaItem,
  zoom: number,
): ImagePreviewDimension | null => {
  if (item.type === "video") {
    if (item.thumbnailUrl) return null;
    return item.deferVideoLoad || shouldRequestVideoThumbnail(zoom, item)
      ? 256
      : null;
  }

  const imageLod = getImageLod(zoom, item);
  if (imageLod === "preview256") return 256;
  if (imageLod === "preview1024" || (imageLod === "full" && zoom < 1)) {
    return 1024;
  }

  return null;
};

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

export const generateImagePreview = async (
  filePath: string,
  maxDimension: ImagePreviewDimension,
): Promise<ImageLodAssets> => {
  try {
    const previewPath = await invoke<string | null>("generate_image_preview", {
      path: filePath,
      maxDimension,
    });

    if (!previewPath) return {};

    if (maxDimension === 256) {
      return {
        imagePreview256Path: previewPath,
        imagePreview256Url: convertFileSrc(previewPath),
      };
    }

    return {
      imagePreview1024Path: previewPath,
      imagePreview1024Url: convertFileSrc(previewPath),
    };
  } catch (err) {
    console.warn("Failed to generate image preview:", err);
    return {};
  }
};

const decodePreview = async ({
  item,
  lod,
  generation,
  priority,
}: {
  item: MediaItem;
  lod: ImagePreviewDimension;
  generation: number;
  priority: DecodePriority;
}) => {
  try {
    return await invoke<string | null>("request_decode", {
      itemId: item.id,
      path: item.filePath,
      lod,
      generation,
      priority,
    });
  } catch (err) {
    console.warn("Failed to request media decode:", err);
    return null;
  }
};

const assetsForDecodedPath = (
  item: MediaItem,
  lod: ImagePreviewDimension,
  decodedPath: string,
): ImageLodAssets | VideoLodAssets => {
  if (item.type === "video") {
    return {
      thumbnailPath: decodedPath,
      thumbnailUrl: convertFileSrc(decodedPath),
    };
  }

  if (lod === 256) {
    return {
      imagePreview256Path: decodedPath,
      imagePreview256Url: convertFileSrc(decodedPath),
    };
  }

  return {
    imagePreview1024Path: decodedPath,
    imagePreview1024Url: convertFileSrc(decodedPath),
  };
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

export function useImagePreviewQueue(setItems: SetItems) {
  const requestedRef = useRef<Map<string, number>>(new Map());

  const requestImagePreview = useCallback(
    (
      item: MediaItem,
      maxDimension: ImagePreviewDimension,
      options: MediaQueueOptions = {},
    ) => {
      if (item.type !== "image") return;

      if (
        (maxDimension === 256 && item.imagePreview256Url) ||
        (maxDimension === 1024 && item.imagePreview1024Url)
      ) {
        return;
      }

      const currentGeneration = getViewportGeneration();
      const generation = options.generation ?? currentGeneration;
      if (generation < currentGeneration) return;

      const requestKey = `${item.id}:${maxDimension}`;
      if (requestedRef.current.has(requestKey)) return;

      requestedRef.current.set(requestKey, generation);
      void decodePreview({
        item,
        lod: maxDimension,
        generation,
        priority: computeDecodePriority(item, options.viewBounds),
      }).then((decodedPath) => {
        if (requestedRef.current.get(requestKey) === generation) {
          requestedRef.current.delete(requestKey);
        }

        if (!decodedPath) return;

        const previewAssets = assetsForDecodedPath(
          item,
          maxDimension,
          decodedPath,
        ) as ImageLodAssets;
        const previewKey =
          maxDimension === 256 ? "imagePreview256Url" : "imagePreview1024Url";

        if (!previewAssets[previewKey]) return;

        setItems((prev) => {
          let changed = false;
          const nextItems = prev.map((currentItem) => {
            if (!hasMatchingAssetSource(currentItem, item)) {
              return currentItem;
            }

            if (
              (maxDimension === 256 && currentItem.imagePreview256Url) ||
              (maxDimension === 1024 && currentItem.imagePreview1024Url)
            ) {
              return currentItem;
            }

            changed = true;
            return { ...currentItem, ...previewAssets };
          });

          return changed ? nextItems : prev;
        });
      });
    },
    [setItems],
  );

  return { requestImagePreview };
}

export function useThumbnailQueue(setItems: SetItems) {
  const requestedRef = useRef<Map<string, number>>(new Map());

  const requestThumbnail = useCallback(
    (item: MediaItem, options: MediaQueueOptions = {}) => {
      if (item.type !== "video" || item.thumbnailUrl) return;

      const currentGeneration = getViewportGeneration();
      const generation = options.generation ?? currentGeneration;
      if (generation < currentGeneration) return;

      const priority = computeDecodePriority(item, options.viewBounds);
      if (priority === "background" || requestedRef.current.has(item.id))
        return;

      requestedRef.current.set(item.id, generation);
      void decodePreview({
        item,
        lod: 256,
        generation,
        priority,
      }).then((decodedPath) => {
        if (requestedRef.current.get(item.id) === generation) {
          requestedRef.current.delete(item.id);
        }

        if (!decodedPath) return;

        const lodAssets = assetsForDecodedPath(
          item,
          256,
          decodedPath,
        ) as VideoLodAssets;

        if (!lodAssets.thumbnailUrl) return;

        setItems((prev) => {
          let changed = false;
          const nextItems = prev.map((currentItem) => {
            if (
              !hasMatchingAssetSource(currentItem, item) ||
              currentItem.thumbnailUrl
            ) {
              return currentItem;
            }

            changed = true;
            return { ...currentItem, ...lodAssets };
          });

          return changed ? nextItems : prev;
        });
      });
    },
    [setItems],
  );

  return { requestThumbnail };
}

export function useDecodeArbiterFeeder({
  items,
  getViewport,
  canvasSize,
  setItems,
}: {
  items: MediaItem[];
  getViewport: () => { x: number; y: number; zoom: number };
  canvasSize: { width: number; height: number };
  setItems: SetItems;
}) {
  const { requestImagePreview } = useImagePreviewQueue(setItems);
  const { requestThumbnail } = useThumbnailQueue(setItems);
  const itemsRef = useRef(items);
  const canvasSizeRef = useRef(canvasSize);

  itemsRef.current = items;
  canvasSizeRef.current = canvasSize;

  const feedViewportDecodeRequests = useCallback(
    (generation = getViewportGeneration()) => {
      const viewport = getViewport();
      const viewBounds = getViewBounds(
        viewport,
        canvasSizeRef.current.width,
        canvasSizeRef.current.height,
      );

      for (const item of itemsRef.current) {
        const lod = computeLod(item, viewport.zoom);
        if (!lod) continue;

        if (item.type === "image") {
          requestImagePreview(item, lod, { generation, viewBounds });
        } else {
          requestThumbnail(item, { generation, viewBounds });
        }
      }
    },
    [getViewport, requestImagePreview, requestThumbnail],
  );

  useEffect(
    () => subscribeViewportGeneration(feedViewportDecodeRequests),
    [feedViewportDecodeRequests],
  );

  useEffect(() => {
    feedViewportDecodeRequests();
  }, [feedViewportDecodeRequests, items, canvasSize.width, canvasSize.height]);

  return { requestImagePreview, requestThumbnail };
}
