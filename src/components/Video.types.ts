import type { CropInsets, MediaItem } from "../utils/media.types";

export interface VideoMediaProps {
  url: string;
  crop: CropInsets;
  item: MediaItem;
  isInViewport: boolean;
  zoom: number;
  onReadyChange?: (isReady: boolean) => void;
  onThumbnailNeeded?: (item: MediaItem) => void;
}
