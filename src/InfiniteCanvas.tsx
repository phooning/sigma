import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  WheelEvent as ReactWheelEvent,
} from "react";
import { flushSync } from "react-dom";
import { open, save } from "@tauri-apps/plugin-dialog";
import { SelectionBox } from "./components/SelectionBox";
import { Hud } from "./components/Hud";
import { DevelopmentOverlay } from "./components/DevelopmentOverlay";
import { resetFrameSize } from "./components/MediaFrameActions";
import {
  exportMediaVideo,
  getCrop,
  getCropBoxStyle,
  saveMediaScreenshot,
  useDecodeArbiterFeeder,
} from "./utils/media";
import { CropHandle, CropInsets, MediaItem } from "./utils/media.types";
import {
  handleImageCrop,
  handleImageResize,
  resetImageSize,
  TCropStart,
  TResizeStart,
} from "./components/ImageActions";
import { CanvasMediaItem } from "./components/CanvasMediaItem";
import { revealItem } from "./utils/fs";
import { appVersion, SETTINGS_MENU_ITEMS } from "./components/HudActions";
import {
  getWheelInputType,
  handlePanAction,
  handleZoomAction,
} from "./components/CanvasActions";
import { useTauriDrop as useUploadDrop } from "./utils/drag";
import { useCanvasHotkeys } from "./utils/keyboard";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useAudioPlayback } from "./stores/useAudioPlaybackStore";
import {
  getStoredVideoLoop,
  useVideoExportStore,
} from "./stores/useVideoExportStore";
import { useActiveAudioSelection } from "./components/useActiveAudioSelection";
import { useCanvasViewport } from "./components/useCanvasViewport";
import { getExportDefaultPath } from "./utils/exportPaths";
import { getViewBounds } from "./utils/viewport";
import { getImageLod, getLoopRange, getVideoLod } from "./utils/videoUtils";
import { notify } from "./utils/notifications";
import { ACTION_SELECTORS } from "./utils/press";
import { NativeVideoSurface } from "./components/native-video/NativeVideoSurface";
import { useCanvasSessionStore } from "./stores/useCanvasSessionStore";
import { useInteractionStore } from "./stores/useInteractionStore";
import {
  NativeImageSurface,
  supportsNativeImageSurface,
} from "./components/native-image/NativeImageSurface";

type ItemMotionMode = "drag" | "resize" | "crop";

type TransientItemMotion = {
  mode: ItemMotionMode;
  activeIds: Set<string>;
  baseItems: MediaItem[];
  latestItems: MediaItem[];
  startPointer: { x: number; y: number };
  resizeStart: TResizeStart | null;
  cropStart: TCropStart | null;
  cropHandle: CropHandle | null;
};

