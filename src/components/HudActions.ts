import packageJson from "../../package.json";
import { saveToStorage } from "../utils/fs";
import { MediaItem, Viewport } from "../utils/media.types";
import { notify } from "../utils/notifications";

export const SETTINGS_MENU_ITEMS = [
  "General",
  "Appearance",
  "Hotkeys",
  "Debug",
  "About",
] as const;

export type SettingsMenuItem = (typeof SETTINGS_MENU_ITEMS)[number];

export const appVersion = packageJson.version;

export const saveConfig = async ({
  items,
  viewport,
}: {
  items: MediaItem[];
  viewport: Viewport;
}) => {
  const result = await saveToStorage(items, viewport);

  if (!result.ok) {
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
};
