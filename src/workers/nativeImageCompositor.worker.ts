import type {
  NativeImageManifest,
  NativeImageManifestAsset,
} from "../components/native-image/types";

type InitMessage = {
  type: "init";
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  devicePixelRatio: number;
};

type WorkerMessage =
  | InitMessage
  | {
      type: "resize";
      width: number;
      height: number;
      devicePixelRatio: number;
    }
  | {
      type: "layout";
      manifest: NativeImageManifest;
    };

type CachedBitmap = {
  id: string;
  path: string;
  url: string;
  bitmap: ImageBitmap | null;
  byteSize: number;
  status: "loading" | "ready" | "error";
  version: number;
};

const MAX_ACTIVE_IMAGES = 24;
const MAX_CACHE_BYTES = 192 * 1024 * 1024;
const MAX_CONCURRENT_LOADS = 3;

let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let canvasWidth = 1;
let canvasHeight = 1;
let devicePixelRatio = 1;
let manifest: NativeImageManifest = {
  canvasWidth: 1,
  canvasHeight: 1,
  viewportZoom: 1,
  assets: [],
};
const cache = new Map<string, CachedBitmap>();
const pendingLoads = new Map<string, NativeImageManifestAsset>();
let inflightLoads = 0;
let renderScheduled = false;

const getNativeImagePriorityScore = (
  asset: Pick<
    NativeImageManifestAsset,
    "visibleAreaPx" | "focusWeight" | "centerWeight"
  >,
) => asset.visibleAreaPx * asset.focusWeight * (0.5 + asset.centerWeight);

const sortByPriority = (assets: NativeImageManifestAsset[]) =>
  [...assets].sort((left, right) => {
    const scoreDelta =
      getNativeImagePriorityScore(right) - getNativeImagePriorityScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    return right.drawOrder - left.drawOrder;
  });

const getDesiredAssets = () => {
  const desired: NativeImageManifestAsset[] = [];
  let estimatedBytes = 0;

  for (const asset of sortByPriority(manifest.assets)) {
    if (desired.length >= MAX_ACTIVE_IMAGES) break;

    const predictedBytes =
      Math.max(1, Math.round(asset.renderedWidthPx)) *
      Math.max(1, Math.round(asset.renderedHeightPx)) *
      4;

    if (
      desired.length > 0 &&
      estimatedBytes + predictedBytes > MAX_CACHE_BYTES
    ) {
      continue;
    }

    desired.push(asset);
    estimatedBytes += predictedBytes;
  }

  return desired;
};

