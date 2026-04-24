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
export type ImagePreviewDimension = 256 | 1024;

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
  imagePreview256Path?: string;
  imagePreview256Url?: string;
  imagePreview1024Path?: string;
  imagePreview1024Url?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  crop?: CropInsets;
}

export type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export type VideoLodAssets = Pick<MediaItem, "thumbnailPath" | "thumbnailUrl">;
export type ImageLodAssets = Pick<
  MediaItem,
  | "imagePreview256Path"
  | "imagePreview256Url"
  | "imagePreview1024Path"
  | "imagePreview1024Url"
>;

export type SetItems = React.Dispatch<React.SetStateAction<MediaItem[]>>;
