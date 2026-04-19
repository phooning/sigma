import { getCrop } from "../utils/media";
import { ImageActions } from "./ImageActions";
import { CropOverlay, MediaFrameActions } from "./MediaFrameActions";
import { VideoMedia } from "./Video";
import type { CanvasMediaItemProps } from "./CanvasMediaItem.types";

const CULL_MARGIN = 500;

export function CanvasMediaItem({
  activeAudioItemId,
  croppingItem,
  deleteItem,
  draggingItem,
  editingCropItem,
  handleItemPointerDown,
  handleItemPointerMove,
  handleItemPointerUp,
  item,
  requestThumbnail,
  resetSize,
  resizingItem,
  revealItem,
  screenshotItem,
  selectedItems,
  startCropEdit,
  toggleAudioPlayback,
  viewBounds,
  viewport,
}: CanvasMediaItemProps) {
  const { id, url } = item;
  const crop = getCrop(item);
  const isCropEditing = editingCropItem === id;
  const isSelected = selectedItems.has(id);
  const itemLeft = item.x;
  const itemTop = item.y;
  const itemRight = item.x + item.width;
  const itemBottom = item.y + item.height;
  const isActiveAudioItem = activeAudioItemId === id;
  const { viewLeft, viewTop, viewRight, viewBottom } = viewBounds;

  const isCulled =
    itemRight < viewLeft - CULL_MARGIN ||
    itemLeft > viewRight + CULL_MARGIN ||
    itemBottom < viewTop - CULL_MARGIN ||
    itemTop > viewBottom + CULL_MARGIN;

  if (isCulled && !isActiveAudioItem) {
    return null;
  }

  const isVisuallyInViewport =
    itemRight >= viewLeft &&
    itemLeft <= viewRight &&
    itemBottom >= viewTop &&
    itemTop <= viewBottom;
  const isInViewport = isVisuallyInViewport || isActiveAudioItem;

  const zIndex =
    draggingItem === id ||
    resizingItem === id ||
    croppingItem === id ||
    isCropEditing ||
    isSelected
      ? 100
      : 1;

  return (
    <div
      data-media-id={id}
      className={[
        "media-item",
        isSelected && "selected",
        isCropEditing && "crop-editing",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        left: item.x,
        top: item.y,
        width: item.width,
        height: item.height,
        zIndex,
      }}
      onPointerDown={(e) => handleItemPointerDown(id, e)}
      onPointerMove={(e) => handleItemPointerMove(id, e)}
      onPointerUp={(e) => handleItemPointerUp(id, e)}
    >
      <MediaFrameActions
        item={item}
        revealItem={revealItem}
        screenshotItem={screenshotItem}
        resetSize={resetSize}
        deleteItem={deleteItem}
        startCropEdit={startCropEdit}
        toggleAudioPlayback={toggleAudioPlayback}
        isCropEditing={isCropEditing}
      />
      {item.type === "image" ? (
        <ImageActions
          id={id}
          url={url}
          crop={crop}
          item={item}
          editingCropItem={editingCropItem}
          handleItemPointerDown={handleItemPointerDown}
        />
      ) : (
        <>
          <VideoMedia
            url={url}
            crop={crop}
            item={item}
            isInViewport={isInViewport}
            zoom={viewport.zoom}
            onThumbnailNeeded={requestThumbnail}
          />
          {isCropEditing && (
            <CropOverlay
              id={id}
              handleItemPointerDown={handleItemPointerDown}
            />
          )}
        </>
      )}
      <div
        className="resize-handle"
        onPointerDown={(e) => handleItemPointerDown(id, e)}
      />
    </div>
  );
}
