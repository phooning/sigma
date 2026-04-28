import type { MediaItem, Viewport } from "./media.types";

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ScreenRect = Rect & {
  visibleAreaPx: number;
};

export type SpatialIndexCell = `${number},${number}`;

export type SpatialGridIndex<T extends { id: string }> = {
  cellSize: number;
  cells: Map<SpatialIndexCell, T[]>;
};

export const intersectsRect = (left: Rect, right: Rect) =>
  left.x < right.x + right.width &&
  left.x + left.width > right.x &&
  left.y < right.y + right.height &&
  left.y + left.height > right.y;

export const getItemRect = (
  item: Pick<MediaItem, "x" | "y" | "width" | "height">,
): Rect => ({
  x: item.x,
  y: item.y,
  width: item.width,
  height: item.height,
});

export const getIntersectingItemIds = (
  items: Pick<MediaItem, "id" | "x" | "y" | "width" | "height">[],
  selectionRect: Rect,
) =>
  items
    .filter((item) => intersectsRect(getItemRect(item), selectionRect))
    .map((item) => item.id);

export const projectItemToScreen = (
  item: Pick<MediaItem, "x" | "y" | "width" | "height">,
  viewport: Viewport,
  canvasSize: { width: number; height: number },
): ScreenRect => {
  const canvasWidth = Math.max(1, Math.round(canvasSize.width));
  const canvasHeight = Math.max(1, Math.round(canvasSize.height));
  const x = (item.x + viewport.x) * viewport.zoom;
  const y = (item.y + viewport.y) * viewport.zoom;
  const width = item.width * viewport.zoom;
  const height = item.height * viewport.zoom;
  const visibleLeft = Math.max(0, x);
  const visibleTop = Math.max(0, y);
  const visibleRight = Math.min(canvasWidth, x + width);
  const visibleBottom = Math.min(canvasHeight, y + height);
  const visibleWidth = Math.max(0, visibleRight - visibleLeft);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);

  return {
    x,
    y,
    width,
    height,
    visibleAreaPx: visibleWidth * visibleHeight,
  };
};

export const getCenterWeight = (
  screenRect: Pick<ScreenRect, "x" | "y" | "width" | "height">,
  canvasSize: { width: number; height: number },
) => {
  const canvasWidth = Math.max(1, Math.round(canvasSize.width));
  const canvasHeight = Math.max(1, Math.round(canvasSize.height));
  const canvasCenterX = canvasWidth / 2;
  const canvasCenterY = canvasHeight / 2;
  const canvasDiagonal = Math.hypot(canvasWidth, canvasHeight) || 1;
  const itemCenterX = screenRect.x + screenRect.width / 2;
  const itemCenterY = screenRect.y + screenRect.height / 2;
  const centerDistance = Math.hypot(
    itemCenterX - canvasCenterX,
    itemCenterY - canvasCenterY,
  );

  return 1 - Math.min(1, centerDistance / canvasDiagonal);
};

const toCellIndex = (value: number, cellSize: number) =>
  Math.floor(value / cellSize);

export const getRectCells = (
  rect: Rect,
  cellSize: number,
): SpatialIndexCell[] => {
  const startX = toCellIndex(rect.x, cellSize);
  const endX = toCellIndex(rect.x + rect.width, cellSize);
  const startY = toCellIndex(rect.y, cellSize);
  const endY = toCellIndex(rect.y + rect.height, cellSize);
  const cells: SpatialIndexCell[] = [];

  for (let cellY = startY; cellY <= endY; cellY += 1) {
    for (let cellX = startX; cellX <= endX; cellX += 1) {
      cells.push(`${cellX},${cellY}`);
    }
  }

  return cells;
};

export const createSpatialGridIndex = <
  T extends { id: string; x: number; y: number; width: number; height: number },
>(
  items: T[],
  cellSize: number,
): SpatialGridIndex<T> => {
  const cells = new Map<SpatialIndexCell, T[]>();

  items.forEach((item) => {
    getRectCells(getItemRect(item), cellSize).forEach((cell) => {
      const bucket = cells.get(cell);

      if (bucket) {
        bucket.push(item);
        return;
      }

      cells.set(cell, [item]);
    });
  });

  return { cellSize, cells };
};

export const querySpatialGridIndex = <
  T extends { id: string; x: number; y: number; width: number; height: number },
>(
  index: SpatialGridIndex<T>,
  rect: Rect,
): T[] => {
  const matches = new Map<string, T>();

  getRectCells(rect, index.cellSize).forEach((cell) => {
    index.cells.get(cell)?.forEach((item) => {
      if (!matches.has(item.id) && intersectsRect(getItemRect(item), rect)) {
        matches.set(item.id, item);
      }
    });
  });

  return [...matches.values()];
};
