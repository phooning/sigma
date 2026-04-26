import type { MediaItem, Viewport } from "../../utils/media.types";

export type NativeVideoManifest = {
  canvasWidth: number;
  canvasHeight: number;
  viewportZoom: number;
  assets: NativeVisibleAsset[];
};

export type NativeVisibleAsset = {
  id: string;
  path: string;
  sourceWidth: number;
  sourceHeight: number;
  screenX: number;
  screenY: number;
  renderedWidthPx: number;
  renderedHeightPx: number;
  visibleAreaPx: number;
  focusWeight: number;
  centerWeight: number;
  targetFps: number;
};

export type NativeVideoGeometryBounds = Pick<
  NativeVisibleAsset,
  | "screenX"
  | "screenY"
  | "renderedWidthPx"
  | "renderedHeightPx"
  | "visibleAreaPx"
>;

export type NativeVideoProfile = {
  baseCaseValidated: boolean;
  safeBudgetBytesPerSec: number;
};

export type NativeVideoAllocation = {
  assetId: string;
  streamId: number;
  state: "active" | "suspended" | "thumbnail";
  decodeWidth: number;
  decodeHeight: number;
  fps: number;
};

export type NativeControllerSnapshot = {
  profile: NativeVideoProfile;
  allocations: NativeVideoAllocation[];
};

export type NativeVideoSurfaceProps = {
  items: MediaItem[];
  viewport: Viewport;
  canvasSize: {
    width: number;
    height: number;
  };
  selectedItems: Set<string>;
  activeAudioItemId: string | null;
};
