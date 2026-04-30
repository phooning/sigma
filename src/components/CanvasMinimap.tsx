import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { MediaItem, Viewport } from "../utils/media.types";
import { computeMinimapLayout } from "../utils/minimap";

type CanvasMinimapProps = {
  canvasSize: {
    height: number;
    width: number;
  };
  items: MediaItem[];
  selectedItems: Set<string>;
  viewport: Viewport;
};

const MINIMAP_WIDTH = 220;
const MINIMAP_HEIGHT = 160;
const MINIMAP_PADDING = 12;

export const CanvasMinimap = memo(function CanvasMinimap({
  items,
  viewport,
  canvasSize,
  selectedItems,
}: CanvasMinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const selectedCount = selectedItems.size;
  const zoomLabel = `${viewport.zoom.toFixed(1)}x`;

  const layout = useMemo(
    () =>
      computeMinimapLayout({
        items,
        viewport,
        canvasSize,
        minimapWidth: MINIMAP_WIDTH,
        minimapHeight: MINIMAP_HEIGHT,
        padding: MINIMAP_PADDING,
      }),
    [canvasSize, items, viewport],
  );

  useEffect(() => {
    let removeMediaQueryListener = () => {};

    const updateDpr = () => {
      const nextDpr = window.devicePixelRatio || 1;
      setDpr((currentDpr) => (currentDpr === nextDpr ? currentDpr : nextDpr));
    };

    const subscribeToDprChanges = () => {
      if (typeof window.matchMedia !== "function") {
        removeMediaQueryListener = () => {};
        return;
      }

      const mediaQuery = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      );
      const handleChange = () => {
        updateDpr();
        removeMediaQueryListener();
        subscribeToDprChanges();
      };

      if ("addEventListener" in mediaQuery) {
        mediaQuery.addEventListener("change", handleChange);
        removeMediaQueryListener = () =>
          mediaQuery.removeEventListener("change", handleChange);
        return;
      }

      mediaQuery.addListener(handleChange);
      removeMediaQueryListener = () => mediaQuery.removeListener(handleChange);
    };

    window.addEventListener("resize", updateDpr);
    subscribeToDprChanges();

    return () => {
      window.removeEventListener("resize", updateDpr);
      removeMediaQueryListener();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const scaledWidth = Math.round(MINIMAP_WIDTH * dpr);
    const scaledHeight = Math.round(MINIMAP_HEIGHT * dpr);

    if (canvas.width !== scaledWidth || canvas.height !== scaledHeight) {
      canvas.width = scaledWidth;
      canvas.height = scaledHeight;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    context.fillStyle = "rgba(255, 255, 255, 0.03)";
    context.fillRect(
      layout.frame.x,
      layout.frame.y,
      layout.frame.width,
      layout.frame.height,
    );

    layout.assetRects.forEach((rect) => {
      const isSelected = selectedItems.has(rect.id);
      context.fillStyle = isSelected
        ? "rgba(255, 245, 166, 0.88)"
        : rect.type === "video"
          ? "rgba(138, 180, 248, 0.5)"
          : "rgba(255, 255, 255, 0.32)";
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
    });

    context.strokeStyle = "rgba(255, 255, 255, 0.7)";
    context.lineWidth = 1.5;
    context.strokeRect(
      layout.viewportRect.x,
      layout.viewportRect.y,
      layout.viewportRect.width,
      layout.viewportRect.height,
    );

    context.fillStyle = "rgba(255, 255, 255, 0.08)";
    context.fillRect(
      layout.viewportRect.x,
      layout.viewportRect.y,
      layout.viewportRect.width,
      layout.viewportRect.height,
    );
  }, [dpr, layout, selectedItems]);

  return (
    <div className="canvas-minimap" aria-hidden="true" role="presentation">
      <canvas
        ref={canvasRef}
        className="canvas-minimap__canvas"
        style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
      />
      <div className="canvas-minimap__meta">
        <span className="canvas-minimap__label">{zoomLabel}</span>
        <span className="canvas-minimap__count">
          {selectedCount} of {items.length} selected
        </span>
      </div>
    </div>
  );
});
