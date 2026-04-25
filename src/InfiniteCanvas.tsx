import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  WheelEvent as ReactWheelEvent,
} from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { SelectionBox } from "./components/SelectionBox";
import { Hud } from "./components/Hud";
import { DevelopmentOverlay } from "./components/DevelopmentOverlay";
import { resetFrameSize } from "./components/MediaFrameActions";
import {
  exportMediaVideo,
  getCrop,
  saveMediaScreenshot,
  useImagePreviewQueue,
  useThumbnailQueue,
} from "./utils/media";
import { CropHandle, CropInsets } from "./utils/media.types";
import {
  handleImageCrop,
  handleImageResize,
  resetImageSize,
  TCropStart,
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
import { useGetSettingsStore } from "./stores/useSettingsStore";
import { useAudioPlayback } from "./stores/useAudioPlaybackStore";
import {
  getStoredVideoLoop,
  useVideoExportStore,
} from "./stores/useVideoExportStore";
import { useActiveAudioSelection } from "./components/useActiveAudioSelection";
import { useCanvasViewport } from "./components/useCanvasViewport";
import { getExportDefaultPath } from "./utils/exportPaths";
import { getViewBounds } from "./utils/viewport";
import { getLoopRange } from "./utils/videoUtils";
import { notify } from "./utils/notifications";
import { ACTION_SELECTORS } from "./utils/press";
import { NativeVideoSurface } from "./components/native-video/NativeVideoSurface";
import { useCanvasSessionStore } from "./stores/useCanvasSessionStore";
import { useInteractionStore } from "./stores/useInteractionStore";
import {
  NativeImageSurface,
  supportsNativeImageSurface,
} from "./components/native-image/NativeImageSurface";

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
  const [canvasSize, setCanvasSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  const {
    draggingItem,
    resizingItem,
    editingCropItem,
    croppingItem,
    selectionBox,
    startDragging,
    startResizing,
    startCropping,
    startPanning: startInteractionPanning,
    startSelecting,
    setSelectionBox,
    clearSelectionBox,
    stopPanning,
    clearItemInteraction,
    setEditingCropItem,
    toggleEditingCropItem,
  } = useInteractionStore();

  const {
    screenshotDirectory,
    setScreenshotDirectory,
    canvasBackgroundPattern,
  } = useGetSettingsStore();
  const { toggleAudioItem, clearAudioItem, activeAudioItemId } =
    useAudioPlayback();

  const {
    exportingItemId,
    setExportingItemId,
    clearItemState: clearVideoExportItemState,
    clearAllItemState: clearAllVideoExportState,
  } = useVideoExportStore();

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

  const { viewport, commitViewport, cancelViewportAnimation, panViewportTo } =
    useCanvasViewport({
      backgroundCanvasRef,
      worldRef,
      canvasSize,
      canvasBackgroundPattern,
    });

  useUploadDrop({
    getViewport: () => useCanvasSessionStore.getState().viewport,
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
  const { requestImagePreview } = useImagePreviewQueue(setItems);
  const { requestThumbnail } = useThumbnailQueue(setItems);

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
    getViewport: () => useCanvasSessionStore.getState().viewport,
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
      const currentViewport = useCanvasSessionStore.getState().viewport;
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
      const currentViewport = useCanvasSessionStore.getState().viewport;
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
      commitViewport(useCanvasSessionStore.getState().viewport, {
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
    const currentViewport = useCanvasSessionStore.getState().viewport;
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

      if (!selectedItemsRef.current.has(id)) {
        setSelectedItems(new Set([id]));
      }

      if (cropHandle) {
        const cropItem = useCanvasSessionStore
          .getState()
          .items.find((item) => item.id === id);
        if (!cropItem) return;

        setEditingCropItem(id);
        startCropping(id);
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
        startResizing(id);
        const resizeIds = selectedItemsRef.current.has(id)
          ? selectedItemsRef.current
          : new Set([id]);
        resizeStartRef.current = useCanvasSessionStore
          .getState()
          .items.reduce((map, item) => {
            if (resizeIds.has(item.id)) {
              map.set(item.id, {
                width: item.width,
                height: item.height,
                crop: { ...getCrop(item) },
              });
            }
            return map;
          }, new Map());
      } else {
        startDragging(id);
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
    },
    [cancelViewportAnimation],
  );

  const handleItemPointerMove = useCallback(
    (id: string, e: React.PointerEvent) => {
      const dragStart = startDragRef.current;
      if (!dragStart) return;

      const currentViewport = useCanvasSessionStore.getState().viewport;
      const dx = (e.clientX - dragStart.x) / currentViewport.zoom;
      const dy = (e.clientY - dragStart.y) / currentViewport.zoom;
      const interactionState = useInteractionStore.getState();

      if (interactionState.isDraggingItem(id)) {
        setItems((prev) =>
          prev.map((item) =>
            selectedItemsRef.current.has(item.id)
              ? { ...item, x: item.x + dx, y: item.y + dy }
              : item,
          ),
        );

        startDragRef.current = { x: e.clientX, y: e.clientY };
      } else if (interactionState.isResizingItem(id)) {
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
      } else if (interactionState.isCroppingItem(id)) {
        const cropStart = cropStartRef.current;
        const cropHandle = cropHandleRef.current;
        if (!cropStart || !cropHandle) return;

        setItems((prev) =>
          handleImageCrop({ id, dx, dy, prev, cropStart, cropHandle }),
        );
      }
    },
    [],
  );

  const handleItemPointerUp = useCallback(
    (id: string, e: React.PointerEvent) => {
      const interactionState = useInteractionStore.getState();

      if (
        interactionState.isDraggingItem(id) ||
        interactionState.isResizingItem(id) ||
        interactionState.isCroppingItem(id)
      ) {
        clearItemInteraction();
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
    [clearItemInteraction],
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
        {items.map((item) => (
          <CanvasMediaItem
            key={item.id}
            deleteItem={deleteItem}
            handleItemPointerDown={handleItemPointerDown}
            handleItemPointerMove={handleItemPointerMove}
            handleItemPointerUp={handleItemPointerUp}
            item={item}
            isActiveAudioItem={activeAudioItemId === item.id}
            isCropping={croppingItem === item.id}
            isCropEditing={editingCropItem === item.id}
            isDragging={draggingItem === item.id}
            isResizing={resizingItem === item.id}
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
        ))}
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
