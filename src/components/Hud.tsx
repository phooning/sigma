import { HudToolbar } from "./hud/HudToolbar";
import { SettingsDialog } from "./hud/SettingsDialog";
import type { HudProps } from "./hud/types";

function Hud({
  items,
  saveConfig,
  loadConfig,
  settingsMenuItems,
  settingsVersion,
  selectedVideoExportItem,
  selectedVideoExportCount,
  isExportingSelectedVideo,
  onSelectActiveAudioItem,
  onExportSelectedVideo,
}: HudProps) {
  return (
    <>
      <HudToolbar
        items={items}
        saveConfig={saveConfig}
        loadConfig={loadConfig}
        selectedVideoExportItem={selectedVideoExportItem}
        selectedVideoExportCount={selectedVideoExportCount}
        isExportingSelectedVideo={isExportingSelectedVideo}
        onSelectActiveAudioItem={onSelectActiveAudioItem}
        onExportSelectedVideo={onExportSelectedVideo}
      />
      <SettingsDialog
        settingsMenuItems={settingsMenuItems}
        settingsVersion={settingsVersion}
      />
    </>
  );
}

export { Hud };
