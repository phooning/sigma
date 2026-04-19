import { create } from "zustand";

export type CanvasBackgroundPattern = "dots" | "grid";

const SCREENSHOT_DIRECTORY_STORAGE_KEY = "sigma:screenshot-directory";
const CANVAS_BACKGROUND_PATTERN_STORAGE_KEY = "sigma:canvas-background-pattern";
const CANVAS_BACKGROUND_PATTERNS = new Set<CanvasBackgroundPattern>([
  "dots",
  "grid",
]);

const getStoredScreenshotDirectory = () => {
  try {
    return localStorage.getItem(SCREENSHOT_DIRECTORY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};

const getStoredCanvasBackgroundPattern = (): CanvasBackgroundPattern => {
  try {
    const storedPattern = localStorage.getItem(
      CANVAS_BACKGROUND_PATTERN_STORAGE_KEY,
    );

    return CANVAS_BACKGROUND_PATTERNS.has(
      storedPattern as CanvasBackgroundPattern,
    )
      ? (storedPattern as CanvasBackgroundPattern)
      : "dots";
  } catch {
    return "dots";
  }
};

type SettingsStore = {
  isSettingsOpen: boolean;
  screenshotDirectory: string;
  canvasBackgroundPattern: CanvasBackgroundPattern;
  openSettings: () => void;
  closeSettings: () => void;
  setScreenshotDirectory: (directory: string) => void;
  setCanvasBackgroundPattern: (pattern: CanvasBackgroundPattern) => void;
  resetSettings: () => void;
};

const getInitialSettings = () => ({
  isSettingsOpen: false,
  screenshotDirectory: getStoredScreenshotDirectory(),
  canvasBackgroundPattern: getStoredCanvasBackgroundPattern(),
});

export const useSettingsStore = create<SettingsStore>((set) => ({
  ...getInitialSettings(),
  openSettings: () => set({ isSettingsOpen: true }),
  closeSettings: () => set({ isSettingsOpen: false }),
  setScreenshotDirectory: (directory) => {
    try {
      if (directory) {
        localStorage.setItem(SCREENSHOT_DIRECTORY_STORAGE_KEY, directory);
      } else {
        localStorage.removeItem(SCREENSHOT_DIRECTORY_STORAGE_KEY);
      }
    } catch {}

    set({ screenshotDirectory: directory });
  },
  setCanvasBackgroundPattern: (pattern) => {
    try {
      localStorage.setItem(CANVAS_BACKGROUND_PATTERN_STORAGE_KEY, pattern);
    } catch {}

    set({ canvasBackgroundPattern: pattern });
  },
  resetSettings: () => set(getInitialSettings()),
}));
