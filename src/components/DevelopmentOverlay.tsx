import { useEffect } from "react";
import { Command } from "@tauri-apps/plugin-shell";
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
  } = useDevStore();

  useEffect(() => {
    if (!devMode) {
      useDevStore.getState().resetStats();
      return;
    }

    let animationFrameId = 0;
    let frames = 0;
    let lastTime = performance.now();

    function rafLoop(now: number) {
      frames++;
      const delta = now - lastTime;

      if (delta >= 500) {
        const videoElements =
          canvasRef.current?.querySelectorAll<HTMLVideoElement>(
            "video.media-content",
          ) ?? [];
        const activeVideoCount = Array.from(videoElements).filter(
          (video) => !video.paused && !video.ended && video.readyState > 2,
        ).length;

        useDevStore.getState().setFrameStats({
          fps: Math.round((frames / delta) * 1000),
          frameTimeMs: Number((delta / frames).toFixed(1)),
        });
        useDevStore.getState().setVideoStats({
          activeVideoCount,
          totalVideoCount,
        });

        frames = 0;
        lastTime = now;
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
    <div className="development-stats" aria-label="Development stats">
      <div>
        <span>FPS</span>
        <strong>{fps}</strong>
      </div>
      <div>
        <span>Frame time (ms)</span>
        <strong>{frameTimeMs}</strong>
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
    </div>
  );
};

export { DevelopmentOverlay };