export default function InfiniteCanvas() {
  const items = useCanvasSessionStore((state) => state.items);
  const setItems = useCanvasSessionStore((state) => state.setItems);
  const saveSessionToFile = useCanvasSessionStore(
    (state) => state.saveSessionToFile,
  );
  const loadSessionFromFile = useCanvasSessionStore(
    (state) => state.loadSessionFromFile,
  );
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [transientItemIds, setTransientItemIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [canvasSize, setCanvasSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  const draggingItem = useInteractionStore((s) => s.draggingItem);
  const resizingItem = useInteractionStore((s) => s.resizingItem);
  const editingCropItem = useInteractionStore((s) => s.editingCropItem);
  const croppingItem = useInteractionStore((s) => s.croppingItem);
  const selectionBox = useInteractionStore((s) => s.selectionBox);
  const startDragging = useInteractionStore((s) => s.startDragging);
  const startResizing = useInteractionStore((s) => s.startResizing);
  const startCropping = useInteractionStore((s) => s.startCropping);
  const startInteractionPanning = useInteractionStore((s) => s.startPanning);
  const startSelecting = useInteractionStore((s) => s.startSelecting);
  const setSelectionBox = useInteractionStore((s) => s.setSelectionBox);
  const clearSelectionBox = useInteractionStore((s) => s.clearSelectionBox);
  const stopPanning = useInteractionStore((s) => s.stopPanning);
  const clearItemInteraction = useInteractionStore((s) => s.clearItemInteraction);
  const setEditingCropItem = useInteractionStore((s) => s.setEditingCropItem);
  const toggleEditingCropItem = useInteractionStore((s) => s.toggleEditingCropItem);

  const screenshotDirectory = useSettingsStore((s) => s.screenshotDirectory);
  const setScreenshotDirectory = useSettingsStore((s) => s.setScreenshotDirectory);
  const canvasBackgroundPattern = useSettingsStore((s) => s.canvasBackgroundPattern);
  const { toggleAudioItem, clearAudioItem, activeAudioItemId } =
    useAudioPlayback();

  const exportingItemId = useVideoExportStore((s) => s.exportingItemId);
  const setExportingItemId = useVideoExportStore((s) => s.setExportingItemId);
  const clearVideoExportItemState = useVideoExportStore((s) => s.clearItemState);
  const clearAllVideoExportState = useVideoExportStore((s) => s.clearAllItemState);

  // Refs mirrored for async callbacks and global pointer gestures.
  const worldRef = useRef<HTMLDivElement>(null);
  const selectedItemsRef = useRef(selectedItems);
  selectedItemsRef.current = selectedItems;
  const screenshotDirectoryRef = useRef(screenshotDirectory);
  screenshotDirectoryRef.current = screenshotDirectory;

  const containerRef = useRef<HTMLDivElement>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const startDragRef = useRef<{ x: number; y: number } | null>(null);
  const resizeStartRef = useRef<Map<
    string,
    { width: number; height: number; crop: CropInsets }
  > | null>(null);
  const cropHandleRef = useRef<CropHandle | null>(null);
  const cropStartRef = useRef<TCropStart>(null);
  const transientItemMotionRef = useRef<TransientItemMotion | null>(null);

  const {
    viewport,
    getViewport,
    commitViewport,
    cancelViewportAnimation,
    panViewportTo,
  } = useCanvasViewport({
    backgroundCanvasRef,
    worldRef,
    canvasSize,
    canvasBackgroundPattern,
  });

  useUploadDrop({
    getViewport,
    setItems,
  });

  useCanvasHotkeys({
    containerRef,
    getItems: () => useCanvasSessionStore.getState().items,
    onSave: saveSessionToFile,
    selectedItemsRef,
    setItems,
    setSelectedItems,
    setEditingCropItem,
  });

  // Canvas integrations.
  const { requestImagePreview, requestThumbnail } = useDecodeArbiterFeeder({
    items,
    getViewport,
    canvasSize,
    setItems,
  });

  const getMediaItemElement = useCallback((id: string) => {
    const mediaItems = containerRef.current?.querySelectorAll<HTMLElement>(
      ".media-item",
    );
    return Array.from(mediaItems ?? []).find(
      (element) => element.dataset.mediaId === id,
    ) ?? null;
  }, []);

  const applyMediaItemLayout = useCallback(
    (item: MediaItem) => {
      const element = getMediaItemElement(item.id);
      if (!element) return;

      element.style.left = `${item.x}px`;
      element.style.top = `${item.y}px`;
      element.style.width = `${item.width}px`;
      element.style.height = `${item.height}px`;

      const cropBox = element.querySelector<HTMLElement>(".media-crop-box");
      if (!cropBox) return;

      const cropBoxStyle = getCropBoxStyle(item, getCrop(item));
      cropBox.style.left = `${cropBoxStyle.left}px`;
      cropBox.style.top = `${cropBoxStyle.top}px`;
      cropBox.style.width = `${cropBoxStyle.width}px`;
      cropBox.style.height = `${cropBoxStyle.height}px`;
    },
    [getMediaItemElement],
  );

  const applyDragItemTransform = useCallback(
    (activeIds: Set<string>, dx: number, dy: number) => {
      activeIds.forEach((activeId) => {
        const element = getMediaItemElement(activeId);
        if (!element) return;

        element.style.setProperty("--media-transient-x", `${dx}px`);
        element.style.setProperty("--media-transient-y", `${dy}px`);
      });
    },
    [getMediaItemElement],
  );

  const clearDragItemTransforms = useCallback(
    (activeIds: Set<string>) => {
      activeIds.forEach((activeId) => {
        const element = getMediaItemElement(activeId);
        if (!element) return;

        element.style.removeProperty("--media-transient-x");
        element.style.removeProperty("--media-transient-y");
      });
    },
    [getMediaItemElement],
  );

  const moveItemToTop = useCallback((currentItems: MediaItem[], id: string) => {
    const itemIndex = currentItems.findIndex((item) => item.id === id);
    if (itemIndex === -1 || itemIndex === currentItems.length - 1) {
      return currentItems;
    }

    const nextItems = [...currentItems];
    const [item] = nextItems.splice(itemIndex, 1);
    nextItems.push(item);
    return nextItems;
  }, []);

  const selectItemForInteraction = useCallback((id: string) => {
    if (selectedItemsRef.current.has(id)) {
      return selectedItemsRef.current;
    }

    const nextSelection = new Set([id]);
    selectedItemsRef.current = nextSelection;
    setSelectedItems(nextSelection);
    return nextSelection;
  }, []);

  const beginTransientItemMotion = useCallback(
    (motion: TransientItemMotion) => {
      transientItemMotionRef.current = motion;
      setTransientItemIds(new Set(motion.activeIds));
    },
    [],
  );

  const clearTransientItemMotion = useCallback(() => {
    const motion = transientItemMotionRef.current;
    if (motion?.mode === "drag") {
      clearDragItemTransforms(motion.activeIds);
    }

    transientItemMotionRef.current = null;
    setTransientItemIds(new Set());
  }, [clearDragItemTransforms]);

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
    startInteractionPanning();
    startDragRef.current = { x: clientX, y: clientY };
    containerRef.current?.setPointerCapture(pointerId);
  };

  const loadConfig = async () => {
    cancelViewportAnimation();
    const didLoad = await loadSessionFromFile();
    if (!didLoad) return;

    setSelectedItems(new Set());
    clearTransientItemMotion();
    clearSelectionBox();
    clearItemInteraction();
    stopPanning();
    setEditingCropItem(null);
    clearAudioItem();
    clearAllVideoExportState();
  };

  const selectActiveAudioItem = useActiveAudioSelection({
    activeAudioItemId,
    containerRef,
    getItems: () => useCanvasSessionStore.getState().items,
    getViewport,
    panViewportTo,
    setEditingCropItem,
    setSelectedItems,
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

        startSelecting({
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
    const interactionState = useInteractionStore.getState();
    const activeItemId = interactionState.getActiveItemId();

    if (activeItemId) {
      handleItemPointerMove(activeItemId, e);
      return;
    }

    if (interactionState.isPanning && startDragRef.current) {
      const currentViewport = getViewport();
      const dx = (e.clientX - startDragRef.current.x) / currentViewport.zoom;
      const dy = (e.clientY - startDragRef.current.y) / currentViewport.zoom;
      const nextViewport = {
        ...currentViewport,
        x: currentViewport.x + dx,
        y: currentViewport.y + dy,
      };

      commitViewport(nextViewport);
      startDragRef.current = { x: e.clientX, y: e.clientY };
    } else if (interactionState.selectionBox && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;
      const currentViewport = getViewport();
      const toWorld = (cx: number, cy: number) => ({
        x: cx / currentViewport.zoom - currentViewport.x,
        y: cy / currentViewport.zoom - currentViewport.y,
      });

      setSelectionBox((prev) =>
        prev ? { ...prev, endX: clientX, endY: clientY } : null,
      );

      const startWorld = toWorld(
        interactionState.selectionBox.startX,
        interactionState.selectionBox.startY,
      );
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
    const interactionState = useInteractionStore.getState();
    const activeItemId = interactionState.getActiveItemId();

    if (activeItemId) {
      handleItemPointerUp(activeItemId, e);
      return;
    }

    if (interactionState.isPanning) {
      stopPanning();
      startDragRef.current = null;
      commitViewport(getViewport(), {
        flushDomNow: true,
        syncReact: true,
      });
    }
    if (interactionState.selectionBox) {
      clearSelectionBox();
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
    const currentViewport = getViewport();
    const data =
      getWheelInputType(e) === "trackpad-pan"
        ? handlePanAction({ e, viewport: currentViewport })
        : handleZoomAction({ e, viewport: currentViewport, containerRef });

    if (data) {
      commitViewport(data);
    }
  };

  // Media item pointer handlers.
  const handleItemPointerDown = useCallback(
    (id: string, e: React.PointerEvent) => {
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
      const nextSelection = selectItemForInteraction(id);
      const currentItems = useCanvasSessionStore.getState().items;
      const reorderedItems = moveItemToTop(currentItems, id);
      if (reorderedItems !== currentItems) {
        setItems(reorderedItems);
      }

      let mode: ItemMotionMode = "drag";
      let activeIds = new Set<string>(nextSelection);
      let cropStart: TCropStart | null = null;
      let cropHandleForMotion: CropHandle | null = null;
      let resizeStart: TResizeStart | null = null;

      if (cropHandle) {
        const cropItem = reorderedItems.find((item) => item.id === id);
        if (!cropItem) return;

        mode = "crop";
        activeIds = new Set([id]);
        cropHandleForMotion = cropHandle;
        cropStart = {
          x: cropItem.x,
          y: cropItem.y,
          width: cropItem.width,
          height: cropItem.height,
          crop: { ...getCrop(cropItem) },
        };

        setEditingCropItem(id);
        startCropping(id);
        cropHandleRef.current = cropHandleForMotion;
        cropStartRef.current = cropStart;
        resizeStartRef.current = null;
      } else if (isResize) {
        mode = "resize";
        activeIds = new Set(nextSelection);
        resizeStart = new Map(
          reorderedItems
            .filter((item) => activeIds.has(item.id))
            .map((item) => [
              item.id,
              {
                width: item.width,
                height: item.height,
                crop: { ...getCrop(item) },
              },
            ]),
        );

        startResizing(id);
        resizeStartRef.current = resizeStart;
      } else {
        mode = "drag";
        activeIds = new Set(nextSelection);
        startDragging(id);
        resizeStartRef.current = null;
      }

      startDragRef.current = { x: e.clientX, y: e.clientY };

      // Capture container so move events fire globally, even when the pointer
      // leaves the item or container bounds on mid-drag.
      containerRef.current?.setPointerCapture(e.pointerId);

      beginTransientItemMotion({
        mode,
        activeIds,
        baseItems: reorderedItems,
        latestItems: reorderedItems,
        startPointer: { x: e.clientX, y: e.clientY },
        resizeStart,
        cropStart,
        cropHandle: cropHandleForMotion,
      });
    },
    [
      beginTransientItemMotion,
      cancelViewportAnimation,
      moveItemToTop,
      selectItemForInteraction,
      setEditingCropItem,
      setItems,
      startCropping,
      startDragging,
      startResizing,
    ],
  );

  const handleItemPointerMove = useCallback(
    (id: string, e: React.PointerEvent) => {
      const motion = transientItemMotionRef.current;
      if (!motion) return;

      const currentViewport = getViewport();
      const dx = (e.clientX - motion.startPointer.x) / currentViewport.zoom;
      const dy = (e.clientY - motion.startPointer.y) / currentViewport.zoom;
      const interactionState = useInteractionStore.getState();

      if (interactionState.isDraggingItem(id) && motion.mode === "drag") {
        motion.latestItems = motion.baseItems.map((item) =>
          motion.activeIds.has(item.id)
            ? { ...item, x: item.x + dx, y: item.y + dy }
            : item,
        );
        applyDragItemTransform(motion.activeIds, dx, dy);
      } else if (
        interactionState.isResizingItem(id) &&
        motion.mode === "resize"
      ) {
        motion.latestItems = handleImageResize({
          dx,
          dy,
          prev: motion.baseItems,
          resizeStart: motion.resizeStart,
          isHoldingShift: !!e.shiftKey,
        });
        motion.latestItems
          .filter((item) => motion.activeIds.has(item.id))
          .forEach(applyMediaItemLayout);
      } else if (
        interactionState.isCroppingItem(id) &&
        motion.mode === "crop"
      ) {
        if (!motion.cropStart || !motion.cropHandle) return;

        motion.latestItems = handleImageCrop({
          id,
          dx,
          dy,
          prev: motion.baseItems,
          cropStart: motion.cropStart,
          cropHandle: motion.cropHandle,
        });
        motion.latestItems
          .filter((item) => motion.activeIds.has(item.id))
          .forEach(applyMediaItemLayout);
      }
    },
    [applyDragItemTransform, applyMediaItemLayout, getViewport],
  );

  const handleItemPointerUp = useCallback(
    (id: string, e: React.PointerEvent) => {
      const interactionState = useInteractionStore.getState();

      if (
        interactionState.isDraggingItem(id) ||
        interactionState.isResizingItem(id) ||
        interactionState.isCroppingItem(id)
      ) {
        const motion = transientItemMotionRef.current;

        flushSync(() => {
          if (motion && motion.latestItems !== motion.baseItems) {
            setItems(motion.latestItems);
          }

          clearItemInteraction();
          setTransientItemIds(new Set());
        });

        if (motion?.mode === "drag") {
          clearDragItemTransforms(motion.activeIds);
        }

        transientItemMotionRef.current = null;
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
    },
    [clearDragItemTransforms, clearItemInteraction, setItems],
  );

  const deleteItem = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setItems((prev) => prev.filter((i) => i.id !== id));
      setSelectedItems((prev) => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
      setEditingCropItem((prev) => (prev === id ? null : prev));
      clearAudioItem(id);
      clearVideoExportItemState(id);
    },
    [clearAudioItem, clearVideoExportItemState],
  );

  const startCropEdit = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      toggleEditingCropItem(id);
      setSelectedItems(new Set([id]));
    },
    [toggleEditingCropItem],
  );

  const resetSize = useCallback(
    (id: string, e: React.MouseEvent) => {
      const item = useCanvasSessionStore
        .getState()
        .items.find((entry) => entry.id === id);
      const result = resetImageSize(e, item);
      if (!result) return;
      setItems((prev) => resetFrameSize({ id, prev, ...result }));
    },
    [setItems],
  );

  const screenshotItem = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const item = useCanvasSessionStore
        .getState()
        .items.find((i) => i.id === id);
      if (!item) return;
      const mediaElement = (
        e.currentTarget as HTMLElement
      ).parentElement?.querySelector("video") as HTMLVideoElement | null;

      let outputDirectory = screenshotDirectoryRef.current;
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

        notify.success("Screenshot saved", {
          description: screenshotPath,
        });
      } catch (error) {
        notify.error("Screenshot failed", {
          description: error,
        });
      }
    },
    [setScreenshotDirectory],
  );

  const toggleAudioPlayback = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setSelectedItems(new Set([id]));
      toggleAudioItem(id);
    },
    [toggleAudioItem],
  );

  const revealCanvasItem = useCallback((id: string, e: React.MouseEvent) => {
    revealItem({ e, id, items: useCanvasSessionStore.getState().items });
  }, []);

  const exportSelectedVideo = useCallback(async () => {
    const selectedVideoItems = useCanvasSessionStore
      .getState()
      .items.filter(
        (item) =>
          item.type === "video" && selectedItemsRef.current.has(item.id),
      );

    if (selectedVideoItems.length !== 1) {
      notify.warning("Export unavailable", {
        description: "Select one video to export.",
      });
      return;
    }

    if (useVideoExportStore.getState().exportingItemId !== null) {
      notify.info("Export in progress", {
        description: "Wait for the current export to finish.",
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

      notify.success("Export complete", {
        description: output,
      });
    } catch (error) {
      notify.error("Export failed", {
        description: error,
      });
    } finally {
      setExportingItemId(null);
    }
  }, [setExportingItemId]);

  const renderViewport = viewport;
  const viewBounds = getViewBounds(
    renderViewport,
    canvasSize.width,
    canvasSize.height,
  );
  const totalVideoCount = items.filter((item) => item.type === "video").length;
  const selectedVideoItems = items.filter(
    (item) => item.type === "video" && selectedItems.has(item.id),
  );
  const selectedVideoExportItem =
    selectedVideoItems.length === 1 ? selectedVideoItems[0] : null;
  const [isNativeImageSurfaceReady, setIsNativeImageSurfaceReady] =
    useState(false);
  const isNativeImageSurfaceSupported = useMemo(
    () => supportsNativeImageSurface(),
    [],
  );
  const isNativeImageSurfaceEnabled =
    isNativeImageSurfaceSupported && isNativeImageSurfaceReady;

  useEffect(() => {
    let changed = false;
    const nextItems = items.map((item) => {
      if (item.type === "image") {
        const imageLod = getImageLod(viewport.zoom, item, item.imageLod);
        if (item.imageLod === imageLod) return item;
        changed = true;
        return { ...item, imageLod };
      }

      const videoLod = getVideoLod(
        viewport.zoom,
        !!item.thumbnailUrl,
        item,
        item.videoLod,
      );
      if (item.videoLod === videoLod) return item;
      changed = true;
      return { ...item, videoLod };
    });

    if (changed) {
      setItems(nextItems);
    }
  }, [items, setItems, viewport.zoom]);

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
      <NativeImageSurface
        items={items}
        viewport={viewport}
        canvasSize={canvasSize}
        selectedItems={selectedItems}
        draggingItemId={draggingItem}
        resizingItemId={resizingItem}
        croppingItemId={croppingItem}
        editingCropItemId={editingCropItem}
        onReadyChange={setIsNativeImageSurfaceReady}
        requestImagePreview={requestImagePreview}
      />
      <NativeVideoSurface
        items={items}
        viewport={viewport}
        canvasSize={canvasSize}
        selectedItems={selectedItems}
        activeAudioItemId={activeAudioItemId}
      />
      <div className="canvas-world" ref={worldRef}>
        {items.map((item) => {
          const isTransientItem = transientItemIds.has(item.id);

          return (
            <CanvasMediaItem
              key={item.id}
              deleteItem={deleteItem}
              handleItemPointerDown={handleItemPointerDown}
              handleItemPointerMove={handleItemPointerMove}
              handleItemPointerUp={handleItemPointerUp}
              item={item}
              isActiveAudioItem={activeAudioItemId === item.id}
              isCropping={
                croppingItem === item.id ||
                (croppingItem !== null && isTransientItem)
              }
              isCropEditing={editingCropItem === item.id}
              isDragging={
                draggingItem === item.id ||
                (draggingItem !== null && isTransientItem)
              }
              isResizing={
                resizingItem === item.id ||
                (resizingItem !== null && isTransientItem)
              }
              isSelected={selectedItems.has(item.id)}
              requestImagePreview={requestImagePreview}
              requestThumbnail={requestThumbnail}
              resetSize={resetSize}
              revealItem={revealCanvasItem}
              screenshotItem={screenshotItem}
              startCropEdit={startCropEdit}
              toggleAudioPlayback={toggleAudioPlayback}
              useNativeImageSurface={isNativeImageSurfaceEnabled}
              viewBounds={viewBounds}
              zoom={renderViewport.zoom}
            />
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
        saveConfig={saveSessionToFile}
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
