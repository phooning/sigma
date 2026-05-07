import { Command } from "@tauri-apps/plugin-shell";
import { useEffect } from "react";
import { useDevStore } from "../stores/useDevStore";

type DevelopmentOverlayProps = {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  totalVideoCount: number;
};

type SystemProfilerDisplay = {
  _name?: string;
  sppci_model?: string;
  spdisplays_vram?: string;
  sppci_vram?: string;
};

type SystemProfilerPayload = {
  SPDisplaysDataType?: SystemProfilerDisplay[];
};

const UNKNOWN_VALUE = "n/a";
const VSYNC_INTERVAL_MS = 1_000 / 60;
const UI_SAMPLE_WINDOW_MS = 500;

const parseGpuInfo = (stdout: string) => {
  try {
    const payload = JSON.parse(stdout) as SystemProfilerPayload;
    const display = payload.SPDisplaysDataType?.[0];

    return {
      gpuName: display?.sppci_model ?? display?._name ?? UNKNOWN_VALUE,
      vramUsage:
        display?.spdisplays_vram ?? display?.sppci_vram ?? "Unified memory",
    };
  } catch {
    return {
      gpuName: UNKNOWN_VALUE,
      vramUsage: UNKNOWN_VALUE,
    };
  }
};

const parseGpuUsage = (stdout: string) => {
  const utilizationMatch = stdout.match(
    /"(?:Device Utilization %|GPU Utilization|GPU Usage)"\s*=\s*(\d+(?:\.\d+)?)/i,
  );
  const memoryMatch = stdout.match(
    /"(?:In use system memory|VRAM Used|vramUsedBytes)"\s*=\s*(\d+)/i,
  );

  return {
    gpuUsage: utilizationMatch ? `${utilizationMatch[1]}%` : UNKNOWN_VALUE,
    vramUsage: memoryMatch
      ? `${Math.round(Number(memoryMatch[1]) / 1024 / 1024)} MB`
      : undefined,
  };
};

const pollGpuStats = async () => {
  const [gpuInfoOutput, gpuUsageOutput] = await Promise.allSettled([
    Command.create("gpu-info", ["SPDisplaysDataType", "-json"]).execute(),
    Command.create("gpu-usage", [
      "-l",
      "-w",
      "0",
      "-c",
      "AGXStatistics",
    ]).execute(),
  ]);

  const nextStats = {
    gpuUsage: UNKNOWN_VALUE,
    gpuName: UNKNOWN_VALUE,
    vramUsage: UNKNOWN_VALUE,
  };

  if (gpuInfoOutput.status === "fulfilled") {
    Object.assign(nextStats, parseGpuInfo(gpuInfoOutput.value.stdout));
  }

  if (gpuUsageOutput.status === "fulfilled") {
    const usageStats = parseGpuUsage(gpuUsageOutput.value.stdout);
    nextStats.gpuUsage = usageStats.gpuUsage;
    nextStats.vramUsage = usageStats.vramUsage ?? nextStats.vramUsage;
  }

  useDevStore.getState().setGpuStats(nextStats);
};

const formatTiming = (value: number | null) =>
  value === null ? UNKNOWN_VALUE : `${value.toFixed(1)} ms`;

const formatCount = (value: number | null) =>
  value === null ? UNKNOWN_VALUE : `${value}`;

