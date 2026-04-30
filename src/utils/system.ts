import { platform } from "@tauri-apps/plugin-os";

export const isMacOS = () =>
  /mac/i.test(navigator.platform) || navigator.userAgent.includes("Macintosh");

const isLinux = platform() === "linux";

export const isWayland =
  isLinux &&
  window.matchMedia("(display-mode: window-controls-overlay)").matches ===
    false &&
  navigator.userAgent.includes("Wayland");
