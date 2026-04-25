import type { Viewport } from "../utils/media.types";

export type ViewportPanPosition = Pick<Viewport, "x" | "y">;
export type ViewportCommitOptions = {
  flushDomNow?: boolean;
  syncReact?: boolean;
};

export type UseViewportAnimationParams = {
  getViewport: () => Viewport;
  commitViewport: (
    viewport: Viewport,
    options?: ViewportCommitOptions,
  ) => void;
};

export type UseViewportAnimationResult = {
  cancelViewportAnimation: () => void;
  panViewportTo: (target: ViewportPanPosition) => void;
};
