import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import type { CanvasBackgroundPattern } from "@/stores/useSettingsStore";
import type { Viewport } from "@/utils/media.types";
import { useCanvasSessionStore } from "@/stores/useCanvasSessionStore";
import { drawCanvasBackground } from "./CanvasBackground";
import { useBackgroundCanvas } from "./useBackgroundCanvas";
import { useViewportAnimation } from "./useViewportAnimation";

type UseCanvasViewportParams = {
  backgroundCanvasRef: RefObject<HTMLCanvasElement | null>;
  worldRef: RefObject<HTMLDivElement | null>;
  canvasSize: { width: number; height: number };
  canvasBackgroundPattern: CanvasBackgroundPattern;
};

export const useCanvasViewport = ({
  backgroundCanvasRef,
  worldRef,
  canvasSize,
  canvasBackgroundPattern,
}: UseCanvasViewportParams) => {
  const viewport = useCanvasSessionStore((state) => state.viewport);
  const setViewport = useCanvasSessionStore((state) => state.setViewport);
  const pendingViewportRef = useRef<Viewport | null>(null);
  const viewportFrameRef = useRef<number | null>(null);
  const canvasSizeRef = useRef(canvasSize);
  const canvasBackgroundPatternRef = useRef(canvasBackgroundPattern);

  canvasSizeRef.current = canvasSize;
  canvasBackgroundPatternRef.current = canvasBackgroundPattern;

  const redrawBackgroundCanvas = useCallback((nextViewport: Viewport) => {
    const canvas = backgroundCanvasRef.current;
    if (!canvas) return;

    drawCanvasBackground(canvas, {
      canvasSize: canvasSizeRef.current,
      pattern: canvasBackgroundPatternRef.current,
      viewport: nextViewport,
    });
  }, [backgroundCanvasRef]);

  const applyViewportToDom = useCallback(
    (nextViewport: Viewport) => {
      if (worldRef.current) {
        worldRef.current.style.transform = `scale(${nextViewport.zoom}) translate(${nextViewport.x}px, ${nextViewport.y}px)`;
      }

      redrawBackgroundCanvas(nextViewport);
    },
    [redrawBackgroundCanvas, worldRef],
  );

  const commitViewport = useCallback(
    (
      nextViewport: Viewport,
      options: { flushDomNow?: boolean; syncReact?: boolean } = {},
    ) => {
      setViewport(nextViewport);
      pendingViewportRef.current = nextViewport;

      if (options.flushDomNow) {
        if (viewportFrameRef.current !== null) {
          window.cancelAnimationFrame(viewportFrameRef.current);
          viewportFrameRef.current = null;
        }

        applyViewportToDom(nextViewport);
        return;
      }

      if (viewportFrameRef.current !== null) {
        return;
      }

      viewportFrameRef.current = window.requestAnimationFrame(() => {
        viewportFrameRef.current = null;

        const pendingViewport = pendingViewportRef.current;
        if (!pendingViewport) return;

        applyViewportToDom(pendingViewport);
      });
    },
    [applyViewportToDom, setViewport],
  );

  const { cancelViewportAnimation, panViewportTo } = useViewportAnimation({
    commitViewport,
    getViewport: () => useCanvasSessionStore.getState().viewport,
  });

  useBackgroundCanvas(
    backgroundCanvasRef,
    canvasSize,
    canvasBackgroundPattern,
    viewport,
  );

  useLayoutEffect(() => {
    applyViewportToDom(viewport);
  }, [applyViewportToDom, viewport]);

  useEffect(
    () => () => {
      if (viewportFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportFrameRef.current);
      }
    },
    [],
  );

  return {
    viewport,
    commitViewport,
    cancelViewportAnimation,
    panViewportTo,
  };
};
