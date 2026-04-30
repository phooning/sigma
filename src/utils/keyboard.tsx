import type { SetStateAction } from "react";
import { useEffect, useEffectEvent } from "react";
import type { MediaItem } from "./media.types";

type CanvasHotkeyConfig = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  getItems: () => MediaItem[];
  selectedItemsRef: React.RefObject<Set<string>>;
  onSave: () => void | Promise<void>;
  setItems: React.Dispatch<React.SetStateAction<MediaItem[]>>;
  setSelectedItems: React.Dispatch<React.SetStateAction<Set<string>>>;
  setEditingCropItem: (value: SetStateAction<string | null>) => void;
};

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;

  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true']"),
  );
};

export function useCanvasHotkeys(config: CanvasHotkeyConfig) {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const {
      containerRef,
      getItems,
      onSave,
      selectedItemsRef,
      setItems,
      setSelectedItems,
      setEditingCropItem,
    } = config;

    const toggleSelectedVideosPlayback = () => {
      const selected = selectedItemsRef.current;
      if (selected.size === 0) return false;

      const selectedVideos = getItems()
        .filter((item) => item.type === "video" && selected.has(item.id))
        .map((item) =>
          containerRef.current
            ?.querySelector<HTMLElement>(`[data-media-id="${item.id}"]`)
            ?.querySelector("video"),
        )
        .filter(
          (video): video is HTMLVideoElement =>
            video instanceof HTMLVideoElement,
        );

      if (selectedVideos.length === 0) return false;

      const shouldPlay = selectedVideos.every((video) => video.paused);
      selectedVideos.forEach((video) => {
        if (shouldPlay) {
          void video.play().catch(() => {});
        } else if (!video.paused) {
          video.pause();
        }
      });

      return true;
    };

    if (isEditableTarget(event.target)) return;

    if (event.key === "Escape") {
      event.preventDefault();
      setSelectedItems(new Set());
      setEditingCropItem(null);
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      const selected = selectedItemsRef.current;
      if (selected.size === 0) return;

      event.preventDefault();
      setItems((prev) => prev.filter((item) => !selected.has(item.id)));
      setSelectedItems(new Set());
      setEditingCropItem(null);
      return;
    }

    const isSave =
      event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey);

    if (isSave) {
      event.preventDefault();
      onSave();
      return;
    }

    if (event.key === " " || event.code === "Space") {
      if (toggleSelectedVideosPlayback()) {
        event.preventDefault();
      }
      return;
    }

    const isSelectAll =
      event.key.toLowerCase() === "a" && (event.ctrlKey || event.metaKey);

    if (isSelectAll) {
      event.preventDefault();
      setSelectedItems(new Set(getItems().map((item) => item.id)));
      setEditingCropItem(null);
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      handleKeyDown(event);
    };

    window.addEventListener("keydown", listener);

    return () => {
      window.removeEventListener("keydown", listener);
    };
  }, []);
}
