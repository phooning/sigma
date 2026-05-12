import { useEffect, useRef } from "react";
import {
  CROP_HANDLES,
  clamp,
  getCropBoxStyle,
  MIN_MEDIA_SIZE,
} from "../utils/media";
import type { CropHandle, CropInsets, MediaItem } from "../utils/media.types";
import { getImageLod, type ImageLod } from "../utils/videoUtils";

export type TCropStart = {
  x: number;
  y: number;
  width: number;
  height: number;
  crop: CropInsets;
};

export type TResizeStart = Map<
  string,
  { width: number; height: number; crop: CropInsets }
>;

const IMAGE_PLACEHOLDER_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%231f2937'/%3E%3C/svg%3E";

export const handleImageResize = ({
  dx,
  dy,
  prev,
  resizeStart,
  isHoldingShift,
}: {
  dx: number;
  dy: number;
  prev: MediaItem[];
  resizeStart: TResizeStart | null;
  isHoldingShift: boolean;
}) =>
  prev.map((item) => {
    const startSize = resizeStart?.get(item.id);
    if (!startSize) return item;

    const width = Math.max(MIN_MEDIA_SIZE, startSize.width + dx);
    const height = Math.max(MIN_MEDIA_SIZE, startSize.height + dy);
    const widthScale = width / startSize.width;
    const heightScale = height / startSize.height;

    if (isHoldingShift) {
      const dominantScale =
        Math.abs(widthScale - 1) > Math.abs(heightScale - 1)
          ? widthScale
          : heightScale;
      const minScale = Math.max(
        MIN_MEDIA_SIZE / startSize.width,
        MIN_MEDIA_SIZE / startSize.height,
      );
      const scale = Math.max(dominantScale, minScale);

      return {
        ...item,
        width: startSize.width * scale,
        height: startSize.height * scale,
        crop: {
          top: startSize.crop.top * scale,
          right: startSize.crop.right * scale,
          bottom: startSize.crop.bottom * scale,
          left: startSize.crop.left * scale,
        },
      };
    }

    const cropBoxWidth =
      startSize.width + startSize.crop.left + startSize.crop.right;
    const cropBoxHeight =
      startSize.height + startSize.crop.top + startSize.crop.bottom;
    const visibleCropBoxWidth = cropBoxWidth - startSize.crop.left;
    const visibleCropBoxHeight = cropBoxHeight - startSize.crop.top;
    const scale = Math.max(
      width / visibleCropBoxWidth,
      height / visibleCropBoxHeight,
      MIN_MEDIA_SIZE / visibleCropBoxWidth,
      MIN_MEDIA_SIZE / visibleCropBoxHeight,
    );
    const cropLeft = startSize.crop.left * scale;
    const cropTop = startSize.crop.top * scale;

    return {
      ...item,
      width,
      height,
      crop: {
        top: cropTop,
        right: Math.max(0, cropBoxWidth * scale - cropLeft - width),
        bottom: Math.max(0, cropBoxHeight * scale - cropTop - height),
        left: cropLeft,
      },
    };
  });

export const handleImageCrop = ({
  id,
  dx,
  dy,
  prev,
  cropStart,
  cropHandle,
}: {
  id: string;
  dx: number;
  dy: number;
  prev: MediaItem[];
  cropStart: TCropStart;
  cropHandle: CropHandle;
}) =>
  prev.map((item) => {
    if (item.id !== id) return item;

    let { x, y, width, height } = cropStart;
    const crop = { ...cropStart.crop };

    if (cropHandle.includes("w")) {
      const leftDelta = clamp(
        dx,
        -cropStart.crop.left,
        cropStart.width - MIN_MEDIA_SIZE,
      );
      x = cropStart.x + leftDelta;
      width = cropStart.width - leftDelta;
      crop.left = cropStart.crop.left + leftDelta;
    }

    if (cropHandle.includes("e")) {
      const rightDelta = clamp(
        dx,
        MIN_MEDIA_SIZE - cropStart.width,
        cropStart.crop.right,
      );
      width = cropStart.width + rightDelta;
      crop.right = cropStart.crop.right - rightDelta;
    }

    if (cropHandle.includes("n")) {
      const topDelta = clamp(
        dy,
        -cropStart.crop.top,
        cropStart.height - MIN_MEDIA_SIZE,
      );
      y = cropStart.y + topDelta;
      height = cropStart.height - topDelta;
      crop.top = cropStart.crop.top + topDelta;
    }

    if (cropHandle.includes("s")) {
      const bottomDelta = clamp(
        dy,
        MIN_MEDIA_SIZE - cropStart.height,
        cropStart.crop.bottom,
      );
      height = cropStart.height + bottomDelta;
      crop.bottom = cropStart.crop.bottom - bottomDelta;
    }

    return { ...item, x, y, width, height, crop };
  });

