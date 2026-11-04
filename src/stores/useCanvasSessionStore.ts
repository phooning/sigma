import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  loadFromStorage,
  saveToStorage,
  selectCanvasSavePath,
} from "../utils/fs";
import type { MediaItem, Viewport } from "../utils/media.types";
import { notify } from "../utils/notifications";
import { markPerformance } from "../utils/performance";
import { useDevStore } from "./useDevStore";
import { getSessionSettings, useSettingsStore } from "./useSettingsStore";

const SESSION_STORAGE_KEY = "sigma:canvas-session";

// Persistence operations share one queue so a load cannot read a destination
// before an earlier save commits, and writes commit in request order.
let persistenceTail: Promise<void> = Promise.resolve();
let sessionGeneration = 0;
let latestLoadRequest = 0;

const enqueuePersistence = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = persistenceTail.then(operation);
  persistenceTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

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
  refreshDirtyState: () => void;
  replaceSession: (snapshot: Partial<CanvasSessionSnapshot>) => void;
  saveSessionToFile: () => Promise<void>;
  saveSessionToNewFile: () => Promise<void>;
  loadSessionFromFile: () => Promise<boolean>;
};

const getDirtySignature = (
  items: MediaItem[],
  settings = getSessionSettings(),
  devMode = useDevStore.getState().devMode,
) =>
  JSON.stringify({
    items,
    settings,
    devMode,
  });

