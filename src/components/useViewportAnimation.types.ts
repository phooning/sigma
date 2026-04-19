import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from "react";
import type { Viewport } from "../utils/media.types";

export type ViewportPanPosition = Pick<Viewport, "x" | "y">;

export type UseViewportAnimationParams = {
  viewportRef: MutableRefObject<Viewport>;
  setViewport: Dispatch<SetStateAction<Viewport>>;
  onViewportChange?: (viewport: Viewport) => void;
};

export type UseViewportAnimationResult = {
  cancelViewportAnimation: () => void;
  panViewportTo: (target: ViewportPanPosition) => void;
};
