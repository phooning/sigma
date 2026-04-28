import type { Viewport } from "./media.types";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 5;
const ZOOM_SENSITIVITY = 0.001;

export const clampZoom = (zoom: number) =>
  Math.max(MIN_ZOOM, Math.min(zoom, MAX_ZOOM));

export const getNextZoom = (zoom: number, deltaY: number) =>
  clampZoom(zoom * (1 - deltaY * ZOOM_SENSITIVITY));

export const applyPanDelta = (
  viewport: Viewport,
  deltaX: number,
  deltaY: number,
): Viewport => ({
  x: viewport.x - deltaX / viewport.zoom,
  y: viewport.y - deltaY / viewport.zoom,
  zoom: viewport.zoom,
});

export const applyZoomAtPoint = ({
  viewport,
  deltaY,
  mouseX,
  mouseY,
}: {
  viewport: Viewport;
  deltaY: number;
  mouseX: number;
  mouseY: number;
}): Viewport => {
  const zoom = getNextZoom(viewport.zoom, deltaY);
  const worldX = mouseX / viewport.zoom - viewport.x;
  const worldY = mouseY / viewport.zoom - viewport.y;

  return {
    x: mouseX / zoom - worldX,
    y: mouseY / zoom - worldY,
    zoom,
  };
};
