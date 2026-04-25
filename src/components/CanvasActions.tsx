import { RefObject, WheelEvent } from "react";
import { MediaItem, Viewport } from "../utils/media.types";
import { v4 as uuidv4 } from "uuid";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "../utils/media";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { applyPanDelta, applyZoomAtPoint } from "../utils/viewportMath";

export type WheelInputType = "trackpad-pan" | "zoom";

const DEFAULT_MEDIA_WIDTH = 1280;
const DEFAULT_VIDEO_HEIGHT = 720;
const DEFAULT_IMAGE_HEIGHT = 720;
const DROP_IMPORT_CONCURRENCY = 6;
const IMAGE_PROBE_BATCH_SIZE = 8;
// 100 MB
const LARGE_VIDEO_LOAD_THRESHOLD_BYTES = 100 * 1024 * 1024;

type MediaFileInfo = {
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
};

type ImageProbe = {
  path: string;
  width: number;
  height: number;
  size: number;
};

type SupportedDropMedia = {
  filePath: string;
  index: number;
  type: MediaItem["type"];
  url: string;
};

const probeMedia = async (path: string): Promise<MediaFileInfo> => {
  try {
    // Probe the media natively through Rust instead of metadata.
    const info = await invoke<MediaFileInfo | null>("probe_media", {
      path,
    });

    return info ?? {};
  } catch {
    return {};
  }
};

const probeImages = async (paths: string[]): Promise<Map<string, ImageProbe>> => {
  if (paths.length === 0) return new Map();

  try {
    const probes = await invoke<ImageProbe[]>("probe_images", { paths });
    return new Map(probes.map((probe) => [probe.path, probe]));
  } catch {
    return new Map();
  }
};

const chunk = <T,>(values: T[], size: number) => {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
};

const runWithConcurrency = async (
  tasks: Array<() => Promise<void>>,
  concurrency: number,
) => {
  let nextTaskIndex = 0;

  const workerCount = Math.min(concurrency, tasks.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const taskIndex = nextTaskIndex;
        nextTaskIndex += 1;

        const task = tasks[taskIndex];
        if (!task) return;

        await task();
      }
    }),
  );
};

export const isMacOS = () =>
  /mac/i.test(navigator.platform) || navigator.userAgent.includes("Macintosh");

export const getWheelInputType = (e: WheelEvent): WheelInputType =>
  e.ctrlKey ? "zoom" : "trackpad-pan";

export const handlePanAction = ({
  e,
  viewport,
}: {
  e: WheelEvent;
  viewport: Viewport;
}) => applyPanDelta(viewport, e.deltaX, e.deltaY);

export const handleZoomAction = ({
  e,
  viewport,
  containerRef,
}: {
  e: WheelEvent;
  viewport: Viewport;
  containerRef: RefObject<HTMLDivElement | null>;
}) => {
  if (containerRef.current) {
    const rect = containerRef.current.getBoundingClientRect();
    return applyZoomAtPoint({
      viewport,
      deltaY: e.deltaY,
      mouseX: e.clientX - rect.left,
      mouseY: e.clientY - rect.top,
    });
  }
};

export const onDropMedia = async ({
  paths,
  viewportRef,
}: {
  paths: string[];
  viewportRef: RefObject<Viewport>;
}) => {
  const supportedMedia = paths.flatMap<SupportedDropMedia>((filePath, index) => {
    const ext = filePath.split(".").pop()?.toLowerCase();
    const isVideo = VIDEO_EXTENSIONS.includes(ext ?? "");
    const isImage = IMAGE_EXTENSIONS.includes(ext ?? "");

    if (!isVideo && !isImage) return [];

    return [
      {
        filePath,
        index,
        type: isVideo ? "video" : "image",
        url: convertFileSrc(filePath),
      },
    ];
  });

  if (supportedMedia.length === 0) {
    return [];
  }

  const centerX =
    -viewportRef.current.x + window.innerWidth / 2 / viewportRef.current.zoom;
  const centerY =
    -viewportRef.current.y + window.innerHeight / 2 / viewportRef.current.zoom;
  const itemsByIndex = new Map<number, MediaItem>();
  const createItem = (
    media: SupportedDropMedia,
    width: number,
    height: number,
    extra: Partial<MediaItem> = {},
  ): MediaItem => ({
    id: uuidv4(),
    type: media.type,
    filePath: media.filePath,
    url: media.url,
    x: centerX + media.index * 1350,
    y: centerY,
    width: DEFAULT_MEDIA_WIDTH,
    height: width ? (height / width) * DEFAULT_MEDIA_WIDTH : DEFAULT_VIDEO_HEIGHT,
    ...extra,
  });

  const tasks: Array<() => Promise<void>> = [];
  const imageMedia = supportedMedia.filter((media) => media.type === "image");

  for (const imageBatch of chunk(imageMedia, IMAGE_PROBE_BATCH_SIZE)) {
    tasks.push(async () => {
      const probes = await probeImages(imageBatch.map((media) => media.filePath));

      imageBatch.forEach((media) => {
        const probe = probes.get(media.filePath);
        const width = probe?.width || DEFAULT_MEDIA_WIDTH;
        const height = probe?.height || DEFAULT_IMAGE_HEIGHT;

        itemsByIndex.set(
          media.index,
          createItem(media, width, height, {
            fileSize: probe?.size,
            sourceWidth: width,
            sourceHeight: height,
          }),
        );
      });
    });
  }

  supportedMedia
    .filter((media) => media.type === "video")
    .forEach((media) => {
      tasks.push(async () => {
        const { width, height, duration, size } = await probeMedia(media.filePath);
        const mediaWidth = width || DEFAULT_MEDIA_WIDTH;
        const mediaHeight = height || DEFAULT_VIDEO_HEIGHT;

        itemsByIndex.set(
          media.index,
          createItem(media, mediaWidth, mediaHeight, {
            fileSize: size,
            duration,
            sourceWidth: mediaWidth,
            sourceHeight: mediaHeight,
            deferVideoLoad:
              typeof size === "number" && size >= LARGE_VIDEO_LOAD_THRESHOLD_BYTES,
          }),
        );
      });
    });

  await runWithConcurrency(tasks, DROP_IMPORT_CONCURRENCY);

  return supportedMedia
    .map((media) => itemsByIndex.get(media.index))
    .filter((item): item is MediaItem => item !== undefined);
};
