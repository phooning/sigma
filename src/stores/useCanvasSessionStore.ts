import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { loadFromStorage, saveToStorage } from "../utils/fs";
import type { MediaItem, Viewport } from "../utils/media.types";
import { notify } from "../utils/notifications";
import { markPerformance } from "../utils/performance";

const SESSION_STORAGE_KEY = "sigma:canvas-session";

export const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

type CanvasSessionSnapshot = {
  items: MediaItem[];
  viewport: Viewport;
};

type CanvasSessionStore = CanvasSessionSnapshot & {
  setItems: (
    value: MediaItem[] | ((prevItems: MediaItem[]) => MediaItem[]),
  ) => void;
  setViewport: (
    value: Viewport | ((prevViewport: Viewport) => Viewport),
  ) => void;
  replaceSession: (snapshot: Partial<CanvasSessionSnapshot>) => void;
  saveSessionToFile: () => Promise<void>;
  loadSessionFromFile: () => Promise<boolean>;
};

const resolveStateUpdate = <T,>(
  value: T | ((prevState: T) => T),
  prev: T,
): T => (typeof value === "function" ? (value as (prevState: T) => T)(prev) : value);

const attachMediaUrls = (item: MediaItem) => {
  const nextUrls = {
    url: convertFileSrc(item.filePath),
    thumbnailUrl: item.thumbnailPath
      ? convertFileSrc(item.thumbnailPath)
      : undefined,
    imagePreview256Url: item.imagePreview256Path
      ? convertFileSrc(item.imagePreview256Path)
      : undefined,
    imagePreview1024Url: item.imagePreview1024Path
      ? convertFileSrc(item.imagePreview1024Path)
      : undefined,
  };

  if (
    item.url === nextUrls.url &&
    item.thumbnailUrl === nextUrls.thumbnailUrl &&
    item.imagePreview256Url === nextUrls.imagePreview256Url &&
    item.imagePreview1024Url === nextUrls.imagePreview1024Url
  ) {
    return item;
  }

  return {
    ...item,
    ...nextUrls,
  };
};

const normalizeItems = (items: MediaItem[]) => {
  let changed = false;
  const nextItems = items.map((item) => {
    const nextItem = attachMediaUrls(item);
    if (nextItem !== item) changed = true;
    return nextItem;
  });
  return changed ? nextItems : items;
};

const createMeasuredLocalStorage = () => ({
  getItem: (name: string) => localStorage.getItem(name),
  removeItem: (name: string) => localStorage.removeItem(name),
  setItem: (name: string, value: string) => {
    markPerformance("sigma:canvas-session:localStorage:setItem:start");

    try {
      localStorage.setItem(name, value);
    } finally {
      markPerformance("sigma:canvas-session:localStorage:setItem:end");
    }
  },
});

export const useCanvasSessionStore = create<CanvasSessionStore>()(
  persist(
    (set, get) => ({
      items: [],
      viewport: INITIAL_VIEWPORT,
      setItems: (value) =>
        set((state) => ({
          items: normalizeItems(resolveStateUpdate(value, state.items)),
        })),
      setViewport: (value) =>
        set((state) => ({
          viewport: resolveStateUpdate(value, state.viewport),
        })),
      replaceSession: (snapshot) =>
        set((state) => ({
          items: normalizeItems(snapshot.items ?? state.items),
          viewport: snapshot.viewport ?? state.viewport,
        })),
      saveSessionToFile: async () => {
        const { items, viewport } = get();
        const result = await saveToStorage(items, viewport);

        if (!result.ok) {
          if (result.reason === "cancelled") return;

          const text =
            result.error instanceof Error
              ? result.error.message
              : "Unknown error while saving.";

          console.error("Failed to save config:", result.error);
          notify.error("Save failed", {
            description: text,
          });
          return;
        }

        notify.success("Save completed", {
          description: "Config saved successfully.",
        });
      },
      loadSessionFromFile: async () => {
        const result = await loadFromStorage();

        if (!result.ok) {
          if (result.reason !== "cancelled") {
            const description =
              result.error ??
              (result.reason === "invalid"
                ? "Selected file is not a valid Sigma config."
                : "Failed to load config.");

            notify.error("Load failed", {
              description,
            });
          }

          return false;
        }

        get().replaceSession({
          items: result.data.items,
          viewport: result.data.viewport ?? INITIAL_VIEWPORT,
        });
        return true;
      },
    }),
    {
      name: SESSION_STORAGE_KEY,
      storage: createJSONStorage(createMeasuredLocalStorage),
      partialize: (state) => ({
        items: state.items,
        viewport: state.viewport,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<CanvasSessionSnapshot>;
        return {
          ...currentState,
          items: normalizeItems(persisted.items ?? currentState.items),
          viewport: persisted.viewport ?? currentState.viewport,
        };
      },
    },
  ),
);
