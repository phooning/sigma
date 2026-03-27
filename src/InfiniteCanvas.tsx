import {
  useState,
  useRef,
  useEffect,
  WheelEvent as ReactWheelEvent
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { Event } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "uuid";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import "./InfiniteCanvas.css";
import { ISelectionBox, SelectionBox } from "./components/SelectionBox";
import { Hud } from "./components/Hud";
import { MediaFrameActions } from "./components/MediaFrameActions";

export type MediaItemType = "image" | "video";

export interface MediaItem {
  id: string;
  type: MediaItemType;
  filePath: string;
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export default function InfiniteCanvas() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [draggingItem, setDraggingItem] = useState<string | null>(null);
  const [resizingItem, setResizingItem] = useState<string | null>(null);

  const [selectionBox, setSelectionBox] = useState<ISelectionBox | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const containerRef = useRef<HTMLDivElement>(null);
  const startDragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const preventDragDefaults = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    };

    window.addEventListener("dragenter", preventDragDefaults);
    window.addEventListener("dragover", preventDragDefaults);
    window.addEventListener("drop", preventDragDefaults);

    const unlistenPromise = getCurrentWebview().onDragDropEvent(
      (event: Event<DragDropEvent>) => {
        if (event.payload.type === "drop") {
          const centerX =
            -viewportRef.current.x +
            window.innerWidth / 2 / viewportRef.current.zoom;
          const centerY =
            -viewportRef.current.y +
            window.innerHeight / 2 / viewportRef.current.zoom;

          const promises = event.payload.paths.map((filePath, index) => {
            return new Promise<MediaItem | null>((resolve) => {
              const lowerPath = filePath.toLowerCase();
              const isVideo =
                lowerPath.endsWith(".mp4") ||
                lowerPath.endsWith(".webm") ||
                lowerPath.endsWith(".mov") ||
                lowerPath.endsWith(".mkv");
              const isImage =
                lowerPath.endsWith(".png") ||
                lowerPath.endsWith(".jpg") ||
                lowerPath.endsWith(".jpeg") ||
                lowerPath.endsWith(".gif") ||
                lowerPath.endsWith(".webp");

              if (!isVideo && !isImage) return resolve(null);

              const url = convertFileSrc(filePath);
              const createItem = (w: number, h: number): MediaItem => ({
                id: uuidv4(),
                type: isVideo ? "video" : "image",
                filePath,
                url,
                x: centerX + index * 1350,
                y: centerY,
                width: 1280,
                height: w ? (h / w) * 1280 : 720
              });

              if (isImage) {
                const img = new Image();
                img.onload = () => resolve(createItem(img.width, img.height));
                img.onerror = () => resolve(createItem(1280, 720));
                img.src = url;
              } else {
                const video = document.createElement("video");
                video.onloadedmetadata = () =>
                  resolve(createItem(video.videoWidth, video.videoHeight));
                video.onerror = () => resolve(createItem(1280, 720));
                video.src = url;
              }
            });
          });

          Promise.all(promises).then((results) => {
            const validItems = results.filter(
              (item): item is MediaItem => item !== null
            );
            if (validItems.length > 0) {
              setItems((prev) => [...prev, ...validItems]);
            }
          });
        }
      }
    );

    return () => {
      window.removeEventListener("dragenter", preventDragDefaults);
      window.removeEventListener("dragover", preventDragDefaults);
      window.removeEventListener("drop", preventDragDefaults);
      unlistenPromise.then((unlisten: () => void) => unlisten());
    };
  }, []);

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
          endY: clientY
        });
        setSelectedItems(new Set());
        e.currentTarget.setPointerCapture(e.pointerId);
      } else if (e.button === 1 || e.button === 2) {
        setIsPanning(true);
        startDragRef.current = { x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
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
        prev ? { ...prev, endX: clientX, endY: clientY } : null
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
    const zoomFactor = -e.deltaY * 0.001;
    const newZoom = Math.max(
      0.05,
      Math.min(viewport.zoom * (1 + zoomFactor), 5)
    );

    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const prevX = mouseX / viewport.zoom - viewport.x;
      const prevY = mouseY / viewport.zoom - viewport.y;

      const newX = mouseX / newZoom - prevX;
      const newY = mouseY / newZoom - prevY;

      setViewport({ x: newX, y: newY, zoom: newZoom });
    }
  };

  const handleItemPointerDown = (id: string, e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".reset-btn, .delete-btn")) {
      return;
    }

    e.stopPropagation();

    const isResize = (e.target as HTMLElement).classList.contains(
      "resize-handle"
    );

    if (!selectedItems.has(id)) {
      setSelectedItems(new Set([id]));
    }

    if (isResize) {
      setResizingItem(id);
    } else {
      setDraggingItem(id);
    }

    startDragRef.current = { x: e.clientX, y: e.clientY };

    // Capture container so move events fire gllobally, even when the pointer
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
            : item
        )
      );

      startDragRef.current = { x: e.clientX, y: e.clientY };
    } else if (resizingItem === id && startDragRef.current) {
      const dx = (e.clientX - startDragRef.current.x) / viewport.zoom;
      const dy = (e.clientY - startDragRef.current.y) / viewport.zoom;

      setItems((prev) =>
        prev.map((item) =>
          selectedItems.has(item.id)
            ? {
                ...item,
                width: Math.max(100, item.width + dx),
                height: Math.max(100, item.height + dy)
              }
            : item
        )
      );

      startDragRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleItemPointerUp = (id: string, e: React.PointerEvent) => {
    if (draggingItem === id || resizingItem === id) {
      setDraggingItem(null);
      setResizingItem(null);
      startDragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const deleteItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setItems((prev) => prev.filter((i) => i.id !== id));
    setSelectedItems((prev) => {
      const newSet = new Set(prev);
      newSet.delete(id);
      return newSet;
    });
  };

  const resetSize = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    const mediaEl = target.parentElement?.querySelector("img, video") as
      | HTMLImageElement
      | HTMLVideoElement;

    if (mediaEl) {
      let intrinsicWidth = 400;
      let intrinsicHeight = 300;

      if (mediaEl.tagName === "IMG") {
        intrinsicWidth = (mediaEl as HTMLImageElement).naturalWidth;
        intrinsicHeight = (mediaEl as HTMLImageElement).naturalHeight;
      } else if (mediaEl.tagName === "VIDEO") {
        intrinsicWidth = (mediaEl as HTMLVideoElement).videoWidth;
        intrinsicHeight = (mediaEl as HTMLVideoElement).videoHeight;
      }

      setItems((prev) =>
        prev.map((i) => {
          if (i.id === id) {
            const w = intrinsicWidth || 400;
            const h = intrinsicHeight || 300;
            return { ...i, width: 1280, height: (h / w) * 1280 };
          }
          return i;
        })
      );
    }
  };

  const saveConfig = async () => {
    try {
      const filePath = await save({
        filters: [
          {
            name: "Canvas Config",
            extensions: ["json"]
          }
        ]
      });

      if (filePath) {
        const configData = JSON.stringify({ items, viewport });
        await writeTextFile(filePath, configData);
      }
    } catch (err) {
      console.error("Failed to save:", err);
    }
  };

  const loadConfig = async () => {
    try {
      const selected = await open({
        filters: [
          {
            name: "Canvas Config",
            extensions: ["json"]
          }
        ]
      });

      if (selected && typeof selected === "string") {
        const contents = await readTextFile(selected);
        const data = JSON.parse(contents);

        if (data.items) {
          // Re-generate URLs using convertFileSrc locally in case app restarted or paths changed
          const loadedItems = data.items.map((i: any) => ({
            ...i,
            url: convertFileSrc(i.filePath)
          }));
          setItems(loadedItems);
        }
        if (data.viewport) {
          setViewport(data.viewport);
        }
        setSelectedItems(new Set());
      }
    } catch (err) {
      console.error("Failed to load:", err);
    }
  };

  const screenWidth = window.innerWidth / viewport.zoom;
  const screenHeight = window.innerHeight / viewport.zoom;
  const viewLeft = -viewport.x;
  const viewTop = -viewport.y;
  const viewRight = viewLeft + screenWidth;
  const viewBottom = viewTop + screenHeight;
  const cullMargin = 500;

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
          backgroundSize: `${50 * viewport.zoom}px ${50 * viewport.zoom}px`
        }}
      />
      <div
        className="canvas-world"
        style={{
          transform: `scale(${viewport.zoom}) translate(${viewport.x}px, ${viewport.y}px)`
        }}
      >
        {items.map((item) => {
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

          return (
            <div
              key={item.id}
              className={`media-item ${selectedItems.has(item.id) ? "selected" : ""}`}
              style={{
                left: item.x,
                top: item.y,
                width: item.width,
                height: item.height,
                zIndex:
                  draggingItem === item.id ||
                  resizingItem === item.id ||
                  selectedItems.has(item.id)
                    ? 100
                    : 1
              }}
              onPointerDown={(e) => handleItemPointerDown(item.id, e)}
              onPointerMove={(e) => handleItemPointerMove(item.id, e)}
              onPointerUp={(e) => handleItemPointerUp(item.id, e)}
            >
              <MediaFrameActions
                item={item}
                resetSize={resetSize}
                deleteItem={deleteItem}
              />
              {item.type === "image" ? (
                <img
                  src={item.url}
                  alt="canvas item"
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                />
              ) : (
                <video src={item.url} autoPlay loop muted playsInline />
              )}
              <div
                className="resize-handle"
                onPointerDown={(e) => handleItemPointerDown(item.id, e)}
              ></div>
            </div>
          );
        })}
      </div>

      {selectionBox && <SelectionBox selectionBox={selectionBox} />}
      <Hud items={items} saveConfig={saveConfig} loadConfig={loadConfig} />
    </div>
  );
}
