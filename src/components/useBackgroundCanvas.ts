import { RefObject, useEffect } from "react";
import { Viewport } from "@/utils/media.types";
import {
  drawDotGrid,
  drawLineGrid,
  resizeBackgroundCanvas,
} from "./CanvasBackground";

export const useBackgroundCanvas = (
  backgroundCanvasRef: RefObject<HTMLCanvasElement | null>,
  canvasSize: { width: number; height: number },
  canvasBackgroundPattern: string,
  viewport: Viewport,
) => {
  useEffect(() => {
    if (backgroundCanvasRef) {
      const canvas = backgroundCanvasRef.current;
      if (!canvas) return;

      const { pixelRatio, width, height } = resizeBackgroundCanvas(
        canvas,
        canvasSize.width,
        canvasSize.height,
      );

      const context = canvas.getContext("2d", { alpha: true });
      if (!context) return;

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      if (canvasBackgroundPattern === "dots") {
        drawDotGrid(context, width, height, viewport);
      } else {
        drawLineGrid(context, width, height, viewport);
      }
    }
  }, [canvasBackgroundPattern, canvasSize, viewport]);
};
