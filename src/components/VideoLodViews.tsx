import { useEffect, useRef } from "react";
import type {
  VideoLoadProxyProps,
  VideoThumbnailProps,
} from "./VideoLodViews.types";

export function VideoLoadProxy({
  cropBoxStyle,
  onLoadRequested,
  thumbnailUrl,
}: VideoLoadProxyProps) {
  return (
    <button
      type="button"
      className="video-lod-proxy video-load-proxy"
      aria-label="Load video"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onLoadRequested();
      }}
    >
      {thumbnailUrl && (
        <div className="media-crop-box" style={cropBoxStyle}>
          <img
            className="media-content video-lod-thumbnail video-load-thumbnail"
            src={thumbnailUrl}
            alt=""
            draggable={false}
          />
        </div>
      )}
      <span className="video-lod-icon" aria-hidden="true" />
      <span className="video-load-label">Load video</span>
    </button>
  );
}

export function VideoThumbnail({
  cropBoxStyle,
  thumbnailUrl,
  onReadyChange,
}: VideoThumbnailProps) {
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const image = imageRef.current;
    onReadyChange?.(Boolean(image?.complete && image.naturalWidth > 0));
  }, [onReadyChange, thumbnailUrl]);

  return (
    <div className="media-crop-box" style={cropBoxStyle}>
      <img
        ref={imageRef}
        className="media-content video-lod-thumbnail"
        src={thumbnailUrl}
        alt="video thumbnail"
        draggable={false}
        onLoad={() => onReadyChange?.(true)}
        onError={() => onReadyChange?.(false)}
        onDragStart={(e) => e.preventDefault()}
      />
    </div>
  );
}

export function VideoProxy() {
  return (
    <div className="video-lod-proxy">
      <span className="video-lod-icon" aria-hidden="true" />
    </div>
  );
}
