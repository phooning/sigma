import {
  useCallback,
  useEffect,
  useState,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  WheelEvent as ReactWheelEvent,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { ISelectionBox, SelectionBox } from "./components/SelectionBox";
import { Hud } from "./components/Hud";
import { DevelopmentOverlay } from "./components/DevelopmentOverlay";
import {
  CropOverlay,
  MediaFrameActions,
  resetFrameSize,
} from "./components/MediaFrameActions";
import {
  exportMediaVideo,
  getCrop,
  saveMediaScreenshot,
  useThumbnailQueue,
} from "./utils/media";
import {
  CropHandle,
  CropInsets,
  MediaItem,
  Viewport,
} from "./utils/media.types";
import {
  handleImageCrop,
  handleImageResize,
  ImageActions,
  resetImageSize,
  TCropStart,
} from "./components/ImageActions";
import { loadFromStorage, revealItem } from "./utils/fs";
import {
  appVersion,
  saveConfig,
  SETTINGS_MENU_ITEMS,
} from "./components/HudActions";
import {
  getWheelInputType,
  handlePanAction,
  handleZoomAction,
} from "./components/CanvasActions";
import { useTauriDrop } from "./utils/drag";
import { useCanvasHotkeys } from "./utils/keyboard";
import { VideoMedia } from "./components/Video";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useAudioPlaybackStore } from "./stores/useAudioPlaybackStore";
import { useBackgroundCanvas } from "./components/useBackgroundCanvas";
import {
  getStoredVideoLoop,
  useVideoExportStore,
} from "./stores/useVideoExportStore";
import { getLoopRange } from "./utils/videoUtils";
import { animateKineticPan } from "./utils/animations";

const VIEW_FIT_GAP = 50;
const HUD_HEIGHT_FALLBACK = 48;
const CULL_MARGIN = 500;
const ACTION_SELECTORS =
  ".reset-btn, .delete-btn, .crop-btn, .reveal-btn, .screenshot-btn, .audio-btn";

const getMediaFileStem = (filePath: string) => {
  const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() || "video";
  const extensionIndex = fileName.lastIndexOf(".");

  return extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
};

const getExportDefaultPath = (filePath: string) => {
  const safeStem = getMediaFileStem(filePath)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim();

  return `${safeStem || "video"}.mp4`;
};

type ViewBounds = {
  viewLeft: number;
  viewTop: number;
  viewRight: number;
  viewBottom: number;
  screenWidth: number;
  screenHeight: number;
};

const getViewBounds = (
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

type UseActiveAudioSelectionParams = {
  activeAudioItemId: string | null;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  itemsRef: MutableRefObject<MediaItem[]>;
  panViewportTo: (target: Pick<Viewport, "x" | "y">) => void;
  setEditingCropItem: Dispatch<SetStateAction<string | null>>;
  setSelectedItems: Dispatch<SetStateAction<Set<string>>>;
  viewportRef: MutableRefObject<Viewport>;
};

const useActiveAudioSelection = ({
  activeAudioItemId,
  containerRef,
  itemsRef,
  panViewportTo,
  setEditingCropItem,
  setSelectedItems,
  viewportRef,
}: UseActiveAudioSelectionParams) =>
  useCallback(() => {
    if (!activeAudioItemId) return;

    const item = itemsRef.current.find((i) => i.id === activeAudioItemId);
    if (!item) return;

    const zoom = viewportRef.current.zoom;
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
    } = getViewBounds(
      viewportRef.current,
      window.innerWidth,
      window.innerHeight,
    );
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
    itemsRef,
    panViewportTo,
    setEditingCropItem,
    setSelectedItems,
    viewportRef,
  ]);

