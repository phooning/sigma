import { RefObject, WheelEvent } from "react";
import { MediaItem, Viewport } from "../utils/media.types";
import { v4 as uuidv4 } from "uuid";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "../utils/media";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type WheelInputType = "trackpad-pan" | "zoom";

const DEFAULT_MEDIA_WIDTH = 1280;
const DEFAULT_VIDEO_HEIGHT = 720;
// 100 MB
const LARGE_VIDEO_LOAD_THRESHOLD_BYTES = 100 * 1024 * 1024;

type MediaFileInfo = {
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
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
}) => ({
  x: viewport.x - e.deltaX / viewport.zoom,
  y: viewport.y - e.deltaY / viewport.zoom,
  zoom: viewport.zoom,
});

export const handleZoomAction = ({
  e,
  viewport,
  containerRef,
}: {
  e: WheelEvent;
  viewport: Viewport;
  containerRef: RefObject<HTMLDivElement | null>;
}) => {
  const zoomFactor = -e.deltaY * 0.001;
  const newZoom = Math.max(0.05, Math.min(viewport.zoom * (1 + zoomFactor), 5));

  if (containerRef.current) {
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const prevX = mouseX / viewport.zoom - viewport.x;
    const prevY = mouseY / viewport.zoom - viewport.y;

    const newX = mouseX / newZoom - prevX;
    const newY = mouseY / newZoom - prevY;

    return { x: newX, y: newY, zoom: newZoom };
  }
};

export const onDropMedia = ({
  paths,
  viewportRef,
}: {
  paths: string[];
  viewportRef: RefObject<Viewport>;
}) => {
  const centerX =
    -viewportRef.current.x + window.innerWidth / 2 / viewportRef.current.zoom;
  const centerY =
    -viewportRef.current.y + window.innerHeight / 2 / viewportRef.current.zoom;

  return paths.map((filePath, index) => {
    return new Promise<MediaItem | null>((resolve) => {
      const ext = filePath.split(".").pop()?.toLowerCase();

      const isVideo = VIDEO_EXTENSIONS.includes(ext ?? "");
      const isImage = IMAGE_EXTENSIONS.includes(ext ?? "");

      if (!isVideo && !isImage) return resolve(null);

      const url = convertFileSrc(filePath);
      const createItem = (
        w: number,
        h: number,
        extra: Partial<MediaItem> = {},
      ): MediaItem => ({
        id: uuidv4(),
        type: isVideo ? "video" : "image",
        filePath,
        url,
        x: centerX + index * 1350,
        y: centerY,
        width: DEFAULT_MEDIA_WIDTH,
        height: w ? (h / w) * DEFAULT_MEDIA_WIDTH : DEFAULT_VIDEO_HEIGHT,
        ...extra,
      });

      if (isImage) {
        const img = new Image();
        img.onload = () => {
          resolve(createItem(img.width, img.height));
          img.src = "";
        };
        img.onerror = () => {
          resolve(createItem(1280, 720));
          img.src = "";
        };
        img.src = url;
      } else {
        probeMedia(filePath).then(({ width, height, duration, size }) => {
          const mediaWidth = width || DEFAULT_MEDIA_WIDTH;
          const mediaHeight = height || DEFAULT_VIDEO_HEIGHT;

          resolve(
            createItem(mediaWidth, mediaHeight, {
              fileSize: size,
              duration,
              sourceWidth: mediaWidth,
              sourceHeight: mediaHeight,
              deferVideoLoad:
                typeof size === "number" &&
                size >= LARGE_VIDEO_LOAD_THRESHOLD_BYTES,
            }),
          );
        });
      }
    });
  });
};
