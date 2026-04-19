import type {
  VideoLoadProxyProps,
  VideoThumbnailProps,
} from "./VideoLodViews.types";

export function VideoLoadProxy({
  mediaStyle,
  onLoadRequested,
  thumbnailUrl,
}: VideoLoadProxyProps) {
  return (
    <button
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
        <img
          className="media-content video-lod-thumbnail video-load-thumbnail"
          src={thumbnailUrl}
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

export function VideoThumbnail({
  mediaStyle,
  thumbnailUrl,
}: VideoThumbnailProps) {
  return (
    <img
      className="media-content video-lod-thumbnail"
      src={thumbnailUrl}
      alt="video thumbnail"
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      style={mediaStyle}
    />
  );
}

export function VideoProxy() {
  return (
    <div className="video-lod-proxy" aria-label="video proxy">
      <span className="video-lod-icon" aria-hidden="true" />
    </div>
  );
}
