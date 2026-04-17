import { CROP_HANDLES } from "../utils/media";
import { CropInsets, MediaItem } from "../utils/media.types";

export function ImageActions({
  id,
  url,
  crop,
  item,
  editingCropItem,
  handleItemPointerDown,
}: {
  id: string;
  url: string;
  crop: CropInsets;
  item: MediaItem;
  editingCropItem: string | null;
  handleItemPointerDown: (id: string, e: React.PointerEvent) => void;
}) {
  return (
    <>
      <img
        className="media-content"
        src={url}
        alt="canvas item"
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        style={{
          left: -crop.left,
          top: -crop.top,
          width: item.width + crop.left + crop.right,
          height: item.height + crop.top + crop.bottom,
        }}
      />
      {editingCropItem === id && (
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
      )}
    </>
  );
}
