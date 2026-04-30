import type { MediaQueueOptions } from "../utils/media";
import type { MediaItem } from "../utils/media.types";
import type { ViewBounds } from "../utils/viewport.types";

export type MediaPointerHandler = (
  id: string,
  event: React.PointerEvent,
) => void;

export type MediaActionHandler = (id: string, event: React.MouseEvent) => void;

export type CanvasMediaItemProps = {
  deleteItem: MediaActionHandler;
  handleItemPointerDown: MediaPointerHandler;
  handleItemPointerMove: MediaPointerHandler;
  handleItemPointerUp: MediaPointerHandler;
  item: MediaItem;
  isActiveAudioItem: boolean;
  isCropping: boolean;
  isCropEditing: boolean;
  isDragging: boolean;
  useNativeImageSurface: boolean;
  nativeImageReadyPath?: string;
  isResizing: boolean;
  isSelected: boolean;
  requestImagePreview: (
    item: MediaItem,
    maxDimension: 256 | 1024,
    options?: MediaQueueOptions,
  ) => void;
  requestThumbnail: (item: MediaItem, options?: MediaQueueOptions) => void;
  resetSize: MediaActionHandler;
  revealItem: MediaActionHandler;
  screenshotItem: MediaActionHandler;
  startCropEdit: MediaActionHandler;
  toggleAudioPlayback: MediaActionHandler;
  viewBounds: Pick<
    ViewBounds,
    "viewLeft" | "viewTop" | "viewRight" | "viewBottom"
  >;
  zoom: number;
};