const resizeCanvas = () => {
  if (!canvas || !context) return;

  canvas.width = Math.max(1, Math.round(canvasWidth * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(canvasHeight * devicePixelRatio));
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
};

const releaseEntry = (entry: CachedBitmap) => {
  entry.bitmap?.close();
  entry.bitmap = null;
};

const scheduleRender = () => {
  if (renderScheduled) return;
  renderScheduled = true;
  queueMicrotask(() => {
    renderScheduled = false;
    render();
  });
};

const enforceCacheBudget = (desiredIds: Set<string>) => {
  let totalBytes = 0;
  const disposable: CachedBitmap[] = [];

  for (const entry of cache.values()) {
    totalBytes += entry.byteSize;
    if (!desiredIds.has(entry.id)) {
      disposable.push(entry);
    }
  }

  if (totalBytes <= MAX_CACHE_BYTES) return;

  disposable.sort((left, right) => left.byteSize - right.byteSize);
  for (const entry of disposable) {
    if (totalBytes <= MAX_CACHE_BYTES) break;
    releaseEntry(entry);
    cache.delete(entry.id);
    totalBytes -= entry.byteSize;
  }
};

const processLoadQueue = () => {
  while (inflightLoads < MAX_CONCURRENT_LOADS) {
    const desiredAssets = sortByPriority(Array.from(pendingLoads.values()));
    const nextAsset = desiredAssets[0];
    if (!nextAsset) return;

    pendingLoads.delete(nextAsset.id);
    inflightLoads += 1;
    void loadAsset(nextAsset).finally(() => {
      inflightLoads = Math.max(0, inflightLoads - 1);
      processLoadQueue();
    });
  }
};

const reconcileResources = () => {
  const desiredAssets = getDesiredAssets();
  const desiredIds = new Set(desiredAssets.map((asset) => asset.id));
  const desiredById = new Map(desiredAssets.map((asset) => [asset.id, asset]));

  for (const [id, pending] of pendingLoads) {
    const desiredAsset = desiredById.get(id);
    if (!desiredAsset || desiredAsset.path !== pending.path) {
      pendingLoads.delete(id);
    }
  }

  for (const [id, entry] of cache) {
    const desiredAsset = desiredById.get(id);
    if (!desiredAsset || desiredAsset.path !== entry.path) {
      releaseEntry(entry);
      cache.delete(id);
    }
  }

  for (const asset of desiredAssets) {
    const existing = cache.get(asset.id);
    if (existing?.path === asset.path && existing.status !== "error") {
      continue;
    }

    pendingLoads.set(asset.id, asset);
  }

  enforceCacheBudget(desiredIds);
  processLoadQueue();
};

async function loadAsset(asset: NativeImageManifestAsset) {
  const previous = cache.get(asset.id);
  const version = (previous?.version ?? 0) + 1;
  if (previous) {
    releaseEntry(previous);
  }

  cache.set(asset.id, {
    id: asset.id,
    path: asset.path,
    url: asset.url,
    bitmap: null,
    byteSize: 0,
    status: "loading",
    version,
  });

  try {
    const response = await fetch(asset.url);
    if (!response.ok) {
      throw new Error(`image fetch failed: ${response.status}`);
    }

    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const current = cache.get(asset.id);
    if (
      !current ||
      current.version !== version ||
      current.path !== asset.path
    ) {
      bitmap.close();
      return;
    }

    current.bitmap = bitmap;
    current.byteSize = bitmap.width * bitmap.height * 4;
    current.status = "ready";
    self.postMessage({ type: "asset-ready", itemId: asset.id, path: asset.path });
    scheduleRender();
  } catch {
    const current = cache.get(asset.id);
    if (current && current.version === version) {
      current.status = "error";
    }
  }
}

function render() {
  if (!context) return;

  context.clearRect(0, 0, canvasWidth, canvasHeight);

  for (const asset of manifest.assets) {
    const entry = cache.get(asset.id);
    const bitmap = entry?.bitmap;
    if (!bitmap || entry?.status !== "ready") continue;

    const sourceX = Math.max(
      0,
      Math.min(bitmap.width - 1, bitmap.width * asset.cropLeftRatio),
    );
    const sourceY = Math.max(
      0,
      Math.min(bitmap.height - 1, bitmap.height * asset.cropTopRatio),
    );
    const sourceWidth = Math.max(
      1,
      Math.min(bitmap.width - sourceX, bitmap.width * asset.cropWidthRatio),
    );
    const sourceHeight = Math.max(
      1,
      Math.min(bitmap.height - sourceY, bitmap.height * asset.cropHeightRatio),
    );

    context.drawImage(
      bitmap,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      asset.screenX,
      asset.screenY,
      asset.renderedWidthPx,
      asset.renderedHeightPx,
    );
  }
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  if (message.type === "init") {
    try {
      canvas = message.canvas;
      context = canvas.getContext("2d", {
        alpha: true,
        desynchronized: true,
      });

      if (!context) {
        throw new Error("2d context unavailable");
      }

      canvasWidth = Math.max(1, Math.round(message.width));
      canvasHeight = Math.max(1, Math.round(message.height));
      devicePixelRatio = Math.max(1, message.devicePixelRatio || 1);
      resizeCanvas();
      render();
      self.postMessage({ type: "ready" });
    } catch (error) {
      self.postMessage({
        type: "error",
        reason: error instanceof Error ? error.message : "init failed",
      });
    }
    return;
  }

  if (message.type === "resize") {
    canvasWidth = Math.max(1, Math.round(message.width));
    canvasHeight = Math.max(1, Math.round(message.height));
    devicePixelRatio = Math.max(1, message.devicePixelRatio || 1);
    resizeCanvas();
    scheduleRender();
    return;
  }

  manifest = message.manifest;
  reconcileResources();
  scheduleRender();
};
