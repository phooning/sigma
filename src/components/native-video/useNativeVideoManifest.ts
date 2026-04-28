import { useMemo } from "react";
import type { MediaItem, Viewport } from "../../utils/media.types";
import { getCenterWeight, projectItemToScreen } from "../../utils/spatial";
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

    return {
      canvasWidth,
      canvasHeight,
      viewportZoom: viewport.zoom,
      assets: items.flatMap((item) => {
        const bounds = computeNativeVideoBounds(item, viewport, canvasSize);
        if (!bounds) return [];

        const screenRect = projectItemToScreen(item, viewport, {
          width: canvasWidth,
          height: canvasHeight,
        });
        const visibleAreaPx = screenRect.visibleAreaPx;

        if (visibleAreaPx <= 0) return [];

        const centerWeight = getCenterWeight(screenRect, {
          width: canvasWidth,
          height: canvasHeight,
        });
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
            screenX: screenRect.x,
            screenY: screenRect.y,
            renderedWidthPx: screenRect.width,
            renderedHeightPx: screenRect.height,
            visibleAreaPx,
            focusWeight,
            centerWeight,
            targetFps: TARGET_PRESENTATION_FPS,
          },
        ];
      }),
    };
  }, [activeAudioItemId, canvasSize, items, selectedItems, viewport]);
}
