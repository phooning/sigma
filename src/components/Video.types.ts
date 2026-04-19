import type { CropInsets, MediaItem } from "../utils/media.types";

export interface VideoMediaProps {
  url: string;
  crop: CropInsets;
  item: MediaItem;
  isInViewport: boolean;
  zoom: number;
  onThumbnailNeeded?: (item: MediaItem) => void;
}
