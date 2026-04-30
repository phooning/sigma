import type { MediaItem, Viewport } from "./media.types";
import { getViewBounds } from "./viewport";

export type MinimapRect = {
  height: number;
  id: string;
  type: MediaItem["type"];
  width: number;
  x: number;
  y: number;
};

export type MinimapLayout = {
  assetRects: MinimapRect[];
  frame: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  viewportRect: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
};

type Bounds = {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
};

type Rect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type ComputeMinimapLayoutArgs = {
  canvasSize: {
    height: number;
    width: number;
  };
  items: MediaItem[];
  minimapHeight: number;
  minimapWidth: number;
  padding: number;
  viewport: Viewport;
};

const MIN_WORLD_SPAN = 1;
const MIN_VISIBLE_ASSET_SIZE = 1.5;
const MIN_VISIBLE_VIEWPORT_SIZE = 6;

const clampRectToFrame = (rect: Rect, frame: Rect): Rect => {
  const width = Math.min(rect.width, frame.width);
  const height = Math.min(rect.height, frame.height);
  const maxX = frame.x + frame.width - width;
  const maxY = frame.y + frame.height - height;

  return {
    x: Math.min(Math.max(rect.x, frame.x), maxX),
    y: Math.min(Math.max(rect.y, frame.y), maxY),
    width,
    height,
  };
};

const normalizeBounds = (
  items: MediaItem[],
  viewport: Viewport,
  width: number,
  height: number,
): Bounds => {
  const viewBounds = getViewBounds(viewport, width, height);

  let minX = viewBounds.viewLeft;
  let minY = viewBounds.viewTop;
  let maxX = viewBounds.viewRight;
  let maxY = viewBounds.viewBottom;

  for (const item of items) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.width);
    maxY = Math.max(maxY, item.y + item.height);
  }

  return { minX, minY, maxX, maxY };
};

export const computeMinimapLayout = ({
  items,
  viewport,
  canvasSize,
  minimapWidth,
  minimapHeight,
  padding,
}: ComputeMinimapLayoutArgs): MinimapLayout => {
  const bounds = normalizeBounds(
    items,
    viewport,
    canvasSize.width,
    canvasSize.height,
  );
  const worldWidth = Math.max(bounds.maxX - bounds.minX, MIN_WORLD_SPAN);
  const worldHeight = Math.max(bounds.maxY - bounds.minY, MIN_WORLD_SPAN);
  const scale = Math.min(
    (minimapWidth - padding * 2) / worldWidth,
    (minimapHeight - padding * 2) / worldHeight,
  );
  const frameWidth = worldWidth * scale;
  const frameHeight = worldHeight * scale;
  const frameX = (minimapWidth - frameWidth) / 2;
  const frameY = (minimapHeight - frameHeight) / 2;
  const projectX = (worldX: number) => frameX + (worldX - bounds.minX) * scale;
  const projectY = (worldY: number) => frameY + (worldY - bounds.minY) * scale;

  const assetRects = items.map((item) => ({
    id: item.id,
    x: projectX(item.x),
    y: projectY(item.y),
    width: Math.max(item.width * scale, MIN_VISIBLE_ASSET_SIZE),
    height: Math.max(item.height * scale, MIN_VISIBLE_ASSET_SIZE),
    type: item.type,
  }));

  const viewBounds = getViewBounds(
    viewport,
    canvasSize.width,
    canvasSize.height,
  );
  const frame = {
    x: frameX,
    y: frameY,
    width: frameWidth,
    height: frameHeight,
  };
  const viewportRect = clampRectToFrame(
    {
      x: projectX(viewBounds.viewLeft),
      y: projectY(viewBounds.viewTop),
      width: Math.max(
        viewBounds.screenWidth * scale,
        MIN_VISIBLE_VIEWPORT_SIZE,
      ),
      height: Math.max(
        viewBounds.screenHeight * scale,
        MIN_VISIBLE_VIEWPORT_SIZE,
      ),
    },
    frame,
  );

  return {
    assetRects,
    frame,
    viewportRect,
  };
};
