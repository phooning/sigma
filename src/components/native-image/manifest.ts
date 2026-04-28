import { convertFileSrc } from "@tauri-apps/api/core";
import { getCropRatios } from "../../utils/media";
import type { MediaItem } from "../../utils/media.types";
import { getCenterWeight, projectItemToScreen } from "../../utils/spatial";
import { getImageLod } from "../../utils/videoUtils";
import type {
  BuildNativeImageManifestOptions,
  BuildNativeImageManifestResult,
  NativeImageManifestAsset,
  NativeImagePreviewRequest,
} from "./types";

const ACTIVE_IMAGE_Z_INDEX = 10_000;
const IMAGE_PLACEHOLDER_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%231f2937'/%3E%3C/svg%3E";

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
  const fallbackUrl =
    item.thumbnailUrl ?? item.lowResProxyUrl ?? IMAGE_PLACEHOLDER_URL;

  if (lod === "preview256") {
    if (!item.imagePreview256Path) {
      const path = item.imagePreview1024Path ?? fallbackUrl;
      return {
        lod,
        path,
        url: item.imagePreview1024Path ? convertFileSrc(path) : fallbackUrl,
      };
    }

    return {
      lod,
      path: item.imagePreview256Path,
      url: convertFileSrc(item.imagePreview256Path),
    };
  }

  if (lod === "preview1024") {
    if (!item.imagePreview1024Path) {
      const path = item.imagePreview256Path ?? fallbackUrl;
      return {
        lod,
        path,
        url: item.imagePreview256Path ? convertFileSrc(path) : fallbackUrl,
      };
    }

    return {
      lod,
      path: item.imagePreview1024Path,
      url: convertFileSrc(item.imagePreview1024Path),
    };
  }

  if (zoom < 1) {
    if (item.imagePreview1024Path) {
      return {
        lod,
        path: item.imagePreview1024Path,
        url: convertFileSrc(item.imagePreview1024Path),
      };
    }

    const path = item.imagePreview256Path ?? fallbackUrl;
    return {
      lod,
      path,
      url: item.imagePreview256Path ? convertFileSrc(path) : fallbackUrl,
    };
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

    const screenRect = projectItemToScreen(item, viewport, {
      width: canvasWidth,
      height: canvasHeight,
    });
    const visibleAreaPx = screenRect.visibleAreaPx;

    if (visibleAreaPx <= 0) return [];

    const source = getNativeImageSource(item, viewport.zoom);
    if (source.lod === "preview256" && !item.imagePreview256Path) {
      previewRequests.push({ item, maxDimension: 256 });
    } else if (
      (source.lod === "preview1024" || viewport.zoom < 1) &&
      !item.imagePreview1024Path
    ) {
      previewRequests.push({ item, maxDimension: 1024 });
    }

    const crop = getCropRatios(item);
    const centerWeight = getCenterWeight(screenRect, {
      width: canvasWidth,
      height: canvasHeight,
    });
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
        screenX: screenRect.x,
        screenY: screenRect.y,
        renderedWidthPx: screenRect.width,
        renderedHeightPx: screenRect.height,
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
