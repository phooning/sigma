import { useEffect } from "react";
import { isMacOS } from "../components/CanvasActions";
import { MediaItem } from "./media.types";

type CanvasHotkeyConfig = {
  itemsRef: React.RefObject<MediaItem[]>;
  selectedItemsRef: React.RefObject<Set<string>>;
  setItems: React.Dispatch<React.SetStateAction<MediaItem[]>>;
  setSelectedItems: React.Dispatch<React.SetStateAction<Set<string>>>;
  setEditingCropItem: React.Dispatch<React.SetStateAction<string | null>>;
};

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;

  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true']"),
  );
};

const loadCanvasHotkeys = ({
  itemsRef,
  selectedItemsRef,
  setItems,
  setSelectedItems,
  setEditingCropItem,
}: CanvasHotkeyConfig) => {
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

    const isSelectAll =
      event.key.toLowerCase() === "a" &&
      (isMacOS() ? event.metaKey : event.ctrlKey);

    if (isSelectAll) {
      event.preventDefault();
      setSelectedItems(new Set(itemsRef.current.map((item) => item.id)));
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
