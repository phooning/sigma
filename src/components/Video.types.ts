import type { CropInsets, MediaItem } from "../utils/media.types";
import type { VideoTimelineProps } from "./VideoTimeline.types";

export type VideoTimelineController = VideoTimelineProps;

export interface VideoMediaProps {
  url: string;
  crop: CropInsets;
  item: MediaItem;
  isInViewport: boolean;
  zoom: number;
  onTimelineControllerChange?: (
    itemId: string,
    controller: VideoTimelineController | null,
  ) => void;
  onReadyChange?: (isReady: boolean) => void;
  onThumbnailNeeded?: (item: MediaItem) => void;
  showTimelineInline?: boolean;
}
