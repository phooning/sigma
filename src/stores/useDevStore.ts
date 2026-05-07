import { create } from "zustand";

type GpuStats = {
  gpuUsage: string;
  gpuName: string;
  vramUsage: string;
};

type FrameStats = {
  fps: number;
  frameTimeMs: number;
};

type VideoStats = {
  activeVideoCount: number;
  totalVideoCount: number;
};

type PipelineStats = {
  cpuFrameTimeMs: number | null;
  gpuFrameTimeMs: number | null;
  uiThreadTimeMs: number | null;
  renderThreadTimeMs: number | null;
  compositorTimeMs: number | null;
  swapPresentTimeMs: number | null;
  framesQueued: number | null;
  framesDropped: number | null;
  framesMissedVsync: number | null;
};

type DevStore = FrameStats &
  VideoStats &
  GpuStats &
  PipelineStats & {
    devMode: boolean;
    toggleDevMode: () => void;
    setDevMode: (devMode: boolean) => void;
    setFrameStats: (stats: FrameStats) => void;
    setVideoStats: (stats: VideoStats) => void;
    setGpuStats: (stats: GpuStats) => void;
    setPipelineStats: (stats: Partial<PipelineStats>) => void;
    resetStats: () => void;
  };

const initialStats: FrameStats & VideoStats & GpuStats & PipelineStats = {
  fps: 0,
  frameTimeMs: 0,
  activeVideoCount: 0,
  totalVideoCount: 0,
  gpuUsage: "n/a",
  gpuName: "n/a",
  vramUsage: "n/a",
  cpuFrameTimeMs: null,
  gpuFrameTimeMs: null,
  uiThreadTimeMs: null,
  renderThreadTimeMs: null,
  compositorTimeMs: null,
  swapPresentTimeMs: null,
  framesQueued: null,
  framesDropped: null,
  framesMissedVsync: null,
};

export const useDevStore = create<DevStore>((set) => ({
  devMode: false,
  ...initialStats,
  toggleDevMode: () => set((state) => ({ devMode: !state.devMode })),
  setDevMode: (devMode) => set({ devMode }),
  setFrameStats: (stats) => set(stats),
  setVideoStats: (stats) => set(stats),
  setGpuStats: (stats) => set(stats),
  setPipelineStats: (stats) => set(stats),
  resetStats: () => set({ devMode: false, ...initialStats }),
}));
