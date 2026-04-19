import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { MediaItem, Viewport } from "../utils/media.types";
import type { ViewportPanPosition } from "./useViewportAnimation.types";

export type UseActiveAudioSelectionParams = {
  activeAudioItemId: string | null;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  itemsRef: MutableRefObject<MediaItem[]>;
  panViewportTo: (target: ViewportPanPosition) => void;
  setEditingCropItem: Dispatch<SetStateAction<string | null>>;
  setSelectedItems: Dispatch<SetStateAction<Set<string>>>;
  viewportRef: MutableRefObject<Viewport>;
};
