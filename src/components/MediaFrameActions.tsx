import { MediaItem } from "../InfiniteCanvas";

function MediaFrameActions({
  item,
  resetSize,
  deleteItem
}: {
  item: MediaItem;
  resetSize: (id: string, e: React.MouseEvent) => void;
  deleteItem: (id: string, e: React.MouseEvent) => void;
}) {
  return (
    <>
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
