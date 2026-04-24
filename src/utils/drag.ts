import { getCurrentWebview } from "@tauri-apps/api/webview";
import { MediaItem, Viewport } from "./media.types";
import { useEffect } from "react";
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
  viewportRef: React.RefObject<Viewport>;
  setItems: React.Dispatch<React.SetStateAction<MediaItem[]>>;
}

export function useTauriDrop({ viewportRef, setItems }: UseTauriDropOptions) {
  useEffect(() => {
    const removeDragPrevention = attachDragPrevention(window);
    let unlistenPromise: Promise<(() => void) | void> | null = null;

    try {
      unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          void onDropMedia({
            paths: event.payload.paths,
            viewportRef,
          }).then((items) => {
            if (items.length > 0) {
              setItems((prev) => [...prev, ...items]);
            }
          });
        }
      });
    } catch (error) {
      console.warn("Native drag/drop unavailable; falling back to browser-only mode.", error);
    }

    return () => {
      removeDragPrevention();
      void unlistenPromise?.then((unlisten) => unlisten?.());
    };
  }, []);
}
