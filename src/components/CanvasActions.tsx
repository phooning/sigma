import { RefObject, WheelEvent } from "react";
import { MediaItem, Viewport } from "../utils/media.types";
import { v4 as uuidv4 } from "uuid";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "../utils/media";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type WheelInputType = "trackpad-pan" | "zoom";
type VideoLodAssets = Pick<MediaItem, "thumbnailPath" | "thumbnailUrl">;

export const isMacOS = () =>
  /mac/i.test(navigator.platform) || navigator.userAgent.includes("Macintosh");

export const getWheelInputType = (e: WheelEvent): WheelInputType => {
  if (!isMacOS()) return "zoom";

  const isPinchGesture = e.ctrlKey;
  if (isPinchGesture) return "zoom";

  const isPixelScroll = e.deltaMode === 0;
  const hasHorizontalScroll = Math.abs(e.deltaX) > 0;
  const hasFractionalDelta = !Number.isInteger(e.deltaY);
  const hasSmallDelta = Math.abs(e.deltaY) < 50;
  const isLargeIntegerWheelStep =
    Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 100;

  if (
    isPixelScroll &&
    !isLargeIntegerWheelStep &&
    (hasHorizontalScroll || hasFractionalDelta || hasSmallDelta)
  ) {
    return "trackpad-pan";
  }

  return "zoom";
};

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

const generateVideoThumbnail = async (
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

export const onDropMedia = ({
  paths,
  viewportRef,
  onThumbnailGenerated,
}: {
  paths: string[];
  viewportRef: RefObject<Viewport>;
  onThumbnailGenerated?: (id: string, lodAssets: VideoLodAssets) => void;
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
        lodAssets: VideoLodAssets = {},
      ): MediaItem => ({
        id: uuidv4(),
        type: isVideo ? "video" : "image",
        filePath,
        url,
        ...lodAssets,
        x: centerX + index * 1350,
        y: centerY,
        width: 1280,
        height: w ? (h / w) * 1280 : 720,
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
        const video = document.createElement("video");
        video.preload = "metadata";
        video.onloadedmetadata = () => {
          const item = createItem(video.videoWidth, video.videoHeight);
          resolve(item);
          video.src = "";

          void generateVideoThumbnail(filePath).then((lodAssets) => {
            if (lodAssets.thumbnailUrl) {
              onThumbnailGenerated?.(item.id, lodAssets);
            }
          });
        };
        video.onerror = () => {
          resolve(createItem(1280, 720));
          video.src = "";
        };
        video.src = url;
      }
    });
  });
};
