import packageJson from "../../package.json";

export const SETTINGS_MENU_ITEMS = [
  "General",
  "Appearance",
  "Hotkeys",
  "Debug",
  "About",
] as const;

export type SettingsMenuItem = (typeof SETTINGS_MENU_ITEMS)[number];

export const appVersion = packageJson.version;
