import { useCallback, useEffect, useRef } from "react";
import { animateKineticPan } from "../utils/animations";
import type {
  UseViewportAnimationParams,
  UseViewportAnimationResult,
  ViewportPanPosition,
} from "./useViewportAnimation.types";

export const useViewportAnimation = ({
  commitViewport,
  getViewport,
}: UseViewportAnimationParams): UseViewportAnimationResult => {
  const viewportAnimationRef = useRef<(() => void) | null>(null);

  const cancelViewportAnimation = useCallback(() => {
    if (viewportAnimationRef.current === null) return;

    viewportAnimationRef.current();
    viewportAnimationRef.current = null;
  }, []);

  const applyViewportPanPosition = useCallback(
    (position: ViewportPanPosition) => {
      const nextViewport = {
        ...getViewport(),
        x: position.x,
        y: position.y,
      };
      commitViewport(nextViewport, { flushDomNow: true });
    },
    [commitViewport, getViewport],
  );

  const panViewportTo = useCallback(
    (target: ViewportPanPosition) => {
      cancelViewportAnimation();

      let didComplete = false;
      let cancelPanAnimation: (() => void) | null = null;
      const currentViewport = getViewport();

      cancelPanAnimation = animateKineticPan({
        start: currentViewport,
        target,
        onUpdate: applyViewportPanPosition,
        onComplete: () => {
          didComplete = true;
          commitViewport(getViewport(), {
            flushDomNow: true,
            syncReact: true,
          });

          if (viewportAnimationRef.current === cancelPanAnimation) {
            viewportAnimationRef.current = null;
          }
        },
      });
      viewportAnimationRef.current = didComplete ? null : cancelPanAnimation;
    },
    [
      applyViewportPanPosition,
      cancelViewportAnimation,
      commitViewport,
      getViewport,
    ],
  );

  useEffect(() => cancelViewportAnimation, [cancelViewportAnimation]);

  return {
    cancelViewportAnimation,
    panViewportTo,
  };
};