export default function InfiniteCanvas() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [draggingItem, setDraggingItem] = useState<string | null>(null);
  const [resizingItem, setResizingItem] = useState<string | null>(null);
  const [editingCropItem, setEditingCropItem] = useState<string | null>(null);
  const [croppingItem, setCroppingItem] = useState<string | null>(null);
  const [selectionBox, setSelectionBox] = useState<ISelectionBox | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [canvasSize, setCanvasSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const screenshotDirectory = useSettingsStore(
    (state) => state.screenshotDirectory,
  );
  const canvasBackgroundPattern = useSettingsStore(
    (state) => state.canvasBackgroundPattern,
  );
  const setScreenshotDirectory = useSettingsStore(
    (state) => state.setScreenshotDirectory,
  );
  const activeAudioItemId = useAudioPlaybackStore(
    (state) => state.activeItemId,
  );
  const toggleAudioItem = useAudioPlaybackStore((state) => state.toggleItem);
  const clearAudioItem = useAudioPlaybackStore((state) => state.clearItem);
  const exportingItemId = useVideoExportStore((state) => state.exportingItemId);
  const setExportingItemId = useVideoExportStore(
    (state) => state.setExportingItemId,
  );
  const clearVideoExportItemState = useVideoExportStore(
    (state) => state.clearItemState,
  );
  const clearAllVideoExportState = useVideoExportStore(
    (state) => state.clearAllItemState,
  );

  // Refs mirrored for async callbacks and global pointer gestures.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selectedItemsRef = useRef(selectedItems);
  selectedItemsRef.current = selectedItems;

  const containerRef = useRef<HTMLDivElement>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const startDragRef = useRef<{ x: number; y: number } | null>(null);
  const resizeStartRef = useRef<Map<
    string,
    { width: number; height: number; crop: CropInsets }
  > | null>(null);
  const cropHandleRef = useRef<CropHandle | null>(null);
  const cropStartRef = useRef<TCropStart>(null);
  const thumbnailQueueRef = useRef<MediaItem[]>([]);
  const thumbnailRequestedRef = useRef<Set<string>>(new Set());
  const viewportAnimationRef = useRef<(() => void) | null>(null);

  // Canvas integrations.
  const { requestThumbnail } = useThumbnailQueue(setItems);
  useBackgroundCanvas(
    backgroundCanvasRef,
    canvasSize,
    canvasBackgroundPattern,
    viewport,
  );

  // Effects that keep external state in sync with the canvas.
  useEffect(() => {
    if (
      activeAudioItemId &&
      !items.some(
        (item) => item.id === activeAudioItemId && item.type === "video",
      )
    ) {
      clearAudioItem(activeAudioItemId);
    }
  }, [activeAudioItemId, clearAudioItem, items]);

  const cancelViewportAnimation = useCallback(() => {
    if (viewportAnimationRef.current === null) return;

    viewportAnimationRef.current();
    viewportAnimationRef.current = null;
  }, []);

  const applyViewportPanPosition = useCallback(
    (position: Pick<Viewport, "x" | "y">) => {
      viewportRef.current = {
        ...viewportRef.current,
        x: position.x,
        y: position.y,
      };
      setViewport((prev) => ({ ...prev, x: position.x, y: position.y }));
    },
    [],
  );

  const panViewportTo = useCallback(
    (target: Pick<Viewport, "x" | "y">) => {
      cancelViewportAnimation();

      let didComplete = false;
      let cancelPanAnimation: (() => void) | null = null;

      cancelPanAnimation = animateKineticPan({
        start: viewportRef.current,
        target,
        onUpdate: applyViewportPanPosition,
        onComplete: () => {
          didComplete = true;

          if (viewportAnimationRef.current === cancelPanAnimation) {
            viewportAnimationRef.current = null;
          }
        },
      });
      viewportAnimationRef.current = didComplete ? null : cancelPanAnimation;
    },
    [applyViewportPanPosition, cancelViewportAnimation],
  );

  useEffect(() => cancelViewportAnimation, [cancelViewportAnimation]);

  useEffect(() => {
    const handleResize = () => {
      setCanvasSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const startPanning = (
    pointerId: number,
    clientX: number,
    clientY: number,
  ) => {
    cancelViewportAnimation();
    setIsPanning(true);
    startDragRef.current = { x: clientX, y: clientY };
    containerRef.current?.setPointerCapture(pointerId);
  };

  useTauriDrop({ viewportRef, setItems });
  useCanvasHotkeys({
    containerRef,
    itemsRef,
    onSave: () =>
      saveConfig({
        items: itemsRef.current,
        viewport: viewportRef.current,
      }),
    selectedItemsRef,
    setItems,
    setSelectedItems,
    setEditingCropItem,
  });

  const loadConfig = async () => {
    const result = await loadFromStorage();
    if (!result.ok) {
      if (result.reason !== "cancelled") {
        await message(`Failed to load config:\n\n${result.reason}`, {
          title: "Load failed",
          kind: "error",
        });
      }

      return;
    }
    const { data } = result;

    if (data.items) {
      // Re-generate URLs locally in case the app restarted or paths changed.
      const loadedItems = data.items.map((i) => ({
        ...i,
        url: convertFileSrc(i.filePath),
        thumbnailUrl: i.thumbnailPath
          ? convertFileSrc(i.thumbnailPath)
          : undefined,
      }));
      setItems(loadedItems);
    }
    if (data.viewport) {
      cancelViewportAnimation();
      setViewport(data.viewport);
    }
    setSelectedItems(new Set());
    clearAudioItem();
    clearAllVideoExportState();
  };

  const selectActiveAudioItem = useActiveAudioSelection({
    activeAudioItemId,
    containerRef,
    itemsRef,
    panViewportTo,
    setEditingCropItem,
    setSelectedItems,
    viewportRef,
  });

  // Canvas pointer handlers.
  const handlePointerDown = (e: React.PointerEvent) => {
    if (
      e.target === containerRef.current ||
      (e.target as HTMLElement).classList.contains("canvas-background")
    ) {
      cancelViewportAnimation();

      if (e.button === 0) {
        // Selection Box logic - correct offset by using getBoundingClientRect
        const rect = containerRef.current!.getBoundingClientRect();
        const clientX = e.clientX - rect.left;
        const clientY = e.clientY - rect.top;

        setSelectionBox({
          startX: clientX,
          startY: clientY,
          endX: clientX,
          endY: clientY,
        });
        setSelectedItems(new Set());
        setEditingCropItem(null);
        e.currentTarget.setPointerCapture(e.pointerId);
      } else if (e.button === 1 || e.button === 2) {
        startPanning(e.pointerId, e.clientX, e.clientY);
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const activeItemId = draggingItem || resizingItem || croppingItem;

    if (activeItemId) {
      handleItemPointerMove(activeItemId, e);
      return;
    }

    if (isPanning && startDragRef.current) {
      const dx = (e.clientX - startDragRef.current.x) / viewport.zoom;
      const dy = (e.clientY - startDragRef.current.y) / viewport.zoom;

      setViewport((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      startDragRef.current = { x: e.clientX, y: e.clientY };
    } else if (selectionBox && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;
      const toWorld = (cx: number, cy: number) => ({
        x: cx / viewport.zoom - viewport.x,
        y: cy / viewport.zoom - viewport.y,
      });

      setSelectionBox((prev) =>
        prev ? { ...prev, endX: clientX, endY: clientY } : null,
      );

      const startWorld = toWorld(selectionBox.startX, selectionBox.startY);
      const endWorld = toWorld(clientX, clientY);

      const boxLeft = Math.min(startWorld.x, endWorld.x);
      const boxRight = Math.max(startWorld.x, endWorld.x);
      const boxTop = Math.min(startWorld.y, endWorld.y);
      const boxBottom = Math.max(startWorld.y, endWorld.y);

      const newSelected = new Set(
        items
          .filter(
            (item) =>
              item.x < boxRight &&
              item.x + item.width > boxLeft &&
              item.y < boxBottom &&
              item.y + item.height > boxTop,
          )
          .map((item) => item.id),
      );
      setSelectedItems(newSelected);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const activeItemId = draggingItem || resizingItem || croppingItem;

    if (activeItemId) {
      handleItemPointerUp(activeItemId, e);
      return;
    }

    if (isPanning) {
      setIsPanning(false);
      startDragRef.current = null;
    }
    if (selectionBox) {
      setSelectionBox(null);
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Pointer capture may already be gone if the browser cancelled the gesture.
    }
  };

  const handleWheel = (e: ReactWheelEvent) => {
    e.preventDefault();
    cancelViewportAnimation();
    const data =
      getWheelInputType(e) === "trackpad-pan"
        ? handlePanAction({ e, viewport })
        : handleZoomAction({ e, viewport, containerRef });

    if (data) {
      setViewport(data);
    }
  };

  // Media item pointer handlers.
  const handleItemPointerDown = (id: string, e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(ACTION_SELECTORS)) {
      return;
    }

    e.stopPropagation();
    cancelViewportAnimation();

    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      startPanning(e.pointerId, e.clientX, e.clientY);
      return;
    }

    const cropHandle = (e.target as HTMLElement).closest<HTMLElement>(
      ".crop-handle",
    )?.dataset.cropHandle as CropHandle | undefined;
    const isResize = (e.target as HTMLElement).classList.contains(
      "resize-handle",
    );

    if (!selectedItems.has(id)) {
      setSelectedItems(new Set([id]));
    }

    if (cropHandle) {
      const cropItem = items.find((item) => item.id === id);
      if (!cropItem) return;

      setEditingCropItem(id);
      setCroppingItem(id);
      setDraggingItem(null);
      setResizingItem(null);
      cropHandleRef.current = cropHandle;
      cropStartRef.current = {
        x: cropItem.x,
        y: cropItem.y,
        width: cropItem.width,
        height: cropItem.height,
        crop: { ...getCrop(cropItem) },
      };
      resizeStartRef.current = null;
    } else if (isResize) {
      setResizingItem(id);
      setCroppingItem(null);
      const resizeIds = selectedItems.has(id) ? selectedItems : new Set([id]);
      resizeStartRef.current = new Map(
        items
          .filter((item) => resizeIds.has(item.id))
          .map((item) => [
            item.id,
            {
              width: item.width,
              height: item.height,
              crop: { ...getCrop(item) },
            },
          ]),
      );
    } else {
      setDraggingItem(id);
      setCroppingItem(null);
      resizeStartRef.current = null;
    }

    startDragRef.current = { x: e.clientX, y: e.clientY };

    // Capture container so move events fire globally, even when the pointer
    // leaves the item or container bounds on mid-drag.
    containerRef.current?.setPointerCapture(e.pointerId);

    setItems((prev) => {
      const itemIndex = prev.findIndex((i) => i.id === id);
      if (itemIndex > -1) {
        const newItems = [...prev];
        const [item] = newItems.splice(itemIndex, 1);
        newItems.push(item);
        return newItems;
      }
      return prev;
    });
  };

  const handleItemPointerMove = (id: string, e: React.PointerEvent) => {
    const dragStart = startDragRef.current;
    if (!dragStart) return;

    const dx = (e.clientX - dragStart.x) / viewport.zoom;
    const dy = (e.clientY - dragStart.y) / viewport.zoom;

    if (draggingItem === id) {
      setItems((prev) =>
        prev.map((item) =>
          selectedItems.has(item.id)
            ? { ...item, x: item.x + dx, y: item.y + dy }
            : item,
        ),
      );

      startDragRef.current = { x: e.clientX, y: e.clientY };
    } else if (resizingItem === id) {
      const resizeStart = resizeStartRef.current;

      setItems((prev) =>
        handleImageResize({
          dx,
          dy,
          prev,
          resizeStart,
          isHoldingShift: !!e.shiftKey,
        }),
      );
    } else if (croppingItem === id) {
      const cropStart = cropStartRef.current;
      const cropHandle = cropHandleRef.current;
      if (!cropStart || !cropHandle) return;

      setItems((prev) =>
        handleImageCrop({ id, dx, dy, prev, cropStart, cropHandle }),
      );
    }
  };

  const handleItemPointerUp = (id: string, e: React.PointerEvent) => {
    if (draggingItem === id || resizingItem === id || croppingItem === id) {
      setDraggingItem(null);
      setResizingItem(null);
      setCroppingItem(null);
      startDragRef.current = null;
      resizeStartRef.current = null;
      cropHandleRef.current = null;
      cropStartRef.current = null;
      try {
        containerRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture may already be gone if the browser cancelled the gesture.
      }
    }
  };

  const deleteItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    thumbnailQueueRef.current = thumbnailQueueRef.current.filter(
      (item) => item.id !== id,
    );
    thumbnailRequestedRef.current.delete(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    setSelectedItems((prev) => {
      const newSet = new Set(prev);
      newSet.delete(id);
      return newSet;
    });
    setEditingCropItem((prev) => (prev === id ? null : prev));
    clearAudioItem(id);
    clearVideoExportItemState(id);
  };

  const startCropEdit = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingCropItem((prev) => (prev === id ? null : id));
    setSelectedItems(new Set([id]));
  };

  const resetSize = (id: string, e: React.MouseEvent) => {
    const result = resetImageSize(e);
    if (!result) return;
    setItems((prev) => resetFrameSize({ id, prev, ...result }));
  };

  const screenshotItem = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const item = itemsRef.current.find((i) => i.id === id);
    if (!item) return;
    const mediaElement = (
      e.currentTarget as HTMLElement
    ).parentElement?.querySelector("video") as HTMLVideoElement | null;

    let outputDirectory = screenshotDirectory;
    if (!outputDirectory) {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose screenshot directory",
      });

      if (typeof selected !== "string") return;
      outputDirectory = selected;
      setScreenshotDirectory(selected);
    }

    try {
      const screenshotPath = await saveMediaScreenshot({
        item,
        outputDirectory,
        currentTime: mediaElement?.currentTime ?? 0,
      });

      await message(`Screenshot saved:\n\n${screenshotPath}`, {
        title: "Screenshot saved",
        kind: "info",
      });
    } catch (error) {
      await message(`Failed to save screenshot:\n\n${String(error)}`, {
        title: "Screenshot failed",
        kind: "error",
      });
    }
  };

  const toggleAudioPlayback = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedItems(new Set([id]));
    toggleAudioItem(id);
  };

  const exportSelectedVideo = useCallback(async () => {
    const selectedVideoItems = itemsRef.current.filter(
      (item) => item.type === "video" && selectedItemsRef.current.has(item.id),
    );

    if (selectedVideoItems.length !== 1) {
      await message("Select one video to export.", {
        title: "Export unavailable",
        kind: "warning",
      });
      return;
    }

    if (useVideoExportStore.getState().exportingItemId !== null) {
      await message("Wait for the current export to finish.", {
        title: "Export in progress",
        kind: "info",
      });
      return;
    }

    const item = selectedVideoItems[0];
    const outputPath = await save({
      title: "Export video",
      defaultPath: getExportDefaultPath(item.filePath),
      filters: [
        {
          name: "MP4 Video",
          extensions: ["mp4"],
        },
      ],
    });

    if (!outputPath) return;

    setExportingItemId(item.id);

    try {
      const mp4OutputPath = outputPath.toLowerCase().endsWith(".mp4")
        ? outputPath
        : `${outputPath}.mp4`;
      const output = await exportMediaVideo({
        item,
        outputPath: mp4OutputPath,
        loopRange: getLoopRange(getStoredVideoLoop(item.id)),
      });

      await message(`Video exported:\n\n${output}`, {
        title: "Export complete",
        kind: "info",
      });
    } catch (error) {
      await message(`Failed to export video:\n\n${String(error)}`, {
        title: "Export failed",
        kind: "error",
      });
    } finally {
      setExportingItemId(null);
    }
  }, [itemsRef, selectedItemsRef, setExportingItemId]);

  const { viewLeft, viewTop, viewRight, viewBottom } = getViewBounds(
    viewport,
    canvasSize.width,
    canvasSize.height,
  );
  const totalVideoCount = items.filter((item) => item.type === "video").length;
  const selectedVideoItems = items.filter(
    (item) => item.type === "video" && selectedItems.has(item.id),
  );
  const selectedVideoExportItem =
    selectedVideoItems.length === 1 ? selectedVideoItems[0] : null;

  return (
    <div
      className="canvas-container"
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas
        ref={backgroundCanvasRef}
        className={["canvas-background", canvasBackgroundPattern]
          .filter(Boolean)
          .join(" ")}
        aria-hidden="true"
      />
      <div
        className="canvas-world"
        style={{
          transform: `scale(${viewport.zoom}) translate(${viewport.x}px, ${viewport.y}px)`,
        }}
      >
        {items.map((item) => {
          const { id, url } = item;
          const crop = getCrop(item);
          const isCropEditing = editingCropItem === id;
          const isSelected = selectedItems.has(id);
          const itemLeft = item.x;
          const itemTop = item.y;
          const itemRight = item.x + item.width;
          const itemBottom = item.y + item.height;
          const isActiveAudioItem = activeAudioItemId === id;

          const isCulled =
            itemRight < viewLeft - CULL_MARGIN ||
            itemLeft > viewRight + CULL_MARGIN ||
            itemBottom < viewTop - CULL_MARGIN ||
            itemTop > viewBottom + CULL_MARGIN;

          if (isCulled && !isActiveAudioItem) {
            return null;
          }

          const isVisuallyInViewport =
            itemRight >= viewLeft &&
            itemLeft <= viewRight &&
            itemBottom >= viewTop &&
            itemTop <= viewBottom;
          const isInViewport = isVisuallyInViewport || isActiveAudioItem;

          const zIndex =
            draggingItem === id ||
            resizingItem === id ||
            croppingItem === id ||
            isCropEditing ||
            isSelected
              ? 100
              : 1;

          return (
            <div
              key={id}
              data-media-id={id}
              className={[
                "media-item",
                isSelected && "selected",
                isCropEditing && "crop-editing",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                left: item.x,
                top: item.y,
                width: item.width,
                height: item.height,
                zIndex,
              }}
              onPointerDown={(e) => handleItemPointerDown(id, e)}
              onPointerMove={(e) => handleItemPointerMove(id, e)}
              onPointerUp={(e) => handleItemPointerUp(id, e)}
            >
              <MediaFrameActions
                item={item}
                revealItem={(id, e) => {
                  revealItem({ e, id, items });
                }}
                screenshotItem={screenshotItem}
                resetSize={resetSize}
                deleteItem={deleteItem}
                startCropEdit={startCropEdit}
                toggleAudioPlayback={toggleAudioPlayback}
                isCropEditing={isCropEditing}
              />
              {item.type === "image" ? (
                <ImageActions
                  id={id}
                  url={url}
                  crop={crop}
                  item={item}
                  editingCropItem={editingCropItem}
                  handleItemPointerDown={handleItemPointerDown}
                />
              ) : (
                <>
                  <VideoMedia
                    url={url}
                    crop={crop}
                    item={item}
                    isInViewport={isInViewport}
                    zoom={viewport.zoom}
                    onThumbnailNeeded={requestThumbnail}
                  />
                  {isCropEditing && (
                    <CropOverlay
                      id={id}
                      handleItemPointerDown={handleItemPointerDown}
                    />
                  )}
                </>
              )}
              <div
                className="resize-handle"
                onPointerDown={(e) => handleItemPointerDown(id, e)}
              />
            </div>
          );
        })}
      </div>

      {selectionBox && <SelectionBox selectionBox={selectionBox} />}
      <DevelopmentOverlay
        canvasRef={containerRef}
        totalVideoCount={totalVideoCount}
      />
      <Hud
        items={items}
        saveConfig={() => saveConfig({ items, viewport })}
        loadConfig={loadConfig}
        settingsMenuItems={SETTINGS_MENU_ITEMS}
        settingsVersion={appVersion}
        selectedVideoExportItem={selectedVideoExportItem}
        selectedVideoExportCount={selectedVideoItems.length}
        isExportingSelectedVideo={exportingItemId !== null}
        onSelectActiveAudioItem={selectActiveAudioItem}
        onExportSelectedVideo={exportSelectedVideo}
      />
    </div>
  );
}