const resolveDirtyState = ({
  items,
  saveFilePath,
  lastSavedSignature,
}: Pick<
  CanvasSessionSnapshot,
  "items" | "saveFilePath" | "lastSavedSignature"
>) => {
  if (lastSavedSignature !== null && saveFilePath !== null) {
    return getDirtySignature(items) !== lastSavedSignature;
  }

  return getDirtySignature(items) !== getDirtySignature([]);
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

const MEDIA_ITEM_IDENTITY_KEYS = [
  "id",
  "type",
  "filePath",
  "url",
  "fileSize",
  "duration",
  "frameRate",
  "sourceWidth",
  "sourceHeight",
  "deferVideoLoad",
  "thumbnailPath",
  "thumbnailUrl",
  "lowResProxyUrl",
  "imagePreview256Path",
  "imagePreview256Url",
  "imagePreview1024Path",
  "imagePreview1024Url",
  "imageLod",
  "videoLod",
  "x",
  "y",
  "width",
  "height",
] as const satisfies ReadonlyArray<keyof MediaItem>;

const areCropInsetsEqual = (
  previous: MediaItem["crop"],
  next: MediaItem["crop"],
) => {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;

  return (
    previous.top === next.top &&
    previous.right === next.right &&
    previous.bottom === next.bottom &&
    previous.left === next.left
  );
};

const areMediaItemsEqual = (previous: MediaItem, next: MediaItem) => {
  if (previous === next) return true;
  if (!areCropInsetsEqual(previous.crop, next.crop)) return false;

  return MEDIA_ITEM_IDENTITY_KEYS.every((key) => previous[key] === next[key]);
};

const reconcileItemIdentities = (
  previousItems: MediaItem[],
  nextItems: MediaItem[],
) => {
  const previousById = new Map(
    previousItems.map((item) => [item.id, item] as const),
  );
  let changed = previousItems.length !== nextItems.length;

  const reconciledItems = nextItems.map((nextItem, index) => {
    const previousItem = previousById.get(nextItem.id);
    const reconciledItem =
      previousItem && areMediaItemsEqual(previousItem, nextItem)
        ? previousItem
        : nextItem;

    if (previousItems[index] !== reconciledItem) {
      changed = true;
    }

    return reconciledItem;
  });

  return changed ? reconciledItems : previousItems;
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

const normalizeAndReconcileItems = (
  items: MediaItem[],
  previousItems: MediaItem[],
) => reconcileItemIdentities(previousItems, normalizeItems(items));

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
              saveFilePath: state.saveFilePath,
              lastSavedSignature: state.lastSavedSignature,
            }),
          };
        }),
      setItems: (value) =>
        set((state) => {
          const items = normalizeAndReconcileItems(
            resolveStateUpdate(value, state.items),
            state.items,
          );
          return {
            items,
            isDirty: resolveDirtyState({
              items,
              saveFilePath: state.saveFilePath,
              lastSavedSignature: state.lastSavedSignature,
            }),
          };
        }),
      refreshDirtyState: () =>
        set((state) => ({
          isDirty: resolveDirtyState({
            items: state.items,
            saveFilePath: state.saveFilePath,
            lastSavedSignature: state.lastSavedSignature,
          }),
        })),
      replaceSession: (snapshot) => {
        sessionGeneration += 1;
        set((state) => {
          const items = normalizeAndReconcileItems(
            snapshot.items ?? state.items,
            state.items,
          );
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
              saveFilePath,
              lastSavedSignature,
            }),
          };
        });
      },
      saveSessionToFile: () => {
        const { items, viewport, saveFilePath, isDirty } = get();
        if (!saveFilePath || !isDirty) return Promise.resolve();
        const generation = sessionGeneration;
        const settings = getSessionSettings();
        const devMode = useDevStore.getState().devMode;
        const savedSignature = getDirtySignature(items, settings, devMode);
        return enqueuePersistence(async () => {
          if (generation !== sessionGeneration) return;
          const destination = get().saveFilePath;
          if (!destination) return;
          const result = await saveToStorage(
            items,
            viewport,
            destination,
            settings,
            devMode,
          );
          if (generation !== sessionGeneration) return;
          if (!result.ok) {
            if (result.reason !== "cancelled") {
              console.error("Failed to save config:", result.error);
              notify.error("Save failed", {
                description:
                  result.error instanceof Error
                    ? result.error.message
                    : String(result.error ?? "Unknown error while saving."),
              });
            }
            return;
          }
          set((state) => ({
            saveFilePath: result.filePath,
            lastSavedSignature: savedSignature,
            isDirty: getDirtySignature(state.items) !== savedSignature,
          }));
          notify.success("Save completed", {
            description: "Config saved successfully.",
          });
        });
      },
      saveSessionToNewFile: () => {
        const { items, viewport, saveFilePath } = get();
        const generation = sessionGeneration;
        const settings = getSessionSettings();
        const devMode = useDevStore.getState().devMode;
        const savedSignature = getDirtySignature(items, settings, devMode);
        return enqueuePersistence(async () => {
          if (generation !== sessionGeneration) return;
          let destination: string | null;
          try {
            destination = await selectCanvasSavePath(
              get().saveFilePath ?? saveFilePath ?? "canvas.json",
            );
          } catch (error) {
            if (generation === sessionGeneration) {
              console.error("Failed to select save destination:", error);
              notify.error("Save failed", { description: String(error) });
            }
            return;
          }
          if (!destination || generation !== sessionGeneration) return;
          const result = await saveToStorage(
            items,
            viewport,
            destination,
            settings,
            devMode,
          );
          if (generation !== sessionGeneration) return;
          if (!result.ok) {
            if (result.reason !== "cancelled") {
              console.error("Failed to save config:", result.error);
              notify.error("Save failed", {
                description:
                  result.error instanceof Error
                    ? result.error.message
                    : String(result.error ?? "Unknown error while saving."),
              });
            }
            return;
          }
          set((state) => ({
            saveFilePath: result.filePath,
            lastSavedSignature: savedSignature,
            isDirty: getDirtySignature(state.items) !== savedSignature,
          }));
          notify.success("Save completed", {
            description: "Config saved successfully.",
          });
        });
      },
      loadSessionFromFile: () => {
        const generation = sessionGeneration;
        const request = ++latestLoadRequest;
        const initial = get();
        const initialSignature = getDirtySignature(initial.items);
        const initialViewport = JSON.stringify(initial.viewport);
        return enqueuePersistence(async () => {
          if (generation !== sessionGeneration || request !== latestLoadRequest)
            return false;
          const result = await loadFromStorage();
          const current = get();
          if (generation !== sessionGeneration || request !== latestLoadRequest)
            return false;
          if (!result.ok && result.reason === "cancelled") return false;
          if (
            initialSignature !== getDirtySignature(current.items) ||
            initialViewport !== JSON.stringify(current.viewport)
          ) {
            notify.warning("Load canceled", {
              description:
                "The canvas changed while the file was opening. Try loading it again.",
            });
            return false;
          }
          if (!result.ok) {
            if (result.reason !== "cancelled") {
              const description =
                result.error ??
                (result.reason === "invalid"
                  ? "Selected file is not a valid Sigma config."
                  : "Failed to load config.");
              notify.error("Load failed", { description });
            }
            return false;
          }
          const nextViewport = result.data.viewport ?? INITIAL_VIEWPORT;
          const nextSettings = result.data.settings ?? {
            screenshotDirectory: "",
            canvasBackgroundPattern: "dots" as const,
          };
          const nextDevMode = result.data.devMode ?? false;
          const loadedItems = normalizeAndReconcileItems(
            result.data.items,
            current.items,
          );
          useSettingsStore.getState().replaceSessionSettings(nextSettings);
          useDevStore.getState().setDevMode(nextDevMode);
          get().replaceSession({
            saveFilePath: result.filePath,
            lastSavedSignature: getDirtySignature(
              loadedItems,
              nextSettings,
              nextDevMode,
            ),
            items: loadedItems,
            viewport: nextViewport,
          });
          return true;
        });
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
        const items = normalizeAndReconcileItems(
          persisted.items ?? currentState.items,
          currentState.items,
        );
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
            saveFilePath,
            lastSavedSignature,
          }),
        };
      },
    },
  ),
);
