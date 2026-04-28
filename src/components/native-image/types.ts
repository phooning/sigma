import type { MediaQueueOptions } from "../../utils/media";
import type { MediaItem, Viewport } from "../../utils/media.types";

export type NativeImageManifestAsset = {
  id: string;
  path: string;
  url: string;
  sourceWidth: number;
  sourceHeight: number;
  cropLeftRatio: number;
  cropTopRatio: number;
  cropWidthRatio: number;
  cropHeightRatio: number;
  drawOrder: number;
  screenX: number;
  screenY: number;
  renderedWidthPx: number;
  renderedHeightPx: number;
  visibleAreaPx: number;
  focusWeight: number;
  centerWeight: number;
};

export type NativeImageManifest = {
  canvasWidth: number;
  canvasHeight: number;
  viewportZoom: number;
  assets: NativeImageManifestAsset[];
};

export type NativeImagePreviewRequest = {
  item: MediaItem;
  maxDimension: 256 | 1024;
};

export type BuildNativeImageManifestOptions = {
  items: MediaItem[];
  viewport: Viewport;
  canvasSize: {
    width: number;
    height: number;
  };
  selectedItems: Set<string>;
  draggingItemId: string | null;
  resizingItemId: string | null;
  croppingItemId: string | null;
  editingCropItemId: string | null;
};

export type BuildNativeImageManifestResult = {
  manifest: NativeImageManifest;
  previewRequests: NativeImagePreviewRequest[];
};

export type NativeImageSurfaceProps = {
  items: MediaItem[];
  viewport: Viewport;
  canvasSize: {
    width: number;
    height: number;
  };
  selectedItems: Set<string>;
  draggingItemId: string | null;
  resizingItemId: string | null;
  croppingItemId: string | null;
  editingCropItemId: string | null;
  onReadyChange?: (isReady: boolean) => void;
  requestImagePreview: (
    item: MediaItem,
    maxDimension: 256 | 1024,
    options?: MediaQueueOptions,
  ) => void;
};
