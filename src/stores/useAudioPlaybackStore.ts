import { create } from "zustand";

type AudioPlaybackStore = {
  activeItemId: string | null;
  volume: number;
  muted: boolean;
  toggleItem: (itemId: string) => void;
  clearItem: (itemId?: string) => void;
  setVolume: (volume: number) => void;
  toggleMuted: () => void;
  resetAudioPlayback: () => void;
};

const clampVolume = (volume: number) => Math.min(1, Math.max(0, volume));

export const useAudioPlaybackStore = create<AudioPlaybackStore>((set) => ({
  activeItemId: null,
  volume: 0.8,
  muted: false,
  toggleItem: (itemId) =>
    set((state) =>
      state.activeItemId === itemId
        ? { activeItemId: null, muted: true }
        : { activeItemId: itemId, muted: false }
    ),
  clearItem: (itemId) =>
    set((state) =>
      itemId === undefined || state.activeItemId === itemId
        ? { activeItemId: null, muted: true }
        : state
    ),
  setVolume: (volume) => set({ volume: clampVolume(volume) }),
  toggleMuted: () => set((state) => ({ muted: !state.muted })),
  resetAudioPlayback: () =>
    set({
      activeItemId: null,
      volume: 0.8,
      muted: false
    })
}));
