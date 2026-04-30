import { useEffect, useRef } from "react";
import { getViewBounds } from "../../utils/viewport";
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
  const previewSignatureRef = useRef("");
  const manifestSignatureRef = useRef("");

  const isEnabled = supportsNativeImageSurface();

  useEffect(() => {
    if (!isEnabled) return;

    const canvas = canvasRef.current;
    if (!canvas || !("transferControlToOffscreen" in canvas)) return;

    onReadyChange?.(false);
    let worker: Worker | null = null;

    try {
      const offscreen = canvas.transferControlToOffscreen();
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
          onReadyChange?.(true);
          return;
        }

        if (message.type === "asset-ready") {
          onAssetReadyChange?.(message.itemId, message.path);
          return;
        }

        if (message.type === "error") {
          onReadyChange?.(false);
        }
      };

      worker.onerror = () => {
        onReadyChange?.(false);
      };

      worker.onmessageerror = () => {
        onReadyChange?.(false);
      };

      worker.postMessage(
        {
          type: "init",
          canvas: offscreen,
          width: canvasSize.width,
          height: canvasSize.height,
          devicePixelRatio: window.devicePixelRatio || 1,
        },
        [offscreen],
      );
    } catch (error) {
      console.warn(
        "Native image surface unavailable; falling back to DOM image rendering.",
        error,
      );
      onReadyChange?.(false);
      worker?.terminate();
      workerRef.current = null;
      return;
    }

    return () => {
      onReadyChange?.(false);
      worker?.terminate();
      workerRef.current = null;
    };
  }, [
    canvasSize.height,
    canvasSize.width,
    isEnabled,
    onAssetReadyChange,
    onReadyChange,
  ]);

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

    let frameId = 0;
    let lastItems = items;
    let lastSelectedItems = selectedItems;
    let lastDraggingItemId = draggingItemId;
    let lastResizingItemId = resizingItemId;
    let lastCroppingItemId = croppingItemId;
    let lastEditingCropItemId = editingCropItemId;
    let lastViewportSignature = "";

    const publishManifest = () => {
      const viewportSignature = signatureForViewport(viewport);
      const inputsChanged =
        lastItems !== items ||
        lastSelectedItems !== selectedItems ||
        lastDraggingItemId !== draggingItemId ||
        lastResizingItemId !== resizingItemId ||
        lastCroppingItemId !== croppingItemId ||
        lastEditingCropItemId !== editingCropItemId ||
        lastViewportSignature !== viewportSignature;

      if (inputsChanged) {
        lastItems = items;
        lastSelectedItems = selectedItems;
        lastDraggingItemId = draggingItemId;
        lastResizingItemId = resizingItemId;
        lastCroppingItemId = croppingItemId;
        lastEditingCropItemId = editingCropItemId;
        lastViewportSignature = viewportSignature;

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
              `${asset.id}:${asset.path}:${asset.drawOrder}:${asset.cropLeftRatio.toFixed(4)}:${asset.cropTopRatio.toFixed(4)}:${asset.cropWidthRatio.toFixed(4)}:${asset.cropHeightRatio.toFixed(4)}:${asset.screenX.toFixed(1)}:${asset.screenY.toFixed(1)}:${asset.renderedWidthPx.toFixed(1)}:${asset.renderedHeightPx.toFixed(1)}`,
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
        if (previewSignature !== previewSignatureRef.current) {
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
        }
      }

      frameId = window.requestAnimationFrame(publishManifest);
    };

    frameId = window.requestAnimationFrame(publishManifest);
    return () => window.cancelAnimationFrame(frameId);
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