const DevelopmentOverlay = ({
  canvasRef,
  totalVideoCount,
}: DevelopmentOverlayProps) => {
  const {
    devMode,
    fps,
    frameTimeMs,
    activeVideoCount,
    gpuUsage,
    gpuName,
    vramUsage,
    cpuFrameTimeMs,
    gpuFrameTimeMs,
    uiThreadTimeMs,
    renderThreadTimeMs,
    compositorTimeMs,
    swapPresentTimeMs,
    framesQueued,
    framesDropped,
    framesMissedVsync,
  } = useDevStore();

  useEffect(() => {
    if (!devMode) {
      useDevStore.getState().resetStats();
      return;
    }

    let animationFrameId = 0;
    let frames = 0;
    let missedVsync = 0;
    let uiThreadTotalMs = 0;
    let lastWindowStartedAt = performance.now();
    let lastFrameAt = lastWindowStartedAt;

    function rafLoop(now: number) {
      const callbackStartedAt = performance.now();
      const frameDelta = now - lastFrameAt;
      lastFrameAt = now;
      frames++;
      missedVsync += Math.max(
        0,
        Math.round(frameDelta / VSYNC_INTERVAL_MS) - 1,
      );
      const elapsedSinceWindowStart = now - lastWindowStartedAt;
      let nextActiveVideoCount = 0;

      if (elapsedSinceWindowStart >= UI_SAMPLE_WINDOW_MS) {
        const videoElements =
          canvasRef.current?.querySelectorAll<HTMLVideoElement>(
            "video.media-content",
          ) ?? [];
        nextActiveVideoCount = Array.from(videoElements).filter(
          (video) => !video.paused && !video.ended && video.readyState > 2,
        ).length;
      }

      uiThreadTotalMs += performance.now() - callbackStartedAt;

      if (elapsedSinceWindowStart >= UI_SAMPLE_WINDOW_MS) {
        useDevStore.getState().setFrameStats({
          fps: Math.round((frames / elapsedSinceWindowStart) * 1000),
          frameTimeMs: Number((elapsedSinceWindowStart / frames).toFixed(1)),
        });
        useDevStore.getState().setVideoStats({
          activeVideoCount: nextActiveVideoCount,
          totalVideoCount,
        });
        useDevStore.getState().setPipelineStats({
          cpuFrameTimeMs: Number((elapsedSinceWindowStart / frames).toFixed(1)),
          uiThreadTimeMs: Number((uiThreadTotalMs / frames).toFixed(1)),
          framesMissedVsync: missedVsync,
        });

        frames = 0;
        missedVsync = 0;
        uiThreadTotalMs = 0;
        lastWindowStartedAt = now;
      }

      animationFrameId = requestAnimationFrame(rafLoop);
    }

    animationFrameId = requestAnimationFrame(rafLoop);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [canvasRef, devMode, totalVideoCount]);

  useEffect(() => {
    if (!devMode) return;

    pollGpuStats();
    const intervalId = window.setInterval(pollGpuStats, 3000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [devMode]);

  if (!devMode) return null;

  return (
    <section className="development-stats" aria-label="Development stats">
      <div>
        <span>FPS</span>
        <strong>{fps}</strong>
      </div>
      <div>
        <span>Frame time (ms)</span>
        <strong>{frameTimeMs}</strong>
      </div>
      <div>
        <span>CPU frame time</span>
        <strong>{formatTiming(cpuFrameTimeMs)}</strong>
      </div>
      <div>
        <span>GPU frame time</span>
        <strong>{formatTiming(gpuFrameTimeMs)}</strong>
      </div>
      <div>
        <span>UI thread time</span>
        <strong>{formatTiming(uiThreadTimeMs)}</strong>
      </div>
      <div>
        <span>Render thread time</span>
        <strong>{formatTiming(renderThreadTimeMs)}</strong>
      </div>
      <div>
        <span>Compositor time</span>
        <strong>{formatTiming(compositorTimeMs)}</strong>
      </div>
      <div>
        <span>Swap/present time</span>
        <strong>{formatTiming(swapPresentTimeMs)}</strong>
      </div>
      <div>
        <span>Frames queued</span>
        <strong>{formatCount(framesQueued)}</strong>
      </div>
      <div>
        <span>Frames dropped</span>
        <strong>{formatCount(framesDropped)}</strong>
      </div>
      <div>
        <span>Frames missed vsync</span>
        <strong>{formatCount(framesMissedVsync)}</strong>
      </div>
      <div>
        <span>Video count</span>
        <strong>
          {activeVideoCount}/{totalVideoCount}
        </strong>
      </div>
      <div>
        <span>GPU usage</span>
        <strong title={gpuName}>{gpuUsage}</strong>
      </div>
      <div>
        <span>VRAM usage</span>
        <strong>{vramUsage}</strong>
      </div>
    </section>
  );
};

export { DevelopmentOverlay };
