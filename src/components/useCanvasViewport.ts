import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { CanvasBackgroundPattern } from "@/stores/useSettingsStore";
import type { Viewport } from "@/utils/media.types";
import { markPerformance } from "@/utils/performance";
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
  const persistedViewport = useCanvasSessionStore((state) => state.viewport);
  const setViewport = useCanvasSessionStore((state) => state.setViewport);
  const [viewport, setRenderViewport] = useState(persistedViewport);
  const hotViewportRef = useRef(persistedViewport);
  const lastStoredViewportRef = useRef(persistedViewport);
  const pendingViewportRef = useRef<Viewport | null>(null);
  const viewportFrameRef = useRef<number | null>(null);
  const viewportPersistenceTimeoutRef = useRef<number | null>(null);
  const didApplyInitialViewportRef = useRef(false);
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

  const clearViewportPersistenceTimeout = useCallback(() => {
    if (viewportPersistenceTimeoutRef.current === null) return;

    window.clearTimeout(viewportPersistenceTimeoutRef.current);
    viewportPersistenceTimeoutRef.current = null;
  }, []);

  const flushViewportToStore = useCallback(
    (nextViewport: Viewport = hotViewportRef.current) => {
      clearViewportPersistenceTimeout();
      lastStoredViewportRef.current = nextViewport;
      setViewport(nextViewport);
    },
    [clearViewportPersistenceTimeout, setViewport],
  );

  const scheduleViewportPersistence = useCallback(() => {
    clearViewportPersistenceTimeout();

    viewportPersistenceTimeoutRef.current = window.setTimeout(() => {
      viewportPersistenceTimeoutRef.current = null;
      flushViewportToStore();
    }, 180);
  }, [clearViewportPersistenceTimeout, flushViewportToStore]);

  const getViewport = useCallback(() => hotViewportRef.current, []);

  const commitViewport = useCallback(
    (
      nextViewport: Viewport,
      options: { flushDomNow?: boolean; syncReact?: boolean } = {},
    ) => {
      markPerformance("sigma:commitViewport:start");
      pendingViewportRef.current = nextViewport;
      hotViewportRef.current = nextViewport;

      try {
        if (options.flushDomNow) {
          if (viewportFrameRef.current !== null) {
            window.cancelAnimationFrame(viewportFrameRef.current);
            viewportFrameRef.current = null;
          }

          applyViewportToDom(nextViewport);
          setRenderViewport(nextViewport);

          if (options.syncReact) {
            flushViewportToStore(nextViewport);
          } else {
            scheduleViewportPersistence();
          }

          return;
        }

        if (options.syncReact) {
          flushViewportToStore(nextViewport);
        } else {
          scheduleViewportPersistence();
        }

        if (viewportFrameRef.current !== null) {
          return;
        }

        viewportFrameRef.current = window.requestAnimationFrame(() => {
          viewportFrameRef.current = null;

          const pendingViewport = pendingViewportRef.current;
          if (!pendingViewport) return;

          applyViewportToDom(pendingViewport);
          setRenderViewport(pendingViewport);
        });
      } finally {
        markPerformance("sigma:commitViewport:end");
      }
    },
    [applyViewportToDom, flushViewportToStore, scheduleViewportPersistence],
  );

  const { cancelViewportAnimation, panViewportTo } = useViewportAnimation({
    commitViewport,
    getViewport,
  });

  useBackgroundCanvas(
    backgroundCanvasRef,
    canvasSize,
    canvasBackgroundPattern,
    getViewport,
  );

  useLayoutEffect(() => {
    const isLocalStoreFlush = persistedViewport === lastStoredViewportRef.current;

    if (didApplyInitialViewportRef.current && isLocalStoreFlush) return;

    didApplyInitialViewportRef.current = true;
    hotViewportRef.current = persistedViewport;
    pendingViewportRef.current = persistedViewport;
    setRenderViewport(persistedViewport);
    applyViewportToDom(persistedViewport);
  }, [applyViewportToDom, persistedViewport]);

  useEffect(
    () => () => {
      if (viewportFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportFrameRef.current);
      }

      if (viewportPersistenceTimeoutRef.current !== null) {
        window.clearTimeout(viewportPersistenceTimeoutRef.current);
        flushViewportToStore();
      }
    },
    [flushViewportToStore],
  );

  return {
    viewport,
    getViewport,
    commitViewport,
    cancelViewportAnimation,
    panViewportTo,
  };
};
