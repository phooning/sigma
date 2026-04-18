import { CROP_HANDLES, EMPTY_CROP } from "../utils/media";
import { MediaItem } from "../utils/media.types";

export function CropOverlay({
  id,
  handleItemPointerDown,
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
  intrinsicHeight,
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
      : i,
  );
};

export function MediaFrameActions({
  item,
  revealItem,
  resetSize,
  deleteItem,
  startCropEdit,
  isCropEditing,
}: {
  item: MediaItem;
  revealItem: (id: string, e: React.MouseEvent) => void;
  resetSize: (id: string, e: React.MouseEvent) => void;
  deleteItem: (id: string, e: React.MouseEvent) => void;
  startCropEdit: (id: string, e: React.MouseEvent) => void;
  isCropEditing: boolean;
}) {
  return (
    <>
      <button
        className="crop-btn"
        onClick={(e) => startCropEdit(item.id, e)}
        title="Crop"
        aria-pressed={isCropEditing}
      >
        C
      </button>
      <button
        className="reset-btn"
        onClick={(e) => resetSize(item.id, e)}
        title="Reset Size"
      >
        ⤡
      </button>
      <button
        className="reveal-btn"
        onClick={(e) => revealItem(item.id, e)}
        title="Show in Folder"
      >
        ⌕
      </button>
      <button
        className="delete-btn"
        onClick={(e) => deleteItem(item.id, e)}
        title="Delete"
      >
        ✕
      </button>
    </>
  );
}
