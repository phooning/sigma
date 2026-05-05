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

type DevStore = FrameStats &
  VideoStats &
  GpuStats & {
    devMode: boolean;
    toggleDevMode: () => void;
    setDevMode: (devMode: boolean) => void;
    setFrameStats: (stats: FrameStats) => void;
    setVideoStats: (stats: VideoStats) => void;
    setGpuStats: (stats: GpuStats) => void;
    resetStats: () => void;
  };

const initialStats: FrameStats & VideoStats & GpuStats = {
  fps: 0,
  frameTimeMs: 0,
  activeVideoCount: 0,
  totalVideoCount: 0,
  gpuUsage: "n/a",
  gpuName: "n/a",
  vramUsage: "n/a",
};

export const useDevStore = create<DevStore>((set) => ({
  devMode: false,
  ...initialStats,
  toggleDevMode: () => set((state) => ({ devMode: !state.devMode })),
  setDevMode: (devMode) => set({ devMode }),
  setFrameStats: (stats) => set(stats),
  setVideoStats: (stats) => set(stats),
  setGpuStats: (stats) => set(stats),
  resetStats: () => set({ devMode: false, ...initialStats }),
}));
