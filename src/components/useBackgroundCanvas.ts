import { type RefObject, useLayoutEffect } from "react";
import type { CanvasBackgroundPattern } from "@/stores/useSettingsStore";
import type { Viewport } from "@/utils/media.types";
import { drawCanvasBackground } from "./CanvasBackground";

export const useBackgroundCanvas = (
  backgroundCanvasRef: RefObject<HTMLCanvasElement | null>,
  canvasSize: { width: number; height: number },
  canvasBackgroundPattern: CanvasBackgroundPattern,
  viewport: Viewport,
) => {
  // Viewport motion redraws from input and animation handlers. This hook covers
  // mount, resize, and background-pattern changes without a second paint after
  // every React viewport commit.
  useLayoutEffect(() => {
    const canvas = backgroundCanvasRef.current;
    if (!canvas) return;

    drawCanvasBackground(canvas, {
      canvasSize,
      pattern: canvasBackgroundPattern,
      viewport,
    });
  }, [backgroundCanvasRef, canvasBackgroundPattern, canvasSize]);
};
