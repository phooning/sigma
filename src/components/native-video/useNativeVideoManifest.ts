import { useMemo } from "react";
import type { MediaItem, Viewport } from "../../utils/media.types";
import type { NativeVideoGeometryBounds, NativeVideoManifest } from "./types";

const TARGET_PRESENTATION_FPS = 60;

type UseNativeVideoManifestOptions = {
  items: MediaItem[];
  viewport: Viewport;
  canvasSize: {
    width: number;
    height: number;
  };
  selectedItems: Set<string>;
  activeAudioItemId: string | null;
};

type CanvasSize = {
  width: number;
  height: number;
};

export function computeNativeVideoBounds(
  item: MediaItem,
  viewport: Viewport,
  canvasSize: CanvasSize,
): NativeVideoGeometryBounds | null {
  if (item.type !== "video") return null;

  const canvasWidth = Math.max(1, Math.round(canvasSize.width));
  const canvasHeight = Math.max(1, Math.round(canvasSize.height));
  const screenX = (item.x + viewport.x) * viewport.zoom;
  const screenY = (item.y + viewport.y) * viewport.zoom;
  const renderedWidthPx = item.width * viewport.zoom;
  const renderedHeightPx = item.height * viewport.zoom;
  const visibleLeft = Math.max(0, screenX);
  const visibleTop = Math.max(0, screenY);
  const visibleRight = Math.min(canvasWidth, screenX + renderedWidthPx);
  const visibleBottom = Math.min(canvasHeight, screenY + renderedHeightPx);
  const visibleWidth = Math.max(0, visibleRight - visibleLeft);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  const visibleAreaPx = visibleWidth * visibleHeight;

  if (visibleAreaPx <= 0) return null;

  return {
    screenX,
    screenY,
    renderedWidthPx,
    renderedHeightPx,
    visibleAreaPx,
  };
}

export function useNativeVideoManifest({
  items,
  viewport,
  canvasSize,
  selectedItems,
  activeAudioItemId,
}: UseNativeVideoManifestOptions): NativeVideoManifest {
  return useMemo(() => {
    const canvasWidth = Math.max(1, Math.round(canvasSize.width));
    const canvasHeight = Math.max(1, Math.round(canvasSize.height));
    const canvasCenterX = canvasWidth / 2;
    const canvasCenterY = canvasHeight / 2;
    const canvasDiagonal = Math.hypot(canvasWidth, canvasHeight) || 1;

    return {
      canvasWidth,
      canvasHeight,
      viewportZoom: viewport.zoom,
      assets: items.flatMap((item) => {
        const bounds = computeNativeVideoBounds(item, viewport, canvasSize);
        if (!bounds) return [];

        const itemCenterX = bounds.screenX + bounds.renderedWidthPx / 2;
        const itemCenterY = bounds.screenY + bounds.renderedHeightPx / 2;
        const centerDistance = Math.hypot(
          itemCenterX - canvasCenterX,
          itemCenterY - canvasCenterY,
        );
        const centerWeight = 1 - Math.min(1, centerDistance / canvasDiagonal);
        const focusWeight = selectedItems.has(item.id)
          ? 2.5
          : activeAudioItemId === item.id
            ? 2
            : 1;

        return [
          {
            id: item.id,
            path: item.filePath,
            sourceWidth: Math.max(
              1,
              Math.round(item.sourceWidth ?? item.width),
            ),
            sourceHeight: Math.max(
              1,
              Math.round(item.sourceHeight ?? item.height),
            ),
            ...bounds,
            focusWeight,
            centerWeight,
            targetFps: TARGET_PRESENTATION_FPS,
          },
        ];
      }),
    };
  }, [activeAudioItemId, canvasSize, items, selectedItems, viewport]);
}
