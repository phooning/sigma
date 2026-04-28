import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MediaItem, Viewport } from "../../utils/media.types";
import type {
  NativeControllerSnapshot,
  NativeVideoManifest,
  NativeVideoProfile,
  NativeVideoSurfaceProps
} from "./types";
import {
  computeNativeVideoBounds,
  useNativeVideoManifest
} from "./useNativeVideoManifest";

const MANIFEST_DEBOUNCE_MS = 120;
const FORCE_NATIVE_KEY = "sigma.nativeVideo.enabled";
const CALIBRATE_NATIVE_KEY = "sigma.nativeVideo.calibrate";

const supportsNativeCanvas = () =>
  typeof Worker !== "undefined" &&
  typeof HTMLCanvasElement !== "undefined" &&
  "transferControlToOffscreen" in HTMLCanvasElement.prototype;

const shouldForceNativePlayback = () => {
  try {
    return window.localStorage.getItem(FORCE_NATIVE_KEY) === "true";
  } catch {
    return false;
  }
};

const shouldRunBaseProbe = () => {
  try {
    return window.localStorage.getItem(CALIBRATE_NATIVE_KEY) === "true";
  } catch {
    return false;
  }
};

function debounce<T>(callback: (value: T) => void, delayMs: number) {
  let timeoutId: number | null = null;

  const debounced = (value: T) => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      callback(value);
    }, delayMs);
  };

  debounced.cancel = () => {
    if (timeoutId === null) return;
    window.clearTimeout(timeoutId);
    timeoutId = null;
  };

  return debounced;
}

function updateVideoGeometryImmediate(
  worker: Worker,
  item: MediaItem,
  viewport: Viewport,
  canvasSize: NativeVideoSurfaceProps["canvasSize"]
) {
  if (item.type !== "video") return;

  const bounds = computeNativeVideoBounds(item, viewport, canvasSize);
  worker.postMessage({
    type: "geometry",
    itemId: item.id,
    bounds: bounds
      ? {
          x: bounds.screenX,
          y: bounds.screenY,
          width: bounds.renderedWidthPx,
          height: bounds.renderedHeightPx
        }
      : null
  });
}

const toTransferableBuffer = (
  message: unknown
): ArrayBuffer | SharedArrayBuffer | null => {
  if (message instanceof ArrayBuffer) return message;

  if (message instanceof Uint8Array) {
    // Transfer the exact IPC buffer when possible; only slice partial views.
    if (
      message.byteOffset === 0 &&
      message.byteLength === message.buffer.byteLength &&
      message.buffer instanceof ArrayBuffer
    ) {
      return message.buffer;
    }

    return message.buffer.slice(
      message.byteOffset,
      message.byteOffset + message.byteLength
    );
  }

  return null;
};

