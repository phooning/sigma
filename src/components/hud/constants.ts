import type { SettingsMenuItem } from "../HudActions";

export const SETTINGS_PANEL_DESCRIPTIONS: Record<SettingsMenuItem, string> = {
  General: "Core workspace preferences and file locations.",
  Appearance: "Theme, canvas background, density, and visual preferences.",
  Hotkeys: "Keyboard and pointer shortcuts for canvas interaction.",
  Debug: "Diagnostics and development-only controls.",
  About: "Version and application details.",
};

export const HOTKEY_ROWS = [
  {
    keys: "F1",
    description: "Toggle development mode.",
  },
  {
    keys: "Ctrl/Cmd+S",
    description:
      "Save the current canvas configuration, or open Save As when no path is set.",
  },
  {
    keys: "Spacebar",
    description: "Toggle playback for selected videos.",
  },
  {
    keys: "Arrow Left / Arrow Right",
    description: "Scrub the selected video by 1 frame.",
  },
  {
    keys: "Shift+Arrow Left / Shift+Arrow Right",
    description: "Scrub the selected video by 10 frames.",
  },
  {
    keys: "Ctrl/Cmd+A",
    description: "Select every item on the canvas.",
  },
  {
    keys: "Delete/Backspace",
    description: "Delete the selected items.",
  },
  {
    keys: "Escape",
    description:
      "Clear the current selection and exit crop editing, or open settings when nothing is selected.",
  },
  {
    keys: "C",
    description: "Enter crop mode for the active selected item.",
  },
  {
    keys: "R",
    description: "Reset the active selected item to its default size.",
  },
] as const;
