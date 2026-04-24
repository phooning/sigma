import { useCallback } from "react";
import { getViewBounds } from "../utils/viewport";
import type { UseActiveAudioSelectionParams } from "./useActiveAudioSelection.types";

const VIEW_FIT_GAP = 50;
const HUD_HEIGHT_FALLBACK = 48;

export const useActiveAudioSelection = ({
  activeAudioItemId,
  containerRef,
  getItems,
  getViewport,
  panViewportTo,
  setEditingCropItem,
  setSelectedItems,
}: UseActiveAudioSelectionParams) =>
  useCallback(() => {
    if (!activeAudioItemId) return;

    const items = getItems();
    const viewport = getViewport();
    const item = items.find((i) => i.id === activeAudioItemId);
    if (!item) return;

    const zoom = viewport.zoom;
    const hudHeight = containerRef.current
      ?.querySelector(".ui-overlay")
      ?.getBoundingClientRect().height;
    const headerHeight = (hudHeight || HUD_HEIGHT_FALLBACK) / zoom;
    const {
      screenWidth,
      screenHeight,
      viewLeft,
      viewTop,
      viewRight,
      viewBottom,
    } = getViewBounds(viewport, window.innerWidth, window.innerHeight);
    const usableViewTop = viewTop + headerHeight;
    const itemLeft = item.x;
    const itemTop = item.y;
    const itemRight = item.x + item.width;
    const itemBottom = item.y + item.height;
    let nextViewLeft = viewLeft;
    let nextViewTop = viewTop;

    if (item.width + VIEW_FIT_GAP * 2 <= screenWidth) {
      if (itemLeft < viewLeft + VIEW_FIT_GAP) {
        nextViewLeft = itemLeft - VIEW_FIT_GAP;
      } else if (itemRight > viewRight - VIEW_FIT_GAP) {
        nextViewLeft = itemRight + VIEW_FIT_GAP - screenWidth;
      }
    } else if (itemLeft < viewLeft || itemRight > viewRight) {
      nextViewLeft = itemLeft - VIEW_FIT_GAP;
    }

    if (item.height + VIEW_FIT_GAP * 2 + headerHeight <= screenHeight) {
      if (itemTop < usableViewTop + VIEW_FIT_GAP) {
        nextViewTop = itemTop - VIEW_FIT_GAP - headerHeight;
      } else if (itemBottom > viewBottom - VIEW_FIT_GAP) {
        nextViewTop = itemBottom + VIEW_FIT_GAP - screenHeight;
      }
    } else if (itemTop < usableViewTop || itemBottom > viewBottom) {
      nextViewTop = itemTop - VIEW_FIT_GAP - headerHeight;
    }

    panViewportTo({
      x: -nextViewLeft,
      y: -nextViewTop,
    });
    setSelectedItems(new Set([item.id]));
    setEditingCropItem(null);
  }, [
    activeAudioItemId,
    containerRef,
    getItems,
    getViewport,
    panViewportTo,
    setEditingCropItem,
    setSelectedItems,
  ]);
