import { MediaItem } from "../InfiniteCanvas";

function MediaFrameActions({
  item,
  resetSize,
  deleteItem,
  startCropEdit,
  isCropEditing
}: {
  item: MediaItem;
  resetSize: (id: string, e: React.MouseEvent) => void;
  deleteItem: (id: string, e: React.MouseEvent) => void;
  startCropEdit: (id: string, e: React.MouseEvent) => void;
  isCropEditing: boolean;
}) {
  return (
    <>
      {item.type === "image" && (
        <button
          className="crop-btn"
          onClick={(e) => startCropEdit(item.id, e)}
          title="Crop"
          aria-pressed={isCropEditing}
        >
          C
        </button>
      )}
      <button
        className="reset-btn"
        onClick={(e) => resetSize(item.id, e)}
        title="Reset Size"
      >
        ⤡
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
