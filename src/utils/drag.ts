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

    const unlistenPromise = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        Promise.all(
          onDropMedia({
            paths: event.payload.paths,
            viewportRef,
            onThumbnailGenerated: (id, lodAssets) => {
              setItems((prev) =>
                prev.map((item) =>
                  item.id === id ? { ...item, ...lodAssets } : item,
                ),
              );
            },
          }),
        ).then((results) => {
          const validItems = results.filter(
            (item): item is MediaItem => item !== null,
          );
          if (validItems.length > 0) {
            setItems((prev) => [...prev, ...validItems]);
          }
        });
      }
    });

    return () => {
      removeDragPrevention();
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);
}
