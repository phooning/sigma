import { useEffect } from "react";
import type { SetStateAction } from "react";
import { MediaItem } from "./media.types";

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

const loadCanvasHotkeys = ({
  containerRef,
  getItems,
  onSave,
  selectedItemsRef,
  setItems,
  setSelectedItems,
  setEditingCropItem,
}: CanvasHotkeyConfig) => {
  const pauseSelectedVideos = () => {
    const selected = selectedItemsRef.current;
    if (selected.size === 0) return false;

    let hasSelectedVideo = false;

    getItems()
      .filter((item) => item.type === "video" && selected.has(item.id))
      .forEach((item) => {
        hasSelectedVideo = true;
        const mediaElement = containerRef.current?.querySelector<HTMLElement>(
          `[data-media-id="${item.id}"]`,
        );
        const video = mediaElement?.querySelector("video");

        if (video && !video.paused) {
          video.pause();
        }
      });

    return hasSelectedVideo;
  };

  const handleKeyDown = (event: KeyboardEvent) => {
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
      if (pauseSelectedVideos()) {
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
  };

  window.addEventListener("keydown", handleKeyDown);

  return () => {
    window.removeEventListener("keydown", handleKeyDown);
  };
};

export function useCanvasHotkeys(config: CanvasHotkeyConfig) {
  useEffect(() => loadCanvasHotkeys(config), []);
}
