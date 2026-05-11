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
  sourcePath: string;
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

export type NativeVideoFrontendMetrics = {
  renderer: string;
  canvasWidth: number;
  canvasHeight: number;
  uploadLatencyP95Ms: number;
  compositeLatencyP95Ms: number;
  renderThreadTimeP95Ms: number;
  gpuFrameTimeP95Ms: number | null;
  swapPresentTimeP95Ms: number;
  frameDropRate: number;
  framesQueued: number;
  framesDropped: number;
  framesMissedVsync: number;
  webviewJsFrameTimeMs: number | null;
  ipcRoundtripTimeMs: number | null;
  measuredIpcBytesPerSec: number;
};

export type NativeVideoTelemetrySnapshot = {
  rustBackendFrameUpdateTimeMs: number | null;
  webviewJsFrameTimeMs: number | null;
  ipcRoundtripTimeMs: number | null;
  serializationDeserializationTimeMs: number | null;
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
