import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  getCanvasConfigData,
  loadFromStorage,
  saveToStorage,
  saveToStorageAs,
} from "../utils/fs";
import type { MediaItem, Viewport } from "../utils/media.types";
import { notify } from "../utils/notifications";
import { markPerformance } from "../utils/performance";

const SESSION_STORAGE_KEY = "sigma:canvas-session";

export const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

type CanvasSessionSnapshot = {
  items: MediaItem[];
  viewport: Viewport;
  saveFilePath: string | null;
  lastSavedSignature: string | null;
  isDirty: boolean;
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
  saveSessionToNewFile: () => Promise<void>;
  loadSessionFromFile: () => Promise<boolean>;
};

const getUnsavedSignature = (items: MediaItem[], viewport: Viewport) =>
  JSON.stringify({ items, viewport });

const getSavedSignature = (
  items: MediaItem[],
  viewport: Viewport,
  saveFilePath: string | null,
) => (saveFilePath ? getCanvasConfigData(items, viewport, saveFilePath) : null);

const resolveDirtyState = ({
  items,
  viewport,
  saveFilePath,
  lastSavedSignature,
}: Pick<
  CanvasSessionSnapshot,
  "items" | "viewport" | "saveFilePath" | "lastSavedSignature"
>) => {
  if (lastSavedSignature !== null && saveFilePath !== null) {
    return (
      getSavedSignature(items, viewport, saveFilePath) !== lastSavedSignature
    );
  }

  return (
    getUnsavedSignature(items, viewport) !==
    getUnsavedSignature([], INITIAL_VIEWPORT)
  );
};

const resolveStateUpdate = <T>(value: T | ((prevState: T) => T), prev: T): T =>
  typeof value === "function" ? (value as (prevState: T) => T)(prev) : value;

const toMediaUrl = (filePath: string, fallback?: string) => {
  try {
    return convertFileSrc(filePath);
  } catch {
    return fallback ?? `asset://${filePath}`;
  }
};

const attachMediaUrls = (item: MediaItem) => {
  const nextUrls = {
    url: toMediaUrl(item.filePath, item.url),
    thumbnailUrl: item.thumbnailPath
      ? toMediaUrl(item.thumbnailPath, item.thumbnailUrl)
      : undefined,
    imagePreview256Url: item.imagePreview256Path
      ? toMediaUrl(item.imagePreview256Path, item.imagePreview256Url)
      : undefined,
    imagePreview1024Url: item.imagePreview1024Path
      ? toMediaUrl(item.imagePreview1024Path, item.imagePreview1024Url)
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
      saveFilePath: null,
      lastSavedSignature: null,
      isDirty: false,
      setViewport: (value) =>
        set((state) => {
          const viewport = resolveStateUpdate(value, state.viewport);
          return {
            viewport,
            isDirty: resolveDirtyState({
              items: state.items,
              viewport,
              saveFilePath: state.saveFilePath,
              lastSavedSignature: state.lastSavedSignature,
            }),
          };
        }),
      setItems: (value) =>
        set((state) => {
          const items = normalizeItems(resolveStateUpdate(value, state.items));
          return {
            items,
            isDirty: resolveDirtyState({
              items,
              viewport: state.viewport,
              saveFilePath: state.saveFilePath,
              lastSavedSignature: state.lastSavedSignature,
            }),
          };
        }),
      replaceSession: (snapshot) =>
        set((state) => {
          const items = normalizeItems(snapshot.items ?? state.items);
          const viewport = snapshot.viewport ?? state.viewport;
          const saveFilePath =
            snapshot.saveFilePath === undefined
              ? state.saveFilePath
              : snapshot.saveFilePath;
          const lastSavedSignature =
            snapshot.lastSavedSignature === undefined
              ? state.lastSavedSignature
              : snapshot.lastSavedSignature;
          return {
            items,
            viewport,
            saveFilePath,
            lastSavedSignature,
            isDirty: resolveDirtyState({
              items,
              viewport,
              saveFilePath,
              lastSavedSignature,
            }),
          };
        }),
      saveSessionToFile: async () => {
        const { items, viewport, saveFilePath, isDirty } = get();
        if (!saveFilePath || !isDirty) {
          return;
        }

        const result = await saveToStorage(items, viewport, saveFilePath);

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

        set({
          saveFilePath: result.filePath,
          lastSavedSignature: getSavedSignature(
            items,
            viewport,
            result.filePath,
          ),
          isDirty: false,
        });
        notify.success("Save completed", {
          description: "Config saved successfully.",
        });
      },
      saveSessionToNewFile: async () => {
        const { items, viewport, saveFilePath } = get();
        const result = await saveToStorageAs(
          items,
          viewport,
          saveFilePath ?? "canvas.json",
        );

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

        set({
          saveFilePath: result.filePath,
          lastSavedSignature: getSavedSignature(
            items,
            viewport,
            result.filePath,
          ),
          isDirty: false,
        });
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
          saveFilePath: result.filePath,
          lastSavedSignature: getSavedSignature(
            result.data.items,
            result.data.viewport ?? INITIAL_VIEWPORT,
            result.filePath,
          ),
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
        saveFilePath: state.saveFilePath,
        lastSavedSignature: state.lastSavedSignature,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<CanvasSessionSnapshot>;
        const items = normalizeItems(persisted.items ?? currentState.items);
        const viewport = persisted.viewport ?? currentState.viewport;
        const saveFilePath =
          persisted.saveFilePath ?? currentState.saveFilePath;
        const lastSavedSignature =
          persisted.lastSavedSignature ?? currentState.lastSavedSignature;
        return {
          ...currentState,
          items,
          viewport,
          saveFilePath,
          lastSavedSignature,
          isDirty: resolveDirtyState({
            items,
            viewport,
            saveFilePath,
            lastSavedSignature,
          }),
        };
      },
    },
  ),
);
