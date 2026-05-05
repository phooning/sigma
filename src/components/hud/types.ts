import type { MediaItem } from "../../utils/media.types";
import type { SettingsMenuItem } from "../HudActions";

export type HudProps = {
  items: MediaItem[];
  saveConfig: () => void;
  canSaveConfig: boolean;
  saveAsConfig: () => void;
  loadConfig: () => void;
  clearCanvas: () => void;
  settingsMenuItems: readonly SettingsMenuItem[];
  settingsVersion: string;
  selectedVideoExportItem: MediaItem | null;
  selectedVideoExportCount: number;
  isExportingSelectedVideo: boolean;
  onSelectActiveAudioItem: () => void;
  onExportSelectedVideo: () => void;
};
