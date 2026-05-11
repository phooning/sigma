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
      type: "settings";
      resourcePolicy: Partial<NativeImageResourcePolicy> | null;
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
  priorityScore: number;
  lastUsedAt: number;
  status: "loading" | "ready" | "error";
  version: number;
};

const BASE_ACTIVE_IMAGES = 24;
const BASE_CACHE_BYTES = 192 * 1024 * 1024;
const BASE_CONCURRENT_LOADS = 3;
const BYTES_PER_PIXEL = 4;
const BASE_DISPLAY_MEGAPIXELS = 1920 * 1080;

type NativeImagePolicyInput = {
  canvasWidth: number;
  canvasHeight: number;
  devicePixelRatio: number;
  deviceMemoryGb?: number;
  hardwareConcurrency?: number;
};

type WorkerNavigator = Navigator & {
  deviceMemory?: number;
};

export type NativeImageResourcePolicy = {
  maxActiveImages: number;
  maxCacheBytes: number;
  maxConcurrentLoads: number;
};

type NativeImageAssetSelectionInput = {
  assets: NativeImageManifestAsset[];
  policy: Pick<NativeImageResourcePolicy, "maxActiveImages" | "maxCacheBytes">;
  devicePixelRatio: number;
};

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
let resourcePolicyOverride: Partial<NativeImageResourcePolicy> | null = null;
let cacheAccessClock = 0;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const getDeviceMemoryGb = () => {
  const deviceMemory = (navigator as WorkerNavigator).deviceMemory;
  return typeof deviceMemory === "number" && Number.isFinite(deviceMemory)
    ? deviceMemory
    : undefined;
};

export const getNativeImageResourcePolicy = ({
  canvasWidth,
  canvasHeight,
  devicePixelRatio,
  deviceMemoryGb = getDeviceMemoryGb(),
  hardwareConcurrency = navigator.hardwareConcurrency,
}: NativeImagePolicyInput): NativeImageResourcePolicy => {
  const displayPixels =
    Math.max(1, canvasWidth) *
    Math.max(1, canvasHeight) *
    Math.max(1, devicePixelRatio) ** 2;
  const displayScale = Math.max(1, displayPixels / BASE_DISPLAY_MEGAPIXELS);
  const memoryScale =
    typeof deviceMemoryGb === "number" && Number.isFinite(deviceMemoryGb)
      ? clamp(deviceMemoryGb / 8, 0.75, 4)
      : 1;
  const cpuScale =
    typeof hardwareConcurrency === "number" &&
    Number.isFinite(hardwareConcurrency)
      ? clamp(hardwareConcurrency / 8, 0.75, 2)
      : 1;

  return {
    maxActiveImages: Math.round(
      clamp(
        BASE_ACTIVE_IMAGES * Math.sqrt(displayScale) * Math.sqrt(memoryScale),
        BASE_ACTIVE_IMAGES,
        96,
      ),
    ),
    maxCacheBytes: Math.round(
      clamp(
        BASE_CACHE_BYTES * displayScale * memoryScale,
        BASE_CACHE_BYTES,
        1536 * 1024 * 1024,
      ),
    ),
    maxConcurrentLoads: Math.round(
      clamp(
        BASE_CONCURRENT_LOADS * Math.sqrt(cpuScale) * Math.sqrt(memoryScale),
        2,
        8,
      ),
    ),
  };
};

const getCurrentPolicy = () =>
  applyResourcePolicyOverride(
    getNativeImageResourcePolicy({
      canvasWidth,
      canvasHeight,
      devicePixelRatio,
    }),
  );

const applyResourcePolicyOverride = (
  policy: NativeImageResourcePolicy,
): NativeImageResourcePolicy => ({
  maxActiveImages: resourcePolicyOverride?.maxActiveImages
    ? Math.round(clamp(resourcePolicyOverride.maxActiveImages, 1, 512))
    : policy.maxActiveImages,
  maxCacheBytes: resourcePolicyOverride?.maxCacheBytes
    ? Math.round(
        clamp(
          resourcePolicyOverride.maxCacheBytes,
          16 * 1024 * 1024,
          4096 * 1024 * 1024,
        ),
      )
    : policy.maxCacheBytes,
  maxConcurrentLoads: resourcePolicyOverride?.maxConcurrentLoads
    ? Math.round(clamp(resourcePolicyOverride.maxConcurrentLoads, 1, 16))
    : policy.maxConcurrentLoads,
});

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

export const compareNativeImageCacheEvictionCandidates = (
  left: Pick<CachedBitmap, "byteSize" | "lastUsedAt" | "priorityScore">,
  right: Pick<CachedBitmap, "byteSize" | "lastUsedAt" | "priorityScore">,
) => {
  const priorityDelta = left.priorityScore - right.priorityScore;
  if (priorityDelta !== 0) return priorityDelta;

  const recencyDelta = left.lastUsedAt - right.lastUsedAt;
  if (recencyDelta !== 0) return recencyDelta;

  return right.byteSize - left.byteSize;
};

