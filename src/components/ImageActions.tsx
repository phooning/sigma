import { clamp, CROP_HANDLES, MIN_MEDIA_SIZE } from "../utils/media";
import { CropHandle, CropInsets, MediaItem } from "../utils/media.types";

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

    if (isHoldingShift) {
      const candidateWidth = Math.max(MIN_MEDIA_SIZE, startSize.width + dx);
      const candidateHeight = Math.max(MIN_MEDIA_SIZE, startSize.height + dy);
      const widthScale = candidateWidth / startSize.width;
      const heightScale = candidateHeight / startSize.height;
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

    const nextWidth = Math.max(MIN_MEDIA_SIZE, startSize.width + dx);
    const nextHeight = Math.max(MIN_MEDIA_SIZE, startSize.height + dy);
    const widthScale = nextWidth / startSize.width;
    const heightScale = nextHeight / startSize.height;

    return {
      ...item,
      width: nextWidth,
      height: nextHeight,
      crop: {
        top: startSize.crop.top * heightScale,
        right: startSize.crop.right * widthScale,
        bottom: startSize.crop.bottom * heightScale,
        left: startSize.crop.left * widthScale,
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

export const resetImageSize = (e: React.MouseEvent) => {
  e.stopPropagation();
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
