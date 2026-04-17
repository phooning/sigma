import { RefObject, WheelEvent } from "react";
import { MediaItem, Viewport } from "../utils/media.types";
import { v4 as uuidv4 } from "uuid";
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "../utils/media";
import { convertFileSrc } from "@tauri-apps/api/core";

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
      const createItem = (w: number, h: number): MediaItem => ({
        id: uuidv4(),
        type: isVideo ? "video" : "image",
        filePath,
        url,
        x: centerX + index * 1350,
        y: centerY,
        width: 1280,
        height: w ? (h / w) * 1280 : 720,
      });

      if (isImage) {
        const img = new Image();
        img.onload = () => resolve(createItem(img.width, img.height));
        img.onerror = () => resolve(createItem(1280, 720));
        img.src = url;
      } else {
        const video = document.createElement("video");
        video.onloadedmetadata = () =>
          resolve(createItem(video.videoWidth, video.videoHeight));
        video.onerror = () => resolve(createItem(1280, 720));
        video.src = url;
      }
    });
  });
};
