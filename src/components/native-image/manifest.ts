import { convertFileSrc } from "@tauri-apps/api/core";
import { getCropRatios } from "../../utils/media";
import type { MediaItem } from "../../utils/media.types";
import { getImageLod } from "../../utils/videoUtils";
import type {
  BuildNativeImageManifestOptions,
  BuildNativeImageManifestResult,
  NativeImageManifestAsset,
  NativeImagePreviewRequest,
} from "./types";

const ACTIVE_IMAGE_Z_INDEX = 10_000;

const isReactManagedImage = (
  item: MediaItem,
  {
    draggingItemId,
    resizingItemId,
    croppingItemId,
    editingCropItemId,
  }: Pick<
    BuildNativeImageManifestOptions,
    | "draggingItemId"
    | "resizingItemId"
    | "croppingItemId"
    | "editingCropItemId"
  >,
) =>
  item.id === draggingItemId ||
  item.id === resizingItemId ||
  item.id === croppingItemId ||
  item.id === editingCropItemId;

const getNativeImageSource = (item: MediaItem, zoom: number) => {
  const lod = getImageLod(zoom, item);

  if (lod === "preview256") {
    const path =
      item.imagePreview256Path ?? item.imagePreview1024Path ?? item.filePath;
    return { lod, path, url: convertFileSrc(path) };
  }

  if (lod === "preview1024") {
    const path =
      item.imagePreview1024Path ?? item.imagePreview256Path ?? item.filePath;
    return { lod, path, url: convertFileSrc(path) };
  }

  return { lod, path: item.filePath, url: item.url };
};

export const getNativeImagePriorityScore = (
  asset: Pick<
    NativeImageManifestAsset,
    "visibleAreaPx" | "focusWeight" | "centerWeight"
  >,
) => asset.visibleAreaPx * asset.focusWeight * (0.5 + asset.centerWeight);

export function buildNativeImageManifest({
  items,
  viewport,
  canvasSize,
  selectedItems,
  draggingItemId,
  resizingItemId,
  croppingItemId,
  editingCropItemId,
}: BuildNativeImageManifestOptions): BuildNativeImageManifestResult {
  const canvasWidth = Math.max(1, Math.round(canvasSize.width));
  const canvasHeight = Math.max(1, Math.round(canvasSize.height));
  const canvasCenterX = canvasWidth / 2;
  const canvasCenterY = canvasHeight / 2;
  const canvasDiagonal = Math.hypot(canvasWidth, canvasHeight) || 1;
  const previewRequests: NativeImagePreviewRequest[] = [];

  const assets = items.flatMap((item, index) => {
    if (item.type !== "image") return [];
    if (
      isReactManagedImage(item, {
        draggingItemId,
        resizingItemId,
        croppingItemId,
        editingCropItemId,
      })
    ) {
      return [];
    }

    const screenX = (item.x + viewport.x) * viewport.zoom;
    const screenY = (item.y + viewport.y) * viewport.zoom;
    const renderedWidthPx = item.width * viewport.zoom;
    const renderedHeightPx = item.height * viewport.zoom;
    const visibleLeft = Math.max(0, screenX);
    const visibleTop = Math.max(0, screenY);
    const visibleRight = Math.min(canvasWidth, screenX + renderedWidthPx);
    const visibleBottom = Math.min(canvasHeight, screenY + renderedHeightPx);
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const visibleAreaPx = visibleWidth * visibleHeight;

    if (visibleAreaPx <= 0) return [];

    const source = getNativeImageSource(item, viewport.zoom);
    if (source.lod === "preview256" && !item.imagePreview256Path) {
      previewRequests.push({ item, maxDimension: 256 });
    } else if (source.lod === "preview1024" && !item.imagePreview1024Path) {
      previewRequests.push({ item, maxDimension: 1024 });
    }

    const crop = getCropRatios(item);
    const itemCenterX = screenX + renderedWidthPx / 2;
    const itemCenterY = screenY + renderedHeightPx / 2;
    const centerDistance = Math.hypot(
      itemCenterX - canvasCenterX,
      itemCenterY - canvasCenterY,
    );
    const centerWeight = 1 - Math.min(1, centerDistance / canvasDiagonal);
    const isSelected = selectedItems.has(item.id);

    return [
      {
        id: item.id,
        path: source.path,
        url: source.url,
        sourceWidth: Math.max(1, Math.round(item.sourceWidth ?? item.width)),
        sourceHeight: Math.max(1, Math.round(item.sourceHeight ?? item.height)),
        cropLeftRatio: crop.x,
        cropTopRatio: crop.y,
        cropWidthRatio: crop.width,
        cropHeightRatio: crop.height,
        drawOrder: (isSelected ? ACTIVE_IMAGE_Z_INDEX : 0) + index,
        screenX,
        screenY,
        renderedWidthPx,
        renderedHeightPx,
        visibleAreaPx,
        focusWeight: isSelected ? 2.5 : 1,
        centerWeight,
      },
    ];
  });

  assets.sort((left, right) => left.drawOrder - right.drawOrder);

  return {
    manifest: {
      canvasWidth,
      canvasHeight,
      viewportZoom: viewport.zoom,
      assets,
    },
    previewRequests,
  };
}
