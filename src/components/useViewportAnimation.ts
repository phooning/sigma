import { useCallback, useEffect, useRef } from "react";
import { animateKineticPan } from "../utils/animations";
import type {
  UseViewportAnimationParams,
  UseViewportAnimationResult,
  ViewportPanPosition,
} from "./useViewportAnimation.types";

export const useViewportAnimation = ({
  viewportRef,
  setViewport,
}: UseViewportAnimationParams): UseViewportAnimationResult => {
  const viewportAnimationRef = useRef<(() => void) | null>(null);

  const cancelViewportAnimation = useCallback(() => {
    if (viewportAnimationRef.current === null) return;

    viewportAnimationRef.current();
    viewportAnimationRef.current = null;
  }, []);

  const applyViewportPanPosition = useCallback(
    (position: ViewportPanPosition) => {
      viewportRef.current = {
        ...viewportRef.current,
        x: position.x,
        y: position.y,
      };
      setViewport((prev) => ({ ...prev, x: position.x, y: position.y }));
    },
    [setViewport, viewportRef],
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

          if (viewportAnimationRef.current === cancelPanAnimation) {
            viewportAnimationRef.current = null;
          }
        },
      });
      viewportAnimationRef.current = didComplete ? null : cancelPanAnimation;
    },
    [applyViewportPanPosition, cancelViewportAnimation, viewportRef],
  );

  useEffect(() => cancelViewportAnimation, [cancelViewportAnimation]);

  return {
    cancelViewportAnimation,
    panViewportTo,
  };
};
