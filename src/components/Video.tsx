import { useCallback, useEffect, useRef, useState } from "react";
import { CropInsets, MediaItem } from "../utils/media.types";

const THUMBNAIL_MAX_SCREEN_WIDTH = 144;
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
  const [isLoadRequested, setIsLoadRequested] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lod = isLoadRequested
    ? "video"
    : getVideoLod(zoom, !!item.thumbnailUrl, item);
  const shouldDeferVideoLoad = !!item.deferVideoLoad && !isLoadRequested;

  useEffect(() => {
    if (
      !item.thumbnailUrl &&
      (item.deferVideoLoad || shouldRequestVideoThumbnail(zoom, item))
    ) {
      onThumbnailNeeded?.(item);
    }
  }, [item, onThumbnailNeeded, zoom]);

  const playVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video || lod !== "video" || !isInViewport || shouldDeferVideoLoad) {
      return;
    }

    const playPromise = video.play();
    playPromise
      ?.then(() => setPlaybackError(null))
      .catch(() => {
        setPlaybackError("Playback failed. This file may need transcoding.");
      });
  }, [isInViewport, lod, shouldDeferVideoLoad]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (lod === "video" && isInViewport && !shouldDeferVideoLoad) {
      playVideo();
    } else {
      video.pause();
    }
  }, [isInViewport, lod, playVideo, shouldDeferVideoLoad]);

  const mediaStyle = {
    left: -crop.left,
    top: -crop.top,
    width: item.width + crop.left + crop.right,
    height: item.height + crop.top + crop.bottom,
  };

  if (shouldDeferVideoLoad) {
    return (
      <button
        className="video-lod-proxy video-load-proxy"
        aria-label="Load video"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setPlaybackError(null);
          setIsLoadRequested(true);
        }}
      >
        {item.thumbnailUrl && (
          <img
            className="media-content video-lod-thumbnail video-load-thumbnail"
            src={item.thumbnailUrl}
            alt=""
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            style={mediaStyle}
          />
        )}
        <span className="video-lod-icon" aria-hidden="true" />
        <span className="video-load-label">Load video</span>
      </button>
    );
  }

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
    <>
      <video
        ref={videoRef}
        className={`media-content ${isLoadRequested ? "video-load-requested" : ""}`}
        src={url}
        autoPlay={isInViewport}
        preload={isLoadRequested && isInViewport ? "auto" : "metadata"}
        controls={isLoadRequested}
        loop
        muted
        playsInline
        draggable={false}
        onLoadedMetadata={playVideo}
        onCanPlay={playVideo}
        onError={() => {
          setPlaybackError("Playback failed. This file may need transcoding.");
        }}
        onDragStart={(e) => e.preventDefault()}
        style={mediaStyle}
      />
      {playbackError && (
        <div className="video-playback-error" role="status">
          {playbackError}
        </div>
      )}
    </>
  );
}
