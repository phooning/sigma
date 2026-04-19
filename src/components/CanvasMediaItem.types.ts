import type { MediaItem, Viewport } from "../utils/media.types";
import type { ViewBounds } from "../utils/viewport.types";

export type MediaPointerHandler = (
  id: string,
  event: React.PointerEvent,
) => void;

export type MediaActionHandler = (
  id: string,
  event: React.MouseEvent,
) => void;

export type CanvasMediaItemProps = {
  activeAudioItemId: string | null;
  croppingItem: string | null;
  deleteItem: MediaActionHandler;
  draggingItem: string | null;
  editingCropItem: string | null;
  handleItemPointerDown: MediaPointerHandler;
  handleItemPointerMove: MediaPointerHandler;
  handleItemPointerUp: MediaPointerHandler;
  item: MediaItem;
  requestThumbnail: (item: MediaItem) => void;
  resetSize: MediaActionHandler;
  resizingItem: string | null;
  revealItem: MediaActionHandler;
  screenshotItem: MediaActionHandler;
  selectedItems: Set<string>;
  startCropEdit: MediaActionHandler;
  toggleAudioPlayback: MediaActionHandler;
  viewBounds: Pick<
    ViewBounds,
    "viewLeft" | "viewTop" | "viewRight" | "viewBottom"
  >;
  viewport: Viewport;
};
