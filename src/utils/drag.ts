import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef } from "react";
import { onDropMedia } from "../components/CanvasActions";
import { getSessionGeneration } from "../stores/useCanvasSessionStore";
import type { MediaItem, Viewport } from "./media.types";
import { notify } from "./notifications";

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
    let unlisten: (() => void) | undefined;
    const onRegistrationError = (error: unknown) => {
      console.warn("Native drag/drop unavailable.", error);
    };

    try {
      const registration = getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (!isActive || payload.type !== "drop") return;
        const generation = getSessionGeneration();

        void (async () => {
          const items = await onDropMedia({
            paths: payload.paths,
            viewportRef: { current: getViewportRef.current() },
          });

          if (
            !isActive ||
            generation !== getSessionGeneration() ||
            items.length === 0
          )
            return;
          setItemsRef.current((prev) => [...prev, ...items]);
        })().catch((error: unknown) => {
          if (!isActive || generation !== getSessionGeneration()) return;
          console.error("Failed to import dropped media:", error);
          notify.error("Media import failed", { description: String(error) });
        });
      });
      void registration
        .then((dispose) => {
          if (isActive) unlisten = dispose;
          else dispose();
        })
        .catch(onRegistrationError);
    } catch (error) {
      onRegistrationError(error);
    }

    return () => {
      isActive = false;
      removeDragPrevention();
      unlisten?.();
    };
  }, []);
}
