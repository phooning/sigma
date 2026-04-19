import type { CSSProperties } from "react";

export type VideoLodMediaStyle = CSSProperties;

export type VideoLoadProxyProps = {
  mediaStyle: VideoLodMediaStyle;
  onLoadRequested: () => void;
  thumbnailUrl?: string;
};

export type VideoThumbnailProps = {
  mediaStyle: VideoLodMediaStyle;
  thumbnailUrl: string;
};
