import { memo, useState } from "react";
import { getCrop } from "../utils/media";
import { getImageLod } from "../utils/videoUtils";
import type { CanvasMediaItemProps } from "./CanvasMediaItem.types";
import { ImageActions } from "./ImageActions";
import { CropOverlay, MediaFrameActions } from "./MediaFrameActions";
import { isNativeImageSourceReady } from "./native-image/manifest";
import { useViewportEntrance } from "./useViewportEntrance";
import { VideoMedia } from "./Video";

const CULL_MARGIN = 500;
const MEDIA_ITEM_BASE_TRANSITION = "box-shadow var(--duration-medium) ease";
const MEDIA_MASK_TRANSITION =
  "opacity 0.4s cubic-bezier(0.25, 0.1, 0.25, 1), " +
  "backdrop-filter 0.4s cubic-bezier(0.25, 0.1, 0.25, 1), " +
  "-webkit-backdrop-filter 0.4s cubic-bezier(0.25, 0.1, 0.25, 1)";

const getViewportState = ({
  item,
  isActiveAudioItem,
  viewBounds,
}: Pick<CanvasMediaItemProps, "item" | "isActiveAudioItem" | "viewBounds">) => {
  const itemLeft = item.x;
  const itemTop = item.y;
  const itemRight = item.x + item.width;
  const itemBottom = item.y + item.height;
  const { viewLeft, viewTop, viewRight, viewBottom } = viewBounds;

  const isCulled =
    itemRight < viewLeft - CULL_MARGIN ||
    itemLeft > viewRight + CULL_MARGIN ||
    itemBottom < viewTop - CULL_MARGIN ||
    itemTop > viewBottom + CULL_MARGIN;
  const isVisuallyInViewport =
    itemRight >= viewLeft &&
    itemLeft <= viewRight &&
    itemBottom >= viewTop &&
    itemTop <= viewBottom;

  return {
    isCulled,
    isInViewport: isVisuallyInViewport || isActiveAudioItem,
  };
};

const areCanvasMediaItemPropsEqual = (
  prevProps: CanvasMediaItemProps,
  nextProps: CanvasMediaItemProps,
) => {
  if (prevProps.item !== nextProps.item) return false;
  if (prevProps.isActiveAudioItem !== nextProps.isActiveAudioItem) return false;
  if (prevProps.isCropping !== nextProps.isCropping) return false;
  if (prevProps.isCropEditing !== nextProps.isCropEditing) return false;
  if (prevProps.isDragging !== nextProps.isDragging) return false;
  if (prevProps.useNativeImageSurface !== nextProps.useNativeImageSurface) {
    return false;
  }
  if (prevProps.nativeImageReadyPath !== nextProps.nativeImageReadyPath) {
    return false;
  }
  if (prevProps.isResizing !== nextProps.isResizing) return false;
  if (prevProps.isSelected !== nextProps.isSelected) return false;

  if (prevProps.item.type === "video" && prevProps.zoom !== nextProps.zoom) {
    return false;
  }

  if (
    prevProps.item.type === "image" &&
    getImageLod(prevProps.zoom, prevProps.item) !==
      getImageLod(nextProps.zoom, nextProps.item)
  ) {
    return false;
  }

  const prevViewportState = getViewportState(prevProps);
  const nextViewportState = getViewportState(nextProps);

  return (
    prevViewportState.isCulled === nextViewportState.isCulled &&
    prevViewportState.isInViewport === nextViewportState.isInViewport
  );
};

export const CanvasMediaItem = memo(function CanvasMediaItem({
  deleteItem,
  handleItemPointerDown,
  handleItemPointerMove,
  handleItemPointerUp,
  item,
  isActiveAudioItem,
  isCropping,
  isCropEditing,
  isDragging,
  nativeImageReadyPath,
  useNativeImageSurface,
  isResizing,
  isSelected,
  requestImagePreview,
  requestThumbnail,
  resetSize,
  revealItem,
  screenshotItem,
  startCropEdit,
  toggleAudioPlayback,
  viewBounds,
  zoom,
}: CanvasMediaItemProps) {
  const { id, url } = item;
  const crop = getCrop(item);
  const { isCulled, isInViewport } = getViewportState({
    item,
    isActiveAudioItem,
    viewBounds,
  });

  const [isMediaReady, setIsMediaReady] = useState(false);

  const isTransforming = isDragging || isResizing || isCropping;
  const shouldUseDomImage =
    item.type === "image" &&
    (!useNativeImageSurface || isTransforming || isCropEditing);

  const nativeImageReady =
    item.type === "image" &&
    !shouldUseDomImage &&
    isNativeImageSourceReady(item, zoom, nativeImageReadyPath);

  const isVisible = useViewportEntrance(
    isInViewport,
    isTransforming || nativeImageReady || isMediaReady,
    isTransforming,
  );

  if (isCulled && !isActiveAudioItem) {
    return null;
  }

  const zIndex = isTransforming || isCropEditing || isSelected ? 100 : 1;

  return (
    <div
      data-media-id={id}
      className={[
        "media-item",
        isSelected && "selected",
        isCropEditing && "crop-editing",
        item.type === "image" && useNativeImageSurface && "native-image-item",
        isTransforming && "is-transforming",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        left: item.x,
        top: item.y,
        width: item.width,
        height: item.height,
        zIndex,
        transition: MEDIA_ITEM_BASE_TRANSITION,
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
          crop={crop}
          item={item}
          isCropEditing={isCropEditing}
          isDragging={isDragging}
          isCropping={isCropping}
          isResizing={isResizing}
          useNativeImageSurface={useNativeImageSurface}
          handleItemPointerDown={handleItemPointerDown}
          requestImagePreview={requestImagePreview}
          onReadyChange={setIsMediaReady}
          zoom={zoom}
        />
      ) : (
        <>
          <VideoMedia
            url={url}
            crop={crop}
            item={item}
            isInViewport={isInViewport}
            zoom={zoom}
            onReadyChange={setIsMediaReady}
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
        aria-hidden="true"
        className="media-visibility-mask"
        data-visible={isVisible}
        style={{
          opacity: isVisible ? 0 : 1,
          backdropFilter: isVisible ? "blur(0px)" : "blur(12px)",
          WebkitBackdropFilter: isVisible ? "blur(0px)" : "blur(12px)",
          transition: isTransforming ? "none" : MEDIA_MASK_TRANSITION,
        }}
      />
      <div
        className="resize-handle"
        onPointerDown={(e) => handleItemPointerDown(id, e)}
      />
    </div>
  );
}, areCanvasMediaItemPropsEqual);