const getImagePreviewUrl = (
  item: MediaItem,
  lod: ImageLod,
  preferPreview = false,
) => {
  const fallbackUrl =
    item.thumbnailUrl ?? item.lowResProxyUrl ?? IMAGE_PLACEHOLDER_URL;

  if (preferPreview) {
    return item.imagePreview1024Url ?? item.imagePreview256Url ?? fallbackUrl;
  }

  if (lod === "preview256") {
    return item.imagePreview256Url ?? item.imagePreview1024Url ?? fallbackUrl;
  }

  if (lod === "preview1024") {
    return item.imagePreview1024Url ?? item.imagePreview256Url ?? fallbackUrl;
  }

  return item.url;
};

export const resetImageSize = (e: React.MouseEvent, item?: MediaItem) => {
  e.stopPropagation();

  if (
    item?.type === "image" &&
    typeof item.sourceWidth === "number" &&
    typeof item.sourceHeight === "number"
  ) {
    return {
      intrinsicWidth: item.sourceWidth,
      intrinsicHeight: item.sourceHeight,
    };
  }

  const target = e.currentTarget as HTMLElement;
  const mediaEl = target.parentElement?.querySelector("img, video") as
    | HTMLImageElement
    | HTMLVideoElement;

  if (mediaEl) {
    let intrinsicWidth = 400;
    let intrinsicHeight = 300;

    if (mediaEl.tagName === "IMG") {
      intrinsicWidth = (mediaEl as HTMLImageElement).naturalWidth;
      intrinsicHeight = (mediaEl as HTMLImageElement).naturalHeight;
    } else if (mediaEl.tagName === "VIDEO") {
      intrinsicWidth = (mediaEl as HTMLVideoElement).videoWidth;
      intrinsicHeight = (mediaEl as HTMLVideoElement).videoHeight;
    }
    return { intrinsicWidth, intrinsicHeight };
  }
};

export function ImageActions({
  id,
  crop,
  item,
  isCropEditing,
  mountDomImage,
  showDomImage,
  preferPreviewForNativeHandoff,
  handleItemPointerDown,
  requestImagePreview,
  onReadyChange,
  zoom,
}: {
  id: string;
  crop: CropInsets;
  item: MediaItem;
  isCropEditing: boolean;
  mountDomImage: boolean;
  showDomImage: boolean;
  preferPreviewForNativeHandoff: boolean;
  handleItemPointerDown: (id: string, e: React.PointerEvent) => void;
  requestImagePreview: (item: MediaItem, maxDimension: 256 | 1024) => void;
  onReadyChange?: (isReady: boolean) => void;
  zoom: number;
}) {
  const lod = getImageLod(zoom, item);
  const displayUrl = getImagePreviewUrl(
    item,
    lod,
    preferPreviewForNativeHandoff,
  );
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (!mountDomImage) return;

    if (preferPreviewForNativeHandoff) {
      requestImagePreview(item, 1024);
    } else if (lod === "preview256") {
      requestImagePreview(item, 256);
    } else if (lod === "preview1024") {
      requestImagePreview(item, 1024);
    }
  }, [
    item,
    lod,
    mountDomImage,
    preferPreviewForNativeHandoff,
    requestImagePreview,
  ]);

  useEffect(() => {
    if (!mountDomImage) {
      onReadyChange?.(false);
      return;
    }

    const image = imageRef.current;
    onReadyChange?.(Boolean(image?.complete && image.naturalWidth > 0));
  }, [mountDomImage, onReadyChange]);

  return (
    <>
      {!mountDomImage ? null : (
        <div
          className="media-crop-box"
          aria-hidden={!showDomImage}
          style={{
            ...getCropBoxStyle(item, crop),
            opacity: showDomImage ? 1 : 0,
          }}
        >
          <img
            ref={imageRef}
            className={[
              "media-content",
              lod === "full" && !preferPreviewForNativeHandoff
                ? "image-lod-full"
                : "image-lod-preview",
            ].join(" ")}
            src={displayUrl}
            alt="canvas item"
            draggable={false}
            onLoad={() => onReadyChange?.(true)}
            onError={() => onReadyChange?.(false)}
            onDragStart={(e) => e.preventDefault()}
          />
        </div>
      )}
      {isCropEditing && (
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
