import { useAudioPlaybackStore } from "../stores/useAudioPlaybackStore";
import { CROP_HANDLES, EMPTY_CROP } from "../utils/media";
import type { MediaItem } from "../utils/media.types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "./ui/tooltip";

function ActionTooltip({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function CropOverlay({
  id,
  handleItemPointerDown
}: {
  id: string;
  handleItemPointerDown: (id: string, e: React.PointerEvent) => void;
}) {
  return (
    <div className="crop-overlay" aria-hidden="true">
      {CROP_HANDLES.map((handle) => (
        <div
          key={handle}
          className={`crop-handle crop-handle-${handle}`}
          data-crop-handle={handle}
          onPointerDown={(e) => handleItemPointerDown(id, e)}
        />
      ))}
    </div>
  );
}

export const resetFrameSize = ({
  id,
  prev,
  intrinsicWidth,
  intrinsicHeight
}: {
  id: string;
  prev: MediaItem[];
  intrinsicWidth: number;
  intrinsicHeight: number;
}) => {
  const w = intrinsicWidth || 400;
  const h = intrinsicHeight || 300;

  return prev.map((i) =>
    i.id === id
      ? { ...i, width: 1280, height: (h / w) * 1280, crop: { ...EMPTY_CROP } }
      : i
  );
};

export function MediaFrameActions({
  item,
  revealItem,
  screenshotItem,
  resetSize,
  deleteItem,
  startCropEdit,
  toggleAudioPlayback,
  isCropEditing
}: {
  item: MediaItem;
  revealItem: (id: string, e: React.MouseEvent) => void;
  screenshotItem: (id: string, e: React.MouseEvent) => void;
  resetSize: (id: string, e: React.MouseEvent) => void;
  deleteItem: (id: string, e: React.MouseEvent) => void;
  startCropEdit: (id: string, e: React.MouseEvent) => void;
  toggleAudioPlayback: (id: string, e: React.MouseEvent) => void;
  isCropEditing: boolean;
}) {
  const isAudioActive = useAudioPlaybackStore(
    (s) => s.activeItemId === item.id
  );
  const audioLabel = isAudioActive
    ? "Disable audio playback"
    : "Enable audio playback";

  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <ActionTooltip label="Crop">
        <button
          type="button"
          className="crop-btn"
          onClick={(e) => startCropEdit(item.id, e)}
          aria-label="Crop"
          aria-pressed={isCropEditing}
        >
          C
        </button>
      </ActionTooltip>
      <ActionTooltip label="Reset size">
        <button
          type="button"
          className="reset-btn"
          onClick={(e) => resetSize(item.id, e)}
          aria-label="Reset size"
        >
          ⤡
        </button>
      </ActionTooltip>
      <ActionTooltip label="Show in folder">
        <button
          type="button"
          className="reveal-btn"
          onClick={(e) => revealItem(item.id, e)}
          aria-label="Show in folder"
        >
          ⌕
        </button>
      </ActionTooltip>
      <ActionTooltip label="Save screenshot">
        <button
          type="button"
          className="screenshot-btn"
          onClick={(e) => screenshotItem(item.id, e)}
          aria-label="Save screenshot"
        >
          ⧉
        </button>
      </ActionTooltip>
      {item.type === "video" && (
        <ActionTooltip label={audioLabel}>
          <button
            type="button"
            className="audio-btn"
            onClick={(e) => toggleAudioPlayback(item.id, e)}
            aria-label={audioLabel}
            aria-pressed={isAudioActive}
          >
            ♪
          </button>
        </ActionTooltip>
      )}
      <ActionTooltip label="Delete">
        <button
          type="button"
          className="delete-btn"
          onClick={(e) => deleteItem(item.id, e)}
          aria-label="Delete"
        >
          ✕
        </button>
      </ActionTooltip>
    </TooltipProvider>
  );
}
