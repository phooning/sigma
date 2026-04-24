import { useCallback, useEffect, useRef } from "react";
import { animateKineticPan } from "../utils/animations";
import type {
  UseViewportAnimationParams,
  UseViewportAnimationResult,
  ViewportPanPosition,
} from "./useViewportAnimation.types";

export const useViewportAnimation = ({
  commitViewport,
  viewportRef,
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
        ...viewportRef.current,
        x: position.x,
        y: position.y,
      };
      commitViewport(nextViewport, { flushDomNow: true });
    },
    [commitViewport, viewportRef],
  );

  const panViewportTo = useCallback(
    (target: ViewportPanPosition) => {
      cancelViewportAnimation();

      let didComplete = false;
      let cancelPanAnimation: (() => void) | null = null;

      cancelPanAnimation = animateKineticPan({
        start: viewportRef.current,
        target,
        onUpdate: applyViewportPanPosition,
        onComplete: () => {
          didComplete = true;
          commitViewport(viewportRef.current, {
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
    [applyViewportPanPosition, cancelViewportAnimation, commitViewport, viewportRef],
  );

  useEffect(() => cancelViewportAnimation, [cancelViewportAnimation]);

  return {
    cancelViewportAnimation,
    panViewportTo,
  };
};
