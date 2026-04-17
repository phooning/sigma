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
  x: number;
  y: number;
  width: number;
  height: number;
  crop?: CropInsets;
}

export type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
