import type { SetStateAction } from "react";
import { create } from "zustand";
import type { ISelectionBox } from "../components/SelectionBox";

export type InteractionMode =
  | "idle"
  | "dragging"
  | "resizing"
  | "cropping"
  | "panning"
  | "selecting";

type InteractionItemRefs = {
  draggingItem: string | null;
  resizingItem: string | null;
  croppingItem: string | null;
};

type InteractionStore = {
  mode: InteractionMode;
  draggingItem: string | null;
  resizingItem: string | null;
  croppingItem: string | null;
  editingCropItem: string | null;
  isPanning: boolean;
  selectionBox: ISelectionBox | null;
  startDragging: (itemId: string) => void;
  startResizing: (itemId: string) => void;
  startCropping: (itemId: string) => void;
  startPanning: () => void;
  startSelecting: (selectionBox: ISelectionBox) => void;
  setSelectionBox: (value: SetStateAction<ISelectionBox | null>) => void;
  clearSelectionBox: () => void;
  stopPanning: () => void;
  clearItemInteraction: () => void;
  setEditingCropItem: (value: SetStateAction<string | null>) => void;
  toggleEditingCropItem: (itemId: string) => void;
  clearEditingCropItem: () => void;
  clearInteractionState: () => void;
  getActiveItemId: () => string | null;
  isDraggingItem: (itemId: string) => boolean;
  isResizingItem: (itemId: string) => boolean;
  isCroppingItem: (itemId: string) => boolean;
};

const itemRefs: InteractionItemRefs = {
  draggingItem: null,
  resizingItem: null,
  croppingItem: null,
};

const resolveStateUpdate = <T>(value: SetStateAction<T>, prev: T): T =>
  typeof value === "function" ? (value as (prevState: T) => T)(prev) : value;

const syncItemRefs = (next: Partial<InteractionItemRefs>) => {
  if ("draggingItem" in next) {
    itemRefs.draggingItem = next.draggingItem ?? null;
  }

  if ("resizingItem" in next) {
    itemRefs.resizingItem = next.resizingItem ?? null;
  }

  if ("croppingItem" in next) {
    itemRefs.croppingItem = next.croppingItem ?? null;
  }
};

const clearItemRefs = () =>
  syncItemRefs({
    draggingItem: null,
    resizingItem: null,
    croppingItem: null,
  });

const itemInteractionModes = new Set<InteractionMode>([
  "dragging",
  "resizing",
  "cropping",
]);

export const useInteractionStore = create<InteractionStore>((set) => ({
  mode: "idle",
  draggingItem: null,
  resizingItem: null,
  croppingItem: null,
  editingCropItem: null,
  isPanning: false,
  selectionBox: null,
  startDragging: (draggingItem) => {
    syncItemRefs({
      draggingItem,
      resizingItem: null,
      croppingItem: null,
    });

    set((state) => ({
      ...state,
      mode: "dragging",
      draggingItem,
      resizingItem: null,
      croppingItem: null,
      isPanning: false,
      selectionBox: null,
    }));
  },
  startResizing: (resizingItem) => {
    syncItemRefs({
      draggingItem: null,
      resizingItem,
      croppingItem: null,
    });

    set((state) => ({
      ...state,
      mode: "resizing",
      draggingItem: null,
      resizingItem,
      croppingItem: null,
      isPanning: false,
      selectionBox: null,
    }));
  },
  startCropping: (croppingItem) => {
    syncItemRefs({
      draggingItem: null,
      resizingItem: null,
      croppingItem,
    });

    set((state) => ({
      ...state,
      mode: "cropping",
      draggingItem: null,
      resizingItem: null,
      croppingItem,
      isPanning: false,
      selectionBox: null,
    }));
  },
  startPanning: () => {
    clearItemRefs();

    set((state) => ({
      ...state,
      mode: "panning",
      draggingItem: null,
      resizingItem: null,
      croppingItem: null,
      isPanning: true,
      selectionBox: null,
    }));
  },
  startSelecting: (selectionBox) => {
    clearItemRefs();

    set((state) => ({
      ...state,
      mode: "selecting",
      draggingItem: null,
      resizingItem: null,
      croppingItem: null,
      isPanning: false,
      selectionBox,
    }));
  },
  setSelectionBox: (value) =>
    set((state) => {
      const selectionBox = resolveStateUpdate(value, state.selectionBox);

      if (selectionBox) {
        clearItemRefs();

        return {
          ...state,
          mode: "selecting",
          draggingItem: null,
          resizingItem: null,
          croppingItem: null,
          isPanning: false,
          selectionBox,
        };
      }

      return {
        ...state,
        mode: state.mode === "selecting" ? "idle" : state.mode,
        selectionBox: null,
      };
    }),
  clearSelectionBox: () =>
    set((state) =>
      state.selectionBox === null
        ? state
        : {
            ...state,
            mode: state.mode === "selecting" ? "idle" : state.mode,
            selectionBox: null,
          },
    ),
  stopPanning: () =>
    set((state) =>
      state.isPanning
        ? {
            ...state,
            mode: state.mode === "panning" ? "idle" : state.mode,
            isPanning: false,
          }
        : state,
    ),
  clearItemInteraction: () => {
    clearItemRefs();

    set((state) => {
      if (!itemInteractionModes.has(state.mode)) {
        return {
          ...state,
          draggingItem: null,
          resizingItem: null,
          croppingItem: null,
        };
      }

      return {
        ...state,
        mode: "idle",
        draggingItem: null,
        resizingItem: null,
        croppingItem: null,
      };
    });
  },
  setEditingCropItem: (value) =>
    set((state) => ({
      editingCropItem: resolveStateUpdate(value, state.editingCropItem),
    })),
  toggleEditingCropItem: (itemId) =>
    set((state) => ({
      editingCropItem: state.editingCropItem === itemId ? null : itemId,
    })),
  clearEditingCropItem: () => set({ editingCropItem: null }),
  clearInteractionState: () => {
    clearItemRefs();

    set({
      mode: "idle",
      draggingItem: null,
      resizingItem: null,
      croppingItem: null,
      editingCropItem: null,
      isPanning: false,
      selectionBox: null,
    });
  },
  getActiveItemId: () =>
    itemRefs.draggingItem ?? itemRefs.resizingItem ?? itemRefs.croppingItem,
  isDraggingItem: (itemId) => itemRefs.draggingItem === itemId,
  isResizingItem: (itemId) => itemRefs.resizingItem === itemId,
  isCroppingItem: (itemId) => itemRefs.croppingItem === itemId,
}));
