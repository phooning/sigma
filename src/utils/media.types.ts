export interface CropInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export type MediaItemType = "image" | "video";

export interface MediaItem {
  id: string;
  type: MediaItemType;
  filePath: string;
  url: string;
  fileSize?: number;
  duration?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  deferVideoLoad?: boolean;
  thumbnailPath?: string;
  thumbnailUrl?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  crop?: CropInsets;
}

export type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export type VideoLodAssets = Pick<MediaItem, "thumbnailPath" | "thumbnailUrl">;

export type SetItems = React.Dispatch<React.SetStateAction<MediaItem[]>>;
