import type { Viewport } from "./media.types";
import type { ViewBounds } from "./viewport.types";

export const getViewBounds = (
  viewport: Viewport,
  width: number,
  height: number,
): ViewBounds => {
  const screenWidth = width / viewport.zoom;
  const screenHeight = height / viewport.zoom;
  const viewLeft = -viewport.x;
  const viewTop = -viewport.y;

  return {
    viewLeft,
    viewTop,
    viewRight: viewLeft + screenWidth,
    viewBottom: viewTop + screenHeight,
    screenWidth,
    screenHeight,
  };
};
