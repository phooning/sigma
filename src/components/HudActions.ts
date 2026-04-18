import { message } from "@tauri-apps/plugin-dialog";
import packageJson from "../../package.json";
import { saveToStorage } from "../utils/fs";
import { MediaItem, Viewport } from "../utils/media.types";

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
    await message(`Failed to save config:\n\n${text}`, {
      title: "Save failed",
      kind: "error",
    });
    return;
  }

  await message("Config saved successfully.", {
    title: "Save completed",
    kind: "info",
  });
};
