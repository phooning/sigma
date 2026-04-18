import { useEffect, useRef } from "react";
import { CropInsets, MediaItem } from "../utils/media.types";

const THUMBNAIL_MAX_SCREEN_WIDTH = 360;
const PROXY_MAX_SCREEN_WIDTH = 96;
const PROXY_MAX_SCREEN_HEIGHT = 72;

interface VideoMediaProps {
  url: string;
  crop: CropInsets;
  item: MediaItem;
  isInViewport: boolean;
  zoom: number;
  onThumbnailNeeded?: (item: MediaItem) => void;
}

type VideoLod = "video" | "thumbnail" | "proxy";

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

export function VideoMedia({
  url,
  crop,
  item,
  isInViewport,
  zoom,
  onThumbnailNeeded,
}: VideoMediaProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lod = getVideoLod(zoom, !!item.thumbnailUrl, item);

  useEffect(() => {
    if (!item.thumbnailUrl && shouldRequestVideoThumbnail(zoom, item)) {
      onThumbnailNeeded?.(item);
    }
  }, [item, onThumbnailNeeded, zoom]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (lod === "video" && isInViewport) {
      const playPromise = video.play();
      playPromise?.catch(() => {
        // Playback can still be blocked by the browser/runtime; the next
        // visibility change will retry.
      });
    } else {
      video.pause();
    }
  }, [isInViewport, lod]);

  const mediaStyle = {
    left: -crop.left,
    top: -crop.top,
    width: item.width + crop.left + crop.right,
    height: item.height + crop.top + crop.bottom,
  };

  if (lod === "thumbnail" && item.thumbnailUrl) {
    return (
      <img
        className="media-content video-lod-thumbnail"
        src={item.thumbnailUrl}
        alt="video thumbnail"
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        style={mediaStyle}
      />
    );
  }

  if (lod === "proxy") {
    return (
      <div className="video-lod-proxy" aria-label="video proxy">
        <span className="video-lod-icon" aria-hidden="true" />
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      className="media-content"
      src={url}
      autoPlay={isInViewport}
      preload={isInViewport ? "auto" : "metadata"}
      loop
      muted
      playsInline
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      style={mediaStyle}
    />
  );
}
