import { useState, useRef, WheelEvent as ReactWheelEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import "./InfiniteCanvas.css";
import { ISelectionBox, SelectionBox } from "./components/SelectionBox";
import { Hud } from "./components/Hud";
import { DevelopmentOverlay } from "./components/DevelopmentOverlay";
import {
  CropOverlay,
  MediaFrameActions,
  resetFrameSize,
} from "./components/MediaFrameActions";
import { getCrop, useThumbnailQueue } from "./utils/media";
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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const selectedItemsRef = useRef(selectedItems);
  selectedItemsRef.current = selectedItems;

  const containerRef = useRef<HTMLDivElement>(null);
  const startDragRef = useRef<{ x: number; y: number } | null>(null);
  const resizeStartRef = useRef<Map<
    string,
    { width: number; height: number; crop: CropInsets }
  > | null>(null);
  const cropHandleRef = useRef<CropHandle | null>(null);
  const cropStartRef = useRef<TCropStart>(null);
  const thumbnailQueueRef = useRef<MediaItem[]>([]);
  const thumbnailRequestedRef = useRef<Set<string>>(new Set());

  const { requestThumbnail } = useThumbnailQueue(setItems);

  const startPanning = (
    pointerId: number,
    clientX: number,
    clientY: number,
  ) => {
    setIsPanning(true);
    startDragRef.current = { x: clientX, y: clientY };
    containerRef.current?.setPointerCapture(pointerId);
  };

  useTauriDrop({ viewportRef, setItems });
  useCanvasHotkeys({
    itemsRef,
    selectedItemsRef,
    setItems,
    setSelectedItems,
    setEditingCropItem,
  });

  const handlePointerDown = (e: React.PointerEvent) => {
    if (
      e.target === containerRef.current ||
      (e.target as HTMLElement).classList.contains("canvas-background")
    ) {
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
    if (isPanning && startDragRef.current) {
      const dx = (e.clientX - startDragRef.current.x) / viewport.zoom;
      const dy = (e.clientY - startDragRef.current.y) / viewport.zoom;

      setViewport((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      startDragRef.current = { x: e.clientX, y: e.clientY };
    } else if (selectionBox && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const clientY = e.clientY - rect.top;

      setSelectionBox((prev) =>
        prev ? { ...prev, endX: clientX, endY: clientY } : null,
      );

      const startWorldX = selectionBox.startX / viewport.zoom - viewport.x;
      const startWorldY = selectionBox.startY / viewport.zoom - viewport.y;
      const endWorldX = clientX / viewport.zoom - viewport.x;
      const endWorldY = clientY / viewport.zoom - viewport.y;

      const boxLeft = Math.min(startWorldX, endWorldX);
      const boxRight = Math.max(startWorldX, endWorldX);
      const boxTop = Math.min(startWorldY, endWorldY);
      const boxBottom = Math.max(startWorldY, endWorldY);

      const newSelected = new Set<string>();
      items.forEach((item) => {
        if (
          item.x < boxRight &&
          item.x + item.width > boxLeft &&
          item.y < boxBottom &&
          item.y + item.height > boxTop
        ) {
          newSelected.add(item.id);
        }
      });
      setSelectedItems(newSelected);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isPanning) {
      setIsPanning(false);
      startDragRef.current = null;
    }
    if (selectionBox) {
      setSelectionBox(null);
    }
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch (ex) {}
  };

  const handleWheel = (e: ReactWheelEvent) => {
    e.preventDefault();
    const data =
      getWheelInputType(e) === "trackpad-pan"
        ? handlePanAction({ e, viewport })
        : handleZoomAction({ e, viewport, containerRef });

    if (data) {
      setViewport(data);
    }
  };

  const handleItemPointerDown = (id: string, e: React.PointerEvent) => {
    if (
      (e.target as HTMLElement).closest(
        ".reset-btn, .delete-btn, .crop-btn, .reveal-btn",
      )
    ) {
      return;
    }

    e.stopPropagation();

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

    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

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
    if (draggingItem === id && startDragRef.current) {
      const dx = (e.clientX - startDragRef.current.x) / viewport.zoom;
      const dy = (e.clientY - startDragRef.current.y) / viewport.zoom;

      setItems((prev) =>
        prev.map((item) =>
          selectedItems.has(item.id)
            ? { ...item, x: item.x + dx, y: item.y + dy }
            : item,
        ),
      );

      startDragRef.current = { x: e.clientX, y: e.clientY };
    } else if (resizingItem === id && startDragRef.current) {
      const dx = (e.clientX - startDragRef.current.x) / viewport.zoom;
      const dy = (e.clientY - startDragRef.current.y) / viewport.zoom;
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
    } else if (croppingItem === id && startDragRef.current) {
      const cropStart = cropStartRef.current;
      const cropHandle = cropHandleRef.current;
      if (!cropStart || !cropHandle) return;

      const dx = (e.clientX - startDragRef.current.x) / viewport.zoom;
      const dy = (e.clientY - startDragRef.current.y) / viewport.zoom;

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
      e.currentTarget.releasePointerCapture(e.pointerId);
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

  const screenWidth = window.innerWidth / viewport.zoom;
  const screenHeight = window.innerHeight / viewport.zoom;
  const viewLeft = -viewport.x;
  const viewTop = -viewport.y;
  const viewRight = viewLeft + screenWidth;
  const viewBottom = viewTop + screenHeight;
  const cullMargin = 500;
  const totalVideoCount = items.reduce(
    (count, item) => count + (item.type === "video" ? 1 : 0),
    0,
  );

  const loadConfig = async () => {
    const result = await loadFromStorage();
    if (!result.ok) {
      if (result.reason !== "cancelled") {
        await message(`Failed to save config:\n\n${result.reason}`, {
          title: "Save failed",
          kind: "error",
        });
      }

      return;
    }
    const { data } = result;

    if (data.items) {
      // Re-generate URLs using convertFileSrc locally in case app restarted or paths changed
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
      setViewport(data.viewport);
    }
    setSelectedItems(new Set());
  };

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
      <div
        className="canvas-background"
        style={{
          backgroundPosition: `${viewport.x * viewport.zoom}px ${viewport.y * viewport.zoom}px`,
          backgroundSize: `${50 * viewport.zoom}px ${50 * viewport.zoom}px`,
        }}
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
          const itemLeft = item.x;
          const itemTop = item.y;
          const itemRight = item.x + item.width;
          const itemBottom = item.y + item.height;

          if (
            itemRight < viewLeft - cullMargin ||
            itemLeft > viewRight + cullMargin ||
            itemBottom < viewTop - cullMargin ||
            itemTop > viewBottom + cullMargin
          ) {
            return null;
          }

          const isInViewport =
            itemRight >= viewLeft &&
            itemLeft <= viewRight &&
            itemBottom >= viewTop &&
            itemTop <= viewBottom;

          const zIndex =
            draggingItem === id ||
            resizingItem === id ||
            croppingItem === id ||
            editingCropItem === id ||
            selectedItems.has(id)
              ? 100
              : 1;

          return (
            <div
              key={id}
              className={`media-item ${selectedItems.has(id) ? "selected" : ""} ${
                editingCropItem === id ? "crop-editing" : ""
              }`}
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
                resetSize={resetSize}
                deleteItem={deleteItem}
                startCropEdit={startCropEdit}
                isCropEditing={editingCropItem === id}
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
                  {editingCropItem === id && (
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
        isSettingsOpen={isSettingsOpen}
        openSettings={() => setIsSettingsOpen(true)}
        closeSettings={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}
