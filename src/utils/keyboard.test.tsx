import { render } from "@testing-library/react";
import { createRef, type Dispatch, type SetStateAction } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCanvasHotkeys } from "./keyboard";
import type { MediaItem } from "./media.types";

type HarnessProps = {
  canSave?: boolean;
  isSettingsOpen?: boolean;
  items?: MediaItem[];
  selectedItems?: Set<string>;
  onCancelCropEditing?: () => boolean;
  onCloseSettings?: () => void;
  onOpenSettings?: () => void;
  onResetSizeActiveItem?: () => boolean;
  onSave?: () => void | Promise<void>;
  onSaveAs?: () => void | Promise<void>;
  onScrubFrames?: (deltaFrames: number) => boolean;
  onToggleCropActiveItem?: () => boolean;
  onToggleDevMode?: () => void;
  setEditingCropItem?: (value: SetStateAction<string | null>) => void;
  setItems?: Dispatch<SetStateAction<MediaItem[]>>;
  setSelectedItems?: Dispatch<SetStateAction<Set<string>>>;
};

function HotkeyHarness({
  canSave = false,
  isSettingsOpen = false,
  items = [],
  selectedItems = new Set<string>(),
  onCancelCropEditing = () => false,
  onCloseSettings = vi.fn(),
  onOpenSettings = vi.fn(),
  onResetSizeActiveItem = () => false,
  onSave = vi.fn(),
  onSaveAs = vi.fn(),
  onScrubFrames = () => false,
  onToggleCropActiveItem = () => false,
  onToggleDevMode = vi.fn(),
  setEditingCropItem = vi.fn(),
  setItems = vi.fn(),
  setSelectedItems = vi.fn(),
}: HarnessProps) {
  useCanvasHotkeys({
    canSave,
    containerRef: createRef<HTMLDivElement>(),
    getItems: () => items,
    isSettingsOpen,
    onCancelCropEditing,
    onCloseSettings,
    onOpenSettings,
    onResetSizeActiveItem,
    onSave,
    onSaveAs,
    onScrubFrames,
    onToggleCropActiveItem,
    onToggleDevMode,
    selectedItemsRef: { current: selectedItems },
    setEditingCropItem,
    setItems,
    setSelectedItems,
  });

  return <div />;
}

describe("useCanvasHotkeys", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Save As when no save path is available", () => {
    const onSave = vi.fn();
    const onSaveAs = vi.fn();
    render(<HotkeyHarness onSave={onSave} onSaveAs={onSaveAs} />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true }),
    );

    expect(onSave).not.toHaveBeenCalled();
    expect(onSaveAs).toHaveBeenCalledTimes(1);
  });

  it("uses Save when a save path is available", () => {
    const onSave = vi.fn();
    const onSaveAs = vi.fn();
    render(<HotkeyHarness canSave onSave={onSave} onSaveAs={onSaveAs} />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true }),
    );

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSaveAs).not.toHaveBeenCalled();
  });

  it("opens settings on Escape when nothing is selected", () => {
    const onOpenSettings = vi.fn();
    const setSelectedItems = vi.fn();
    const setEditingCropItem = vi.fn();
    render(
      <HotkeyHarness
        onOpenSettings={onOpenSettings}
        setEditingCropItem={setEditingCropItem}
        setSelectedItems={setSelectedItems}
      />,
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(setSelectedItems).not.toHaveBeenCalled();
    expect(setEditingCropItem).not.toHaveBeenCalled();
  });

  it("closes settings on Escape when the dialog is already open", () => {
    const onCloseSettings = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <HotkeyHarness
        isSettingsOpen
        onCloseSettings={onCloseSettings}
        onOpenSettings={onOpenSettings}
      />,
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onCloseSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it("clears selection on Escape when items are selected", () => {
    const setSelectedItems = vi.fn();
    const setEditingCropItem = vi.fn();
    render(
      <HotkeyHarness
        selectedItems={new Set(["item-1"])}
        setEditingCropItem={setEditingCropItem}
        setSelectedItems={setSelectedItems}
      />,
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(setSelectedItems).toHaveBeenCalledTimes(1);
    expect(setSelectedItems).toHaveBeenCalledWith(new Set());
    expect(setEditingCropItem).toHaveBeenCalledWith(null);
  });

  it("cancels crop editing on Escape before clearing selection", () => {
    const onCancelCropEditing = vi.fn(() => true);
    const setSelectedItems = vi.fn();
    render(
      <HotkeyHarness
        onCancelCropEditing={onCancelCropEditing}
        selectedItems={new Set(["item-1"])}
        setSelectedItems={setSelectedItems}
      />,
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onCancelCropEditing).toHaveBeenCalledTimes(1);
    expect(setSelectedItems).not.toHaveBeenCalled();
  });

  it("scrubs selected video frames with arrow keys", () => {
    const onScrubFrames = vi.fn(() => true);
    render(<HotkeyHarness onScrubFrames={onScrubFrames} />);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true }),
    );

    expect(onScrubFrames).toHaveBeenNthCalledWith(1, -1);
    expect(onScrubFrames).toHaveBeenNthCalledWith(2, 10);
  });

  it("starts crop mode and resets size for the active selected item", () => {
    const onToggleCropActiveItem = vi.fn(() => true);
    const onResetSizeActiveItem = vi.fn(() => true);
    render(
      <HotkeyHarness
        onResetSizeActiveItem={onResetSizeActiveItem}
        onToggleCropActiveItem={onToggleCropActiveItem}
        selectedItems={new Set(["item-1"])}
      />,
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));

    expect(onToggleCropActiveItem).toHaveBeenCalledTimes(1);
    expect(onResetSizeActiveItem).toHaveBeenCalledTimes(1);
  });
});