export function NativeVideoSurface({
  items,
  viewport,
  canvasSize,
  selectedItems,
  activeAudioItemId
}: NativeVideoSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const frameChannelRef = useRef<Channel<ArrayBuffer> | null>(null);
  const lastMetricsAtRef = useRef(0);
  const isBaseValidatedRef = useRef(false);
  const baseProbeStartedRef = useRef(false);
  const geometryItemIdsRef = useRef<Set<string>>(new Set());
  const [isEnabled, setIsEnabled] = useState(false);
  const [workerGeneration, setWorkerGeneration] = useState(0);
  const manifest = useNativeVideoManifest({
    items,
    viewport,
    canvasSize,
    selectedItems,
    activeAudioItemId
  });
  const debouncedRustManifest = useMemo(
    () =>
      debounce((nextManifest: NativeVideoManifest) => {
        void invoke<NativeControllerSnapshot>("native_video_update_manifest", {
          manifest: nextManifest
        })
          .then((snapshot) => {
            isBaseValidatedRef.current = snapshot.profile.baseCaseValidated;
            workerRef.current?.postMessage({
              type: "allocations",
              allocations: snapshot.allocations
            });
            const firstAsset = nextManifest.assets[0];
            if (
              firstAsset &&
              frameChannelRef.current &&
              shouldRunBaseProbe() &&
              !isBaseValidatedRef.current &&
              !baseProbeStartedRef.current
            ) {
              baseProbeStartedRef.current = true;
              void invoke("native_video_run_base_case_probe", {
                config: {
                  sourcePath: firstAsset.path,
                  width: 3840,
                  height: 2160,
                  fps: 60,
                  frames: 180
                },
                onFrame: frameChannelRef.current
              }).catch(() => {
                baseProbeStartedRef.current = false;
              });
            }
          })
          .catch(() => {
            workerRef.current?.postMessage({
              type: "allocations",
              allocations: []
            });
          });
      }, MANIFEST_DEBOUNCE_MS),
    []
  );

  useEffect(() => {
    if (!supportsNativeCanvas()) return;

    let cancelled = false;

    invoke<NativeVideoProfile>("native_video_get_profile")
      .then((profile) => {
        if (!cancelled) {
          isBaseValidatedRef.current = profile.baseCaseValidated;
          setIsEnabled(
            profile.baseCaseValidated || shouldForceNativePlayback()
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsEnabled(shouldForceNativePlayback());
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isEnabled) return;

    const canvas = canvasRef.current;
    if (!canvas || !("transferControlToOffscreen" in canvas)) return;

    const worker = new Worker(
      new URL("../../workers/nativeVideoCompositor.worker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = worker;
    setWorkerGeneration((generation) => generation + 1);

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as
        | { type: "ready"; renderer: string }
        | {
            type: "metrics";
            metrics: {
              renderer: string;
              canvasWidth: number;
              canvasHeight: number;
              uploadLatencyP95Ms: number;
              compositeLatencyP95Ms: number;
              frameDropRate: number;
              measuredIpcBytesPerSec: number;
            };
          };

      if (message.type !== "metrics") return;

      const now = performance.now();
      if (now - lastMetricsAtRef.current < 2_000) return;
      lastMetricsAtRef.current = now;

      void invoke("native_video_record_frontend_metrics", {
        metrics: message.metrics
      }).catch(() => {
        // Metrics are advisory; presentation should continue if persistence fails.
      });
    };

    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage(
      {
        type: "init",
        canvas: offscreen,
        width: canvasSize.width,
        height: canvasSize.height,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      [offscreen]
    );

    const frameChannel = new Channel<ArrayBuffer>();
    frameChannelRef.current = frameChannel;
    frameChannel.onmessage = (message) => {
      const packet = toTransferableBuffer(message);
      if (!packet) return;
      worker.postMessage({ type: "frame", packet }, [packet]);
    };

    void invoke("native_video_subscribe_frames", {
      onFrame: frameChannel
    });

    return () => {
      worker.terminate();
      workerRef.current = null;
      frameChannelRef.current = null;
      geometryItemIdsRef.current.clear();
      void invoke("native_video_stop_all").catch(() => {});
    };
  }, [canvasSize.height, canvasSize.width, isEnabled]);

  useEffect(() => {
    if (!isEnabled) return;

    workerRef.current?.postMessage({
      type: "resize",
      width: canvasSize.width,
      height: canvasSize.height,
      devicePixelRatio: window.devicePixelRatio || 1
    });
  }, [canvasSize.height, canvasSize.width, isEnabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: workerGeneration ensures a freshly created worker receives geometry even when the scene is otherwise unchanged.
  useLayoutEffect(() => {
    if (!isEnabled) return;

    const worker = workerRef.current;
    if (!worker) return;

    const nextItemIds = new Set<string>();
    for (const item of items) {
      if (item.type !== "video") continue;
      nextItemIds.add(item.id);
      updateVideoGeometryImmediate(worker, item, viewport, canvasSize);
    }

    for (const itemId of geometryItemIdsRef.current) {
      if (nextItemIds.has(itemId)) continue;
      worker.postMessage({ type: "geometry", itemId, bounds: null });
    }
    geometryItemIdsRef.current = nextItemIds;
  }, [canvasSize, isEnabled, items, viewport, workerGeneration]);

  useEffect(() => {
    if (!isEnabled) {
      debouncedRustManifest.cancel();
      return;
    }

    debouncedRustManifest(manifest);
  }, [debouncedRustManifest, isEnabled, manifest]);

  useEffect(
    () => () => {
      debouncedRustManifest.cancel();
    },
    [debouncedRustManifest]
  );

  if (!isEnabled) return null;

  return <canvas ref={canvasRef} className="native-video-surface" />;
}
