import { MediaItem } from "../utils/media.types";

function MediaFrameActions({
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

export { MediaFrameActions };
