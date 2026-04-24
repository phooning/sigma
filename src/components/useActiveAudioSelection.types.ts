import type {
  Dispatch,
  SetStateAction,
} from "react";
import type { MediaItem, Viewport } from "../utils/media.types";
import type { ViewportPanPosition } from "./useViewportAnimation.types";

export type UseActiveAudioSelectionParams = {
  activeAudioItemId: string | null;
  containerRef: React.RefObject<HTMLDivElement | null>;
  getItems: () => MediaItem[];
  getViewport: () => Viewport;
  panViewportTo: (target: ViewportPanPosition) => void;
  setEditingCropItem: (value: SetStateAction<string | null>) => void;
  setSelectedItems: Dispatch<SetStateAction<Set<string>>>;
};
