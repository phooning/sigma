import type {
  MutableRefObject,
} from "react";
import type { Viewport } from "../utils/media.types";

export type ViewportPanPosition = Pick<Viewport, "x" | "y">;

export type UseViewportAnimationParams = {
  viewportRef: MutableRefObject<Viewport>;
  commitViewport: (
    viewport: Viewport,
    options?: {
      flushDomNow?: boolean;
      syncReact?: boolean;
    },
  ) => void;
};

export type UseViewportAnimationResult = {
  cancelViewportAnimation: () => void;
  panViewportTo: (target: ViewportPanPosition) => void;
};
