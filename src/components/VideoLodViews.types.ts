import type { CSSProperties } from "react";

export type VideoCropBoxStyle = CSSProperties;

export type VideoLoadProxyProps = {
  cropBoxStyle: VideoCropBoxStyle;
  onLoadRequested: () => void;
  thumbnailUrl?: string;
};

export type VideoThumbnailProps = {
  cropBoxStyle: VideoCropBoxStyle;
  thumbnailUrl: string;
  onReadyChange?: (isReady: boolean) => void;
};