const estimatedAssetBytes = (
  asset: NativeImageManifestAsset,
  pixelRatio: number,
) => {
  const renderedPixels =
    Math.max(1, Math.round(asset.renderedWidthPx * pixelRatio)) *
    Math.max(1, Math.round(asset.renderedHeightPx * pixelRatio));
  const sourcePixels =
    Math.max(1, asset.sourceWidth) * Math.max(1, asset.sourceHeight);
  return Math.min(sourcePixels, renderedPixels) * BYTES_PER_PIXEL;
};

export const selectDesiredNativeImageAssets = ({
  assets,
  policy,
  devicePixelRatio,
}: NativeImageAssetSelectionInput) => {
  const desired: NativeImageManifestAsset[] = [];
  const desiredIds = new Set<string>();
  let estimatedBytes = 0;
  const protectedAssets = sortByPriority(
    assets.filter((asset) => asset.isSelected),
  );
  const candidateAssets = sortByPriority(
    assets.filter((asset) => !asset.isSelected),
  );

  for (const asset of protectedAssets) {
    if (desiredIds.has(asset.id)) continue;
    desired.push(asset);
    desiredIds.add(asset.id);
    estimatedBytes += estimatedAssetBytes(asset, devicePixelRatio);
  }

  for (const asset of candidateAssets) {
    if (desired.length >= policy.maxActiveImages) break;

    const predictedBytes = estimatedAssetBytes(asset, devicePixelRatio);
    if (
      desired.length > 0 &&
      estimatedBytes + predictedBytes > policy.maxCacheBytes
    ) {
      continue;
    }

    desired.push(asset);
    desiredIds.add(asset.id);
    estimatedBytes += predictedBytes;
  }

  return desired;
};

const getDesiredAssets = () =>
  selectDesiredNativeImageAssets({
    assets: manifest.assets,
    policy: getCurrentPolicy(),
    devicePixelRatio,
  });

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

const touchEntry = (
  entry: CachedBitmap,
  asset: Pick<
    NativeImageManifestAsset,
    "centerWeight" | "focusWeight" | "visibleAreaPx"
  >,
) => {
  entry.priorityScore = getNativeImagePriorityScore(asset);
  entry.lastUsedAt = ++cacheAccessClock;
};

const updateEntryPriority = (
  entry: CachedBitmap,
  asset: Pick<
    NativeImageManifestAsset,
    "centerWeight" | "focusWeight" | "visibleAreaPx"
  >,
) => {
  entry.priorityScore = getNativeImagePriorityScore(asset);
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
  const policy = getCurrentPolicy();
  let totalBytes = 0;
  const disposable: CachedBitmap[] = [];
  const protectedIds = new Set(
    manifest.assets
      .filter((asset) => asset.isSelected)
      .map((asset) => asset.id),
  );

  for (const entry of cache.values()) {
    totalBytes += entry.byteSize;
    if (!desiredIds.has(entry.id) && !protectedIds.has(entry.id)) {
      disposable.push(entry);
    }
  }

  if (totalBytes <= policy.maxCacheBytes) return;

  disposable.sort(compareNativeImageCacheEvictionCandidates);
  for (const entry of disposable) {
    if (totalBytes <= policy.maxCacheBytes) break;
    releaseEntry(entry);
    cache.delete(entry.id);
    totalBytes -= entry.byteSize;
  }
};

const processLoadQueue = () => {
  const policy = getCurrentPolicy();
  while (inflightLoads < policy.maxConcurrentLoads) {
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
  const manifestById = new Map(
    manifest.assets.map((asset) => [asset.id, asset]),
  );

  for (const [id, pending] of pendingLoads) {
    const desiredAsset = desiredById.get(id);
    if (!desiredAsset || desiredAsset.path !== pending.path) {
      pendingLoads.delete(id);
    }
  }

  for (const [id, entry] of cache) {
    const manifestAsset = manifestById.get(id);
    if (!manifestAsset || manifestAsset.path !== entry.path) {
      releaseEntry(entry);
      cache.delete(id);
      continue;
    }

    updateEntryPriority(entry, manifestAsset);

    if (desiredById.has(id)) {
      touchEntry(entry, manifestAsset);
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
    priorityScore: getNativeImagePriorityScore(asset),
    lastUsedAt: ++cacheAccessClock,
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
    self.postMessage({
      type: "asset-ready",
      itemId: asset.id,
      path: asset.path,
    });
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

  if (message.type === "settings") {
    resourcePolicyOverride = message.resourcePolicy;
    reconcileResources();
    scheduleRender();
    return;
  }

  manifest = message.manifest;
  reconcileResources();
  scheduleRender();
};
