import { getCurrentWebview } from "@tauri-apps/api/webview";
import { MediaItem, Viewport } from "./media.types";
import { useEffect, useRef } from "react";
import { onDropMedia } from "../components/CanvasActions";

export function attachDragPrevention(target: Window) {
  const prevent = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };

  target.addEventListener("dragenter", prevent);
  target.addEventListener("dragover", prevent);
  target.addEventListener("drop", prevent);

  return () => {
    target.removeEventListener("dragenter", prevent);
    target.removeEventListener("dragover", prevent);
    target.removeEventListener("drop", prevent);
  };
}

interface UseTauriDropOptions {
  getViewport: () => Viewport;
  setItems: React.Dispatch<React.SetStateAction<MediaItem[]>>;
}

export function useTauriDrop({ getViewport, setItems }: UseTauriDropOptions) {
  const getViewportRef = useRef(getViewport);
  const setItemsRef = useRef(setItems);

  getViewportRef.current = getViewport;
  setItemsRef.current = setItems;

  useEffect(() => {
    const removeDragPrevention = attachDragPrevention(window);
    let isActive = true;
    let unlistenPromise: Promise<(() => void) | void> | null = null;

    try {
      unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type !== "drop") return;

        void (async () => {
          const items = await onDropMedia({
            paths: payload.paths,
            viewportRef: { current: getViewportRef.current() },
          });

          if (!isActive || items.length === 0) return;
          setItemsRef.current((prev) => [...prev, ...items]);
        })();
      });
    } catch (error) {
      console.warn("Native drag/drop unavailable; falling back to browser-only mode.", error);
    }

    return () => {
      isActive = false;
      removeDragPrevention();
      void unlistenPromise?.then((unlisten) => unlisten?.());
    };
  }, []);
}
