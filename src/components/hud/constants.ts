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
    keys: "Ctrl/Cmd+S",
    description: "Save the current canvas configuration.",
  },
  {
    keys: "Spacebar",
    description: "Pause selected videos.",
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
    description: "Clear the current selection and exit crop editing.",
  },
] as const;

