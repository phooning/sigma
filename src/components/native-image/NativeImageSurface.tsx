import { useEffect, useRef } from "react";
import { getViewBounds } from "../../utils/viewport";
import type { NativeImageResourcePolicy } from "../../workers/nativeImageCompositor.worker";
import { buildNativeImageManifest } from "./manifest";
import type { NativeImageSurfaceProps } from "./types";

const supportsNativeImageSurface = () =>
  typeof Worker !== "undefined" &&
  typeof createImageBitmap !== "undefined" &&
  typeof HTMLCanvasElement !== "undefined" &&
  "transferControlToOffscreen" in HTMLCanvasElement.prototype;

const signatureForPreviewRequests = (
  requests: Array<{ item: { id: string }; maxDimension: 256 | 1024 }>,
  viewportSignature: string,
) =>
  [
    viewportSignature,
    ...requests.map(({ item, maxDimension }) => `${item.id}:${maxDimension}`),
  ].join("|");

const signatureForViewport = ({
  x,
  y,
  zoom,
}: {
  x: number;
  y: number;
  zoom: number;
}) => `${x.toFixed(3)}:${y.toFixed(3)}:${zoom.toFixed(4)}`;

const readPositiveIntegerSetting = (key: string) => {
  const rawValue = window.localStorage.getItem(key);
  if (!rawValue) return undefined;
  const value = Number.parseInt(rawValue, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const readNativeImageResourcePolicySetting = () => {
  const maxCacheMb = readPositiveIntegerSetting("sigma.nativeImage.maxCacheMb");
  const resourcePolicy: Partial<NativeImageResourcePolicy> = {
    maxActiveImages: readPositiveIntegerSetting(
      "sigma.nativeImage.maxActiveImages",
    ),
    maxCacheBytes: maxCacheMb ? maxCacheMb * 1024 * 1024 : undefined,
    maxConcurrentLoads: readPositiveIntegerSetting(
      "sigma.nativeImage.maxConcurrentLoads",
    ),
  };
  return Object.values(resourcePolicy).some((value) => value !== undefined)
    ? resourcePolicy
    : null;
};

export function NativeImageSurface({
  items,
  viewport,
  canvasSize,
  selectedItems,
  draggingItemId,
  resizingItemId,
  croppingItemId,
  editingCropItemId,
  onReadyChange,
  onAssetReadyChange,
  requestImagePreview,
}: NativeImageSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const hasTransferredCanvasRef = useRef(false);
  const deferredCleanupRef = useRef<number | null>(null);
  const canvasSizeRef = useRef(canvasSize);
  const onReadyChangeRef = useRef(onReadyChange);
  const onAssetReadyChangeRef = useRef(onAssetReadyChange);
  const previewSignatureRef = useRef("");
  const manifestSignatureRef = useRef("");

  const isEnabled = supportsNativeImageSurface();

  useEffect(() => {
    canvasSizeRef.current = canvasSize;
    onReadyChangeRef.current = onReadyChange;
    onAssetReadyChangeRef.current = onAssetReadyChange;
  });

  useEffect(() => {
    if (!isEnabled) return;
    if (deferredCleanupRef.current !== null) {
      window.clearTimeout(deferredCleanupRef.current);
      deferredCleanupRef.current = null;
    }
    const scheduleCleanup = () => {
      deferredCleanupRef.current = window.setTimeout(() => {
        onReadyChangeRef.current?.(false);
        workerRef.current?.terminate();
        workerRef.current = null;
        deferredCleanupRef.current = null;
      }, 0);
    };
    if (workerRef.current) return scheduleCleanup;

    const canvas = canvasRef.current;
    if (!canvas || !("transferControlToOffscreen" in canvas)) return;
    if (hasTransferredCanvasRef.current) {
      onReadyChangeRef.current?.(false);
      return;
    }

    onReadyChangeRef.current?.(false);
    let worker: Worker | null = null;

    try {
      const offscreen = canvas.transferControlToOffscreen();
      hasTransferredCanvasRef.current = true;
      worker = new Worker(
        new URL(
          "../../workers/nativeImageCompositor.worker.ts",
          import.meta.url,
        ),
        { type: "module" },
      );
      workerRef.current = worker;

      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as
          | { type: "ready" }
          | { type: "asset-ready"; itemId: string; path: string }
          | { type: "error"; reason?: string };

        if (message.type === "ready") {
          onReadyChangeRef.current?.(true);
          return;
        }

        if (message.type === "asset-ready") {
          onAssetReadyChangeRef.current?.(message.itemId, message.path);
          return;
        }

        if (message.type === "error") {
          onReadyChangeRef.current?.(false);
        }
      };

      worker.onerror = () => {
        onReadyChangeRef.current?.(false);
      };

      worker.onmessageerror = () => {
        onReadyChangeRef.current?.(false);
      };

      worker.postMessage(
        {
          type: "init",
          canvas: offscreen,
          width: canvasSizeRef.current.width,
          height: canvasSizeRef.current.height,
          devicePixelRatio: window.devicePixelRatio || 1,
        },
        [offscreen],
      );
      worker.postMessage({
        type: "settings",
        resourcePolicy: readNativeImageResourcePolicySetting(),
      });
    } catch (error) {
      console.warn(
        "Native image surface unavailable; falling back to DOM image rendering.",
        error,
      );
      onReadyChangeRef.current?.(false);
      worker?.terminate();
      workerRef.current = null;
      return;
    }

    return () => {
      scheduleCleanup();
    };
  }, [isEnabled]);

  useEffect(() => {
    if (!isEnabled) return;

    workerRef.current?.postMessage({
      type: "resize",
      width: canvasSize.width,
      height: canvasSize.height,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
  }, [canvasSize.height, canvasSize.width, isEnabled]);

  useEffect(() => {
    if (!isEnabled) return;

    const viewportSignature = signatureForViewport(viewport);
    const { manifest, previewRequests } = buildNativeImageManifest({
      items,
      viewport,
      canvasSize,
      selectedItems,
      draggingItemId,
      resizingItemId,
      croppingItemId,
      editingCropItemId,
    });
    const manifestSignature = [
      viewportSignature,
      manifest.assets.length,
      ...manifest.assets.map(
        (asset) =>
          `${asset.id}:${asset.path}:${asset.drawOrder}:${asset.isSelected ? 1 : 0}:${asset.cropLeftRatio.toFixed(4)}:${asset.cropTopRatio.toFixed(4)}:${asset.cropWidthRatio.toFixed(4)}:${asset.cropHeightRatio.toFixed(4)}:${asset.screenX.toFixed(1)}:${asset.screenY.toFixed(1)}:${asset.renderedWidthPx.toFixed(1)}:${asset.renderedHeightPx.toFixed(1)}`,
      ),
    ].join("|");

    if (manifestSignature !== manifestSignatureRef.current) {
      manifestSignatureRef.current = manifestSignature;
      workerRef.current?.postMessage({ type: "layout", manifest });
    }

    const previewSignature = signatureForPreviewRequests(
      previewRequests,
      viewportSignature,
    );
    if (previewSignature === previewSignatureRef.current) return;

    previewSignatureRef.current = previewSignature;
    const viewBounds = getViewBounds(
      viewport,
      canvasSize.width,
      canvasSize.height,
    );
    for (const request of previewRequests) {
      requestImagePreview(request.item, request.maxDimension, {
        viewBounds,
      });
    }
  }, [
    canvasSize,
    croppingItemId,
    draggingItemId,
    editingCropItemId,
    isEnabled,
    items,
    requestImagePreview,
    resizingItemId,
    selectedItems,
    viewport,
  ]);

  if (!isEnabled) return null;

  return <canvas ref={canvasRef} className="native-image-surface" />;
}

export { supportsNativeImageSurface };
