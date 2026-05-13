import type { SetStateAction } from "react";
import { useEffect, useEffectEvent } from "react";
import type { MediaItem } from "./media.types";

type CanvasHotkeyConfig = {
  getItems: () => MediaItem[];
  canSave: boolean;
  onCloseSettings: () => void;
  isSettingsOpen: boolean;
  onOpenSettings: () => void;
  onToggleDevMode: () => void;
  selectedItemsRef: React.RefObject<Set<string>>;
  onSave: () => void | Promise<void>;
  onSaveAs: () => void | Promise<void>;
  onCancelCropEditing: () => boolean;
  onScrubFrames: (deltaFrames: number) => boolean;
  onToggleSelectedVideosPlayback: () => boolean;
  onToggleCropActiveItem: () => boolean;
  onResetSizeActiveItem: () => boolean;
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
      canSave,
      getItems,
      isSettingsOpen,
      onCancelCropEditing,
      onCloseSettings,
      onOpenSettings,
      onResetSizeActiveItem,
      onSave,
      onSaveAs,
      onScrubFrames,
      onToggleSelectedVideosPlayback,
      onToggleCropActiveItem,
      onToggleDevMode,
      selectedItemsRef,
      setItems,
      setSelectedItems,
      setEditingCropItem,
    } = config;

    if (event.defaultPrevented || isEditableTarget(event.target)) return;

    if (event.key === "Escape") {
      if (isSettingsOpen) {
        event.preventDefault();
        onCloseSettings();
        return;
      }

      event.preventDefault();
      if (onCancelCropEditing()) {
        return;
      }
      if (selectedItemsRef.current.size === 0) {
        onOpenSettings();
      } else {
        setSelectedItems(new Set());
        setEditingCropItem(null);
      }
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
      if (canSave) {
        onSave();
      } else {
        onSaveAs();
      }
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const step = event.shiftKey ? 10 : 1;
      if (onScrubFrames(direction * step)) {
        event.preventDefault();
      }
      return;
    }

    if (event.key === "F1") {
      event.preventDefault();
      onToggleDevMode();
      return;
    }

    if (event.key === " " || event.code === "Space") {
      if (onToggleSelectedVideosPlayback()) {
        event.preventDefault();
      }
      return;
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "c") {
        if (onToggleCropActiveItem()) {
          event.preventDefault();
        }
        return;
      }

      if (key === "r") {
        if (onResetSizeActiveItem()) {
          event.preventDefault();
        }
        return;
      }
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
