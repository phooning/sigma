import type { MediaItem, Viewport } from "./media.types";
import type { ViewBounds } from "./viewport.types";

export const getViewBounds = (
  viewport: Viewport,
  width: number,
  height: number
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
    screenHeight
  };
};

export const pushItemToTop = (currentItems: MediaItem[], id: string) => {
  const itemIndex = currentItems.findIndex((item) => item.id === id);
  if (itemIndex === -1 || itemIndex === currentItems.length - 1) {
    return currentItems;
  }

  const nextItems = [...currentItems];
  const [item] = nextItems.splice(itemIndex, 1);
  nextItems.push(item);
  return nextItems;
};
