import { create } from "zustand";
import { initialLoopState, type LoopState } from "../utils/videoUtils";

type VideoExportStore = {
  loopByItemId: Record<string, LoopState>;
  exportingItemId: string | null;
  setLoopState: (itemId: string, loop: LoopState) => void;
  clearItemState: (itemId: string) => void;
  clearAllItemState: () => void;
  setExportingItemId: (itemId: string | null) => void;
  resetVideoExportState: () => void;
};

const cloneLoop = (loop: LoopState): LoopState => ({ ...loop });

export const useVideoExportStore = create<VideoExportStore>((set) => ({
  loopByItemId: {},
  exportingItemId: null,
  setLoopState: (itemId, loop) =>
    set((state) => ({
      loopByItemId: {
        ...state.loopByItemId,
        [itemId]: cloneLoop(loop),
      },
    })),
  clearItemState: (itemId) =>
    set((state) => {
      if (!(itemId in state.loopByItemId)) return state;

      const loopByItemId = { ...state.loopByItemId };
      delete loopByItemId[itemId];

      return {
        loopByItemId,
        exportingItemId:
          state.exportingItemId === itemId ? null : state.exportingItemId,
      };
    }),
  clearAllItemState: () =>
    set({
      loopByItemId: {},
      exportingItemId: null,
    }),
  setExportingItemId: (exportingItemId) => set({ exportingItemId }),
  resetVideoExportState: () =>
    set({
      loopByItemId: {},
      exportingItemId: null,
    }),
}));

export const getStoredVideoLoop = (itemId: string): LoopState =>
  useVideoExportStore.getState().loopByItemId[itemId] ?? initialLoopState;
