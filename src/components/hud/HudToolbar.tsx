import { useAudioPlaybackStore } from "@/stores/useAudioPlaybackStore";
import type { MediaItem } from "../../utils/media.types";
import { WindowControls } from "../WindowControls";
import { HudAudioControl } from "./HudAudioControl";
import { HudToolbarActions } from "./HudToolbarActions";
import { getMediaFileName } from "./utils";

type HudToolbarProps = {
  items: MediaItem[];
  saveConfig: () => void;
  canSaveConfig: boolean;
  saveAsConfig: () => void;
  loadConfig: () => void;
  clearCanvas: () => void;
  selectedVideoExportItem: MediaItem | null;
  selectedVideoExportCount: number;
  isExportingSelectedVideo: boolean;
  onSelectActiveAudioItem: () => void;
  onExportSelectedVideo: () => void;
};

export function HudToolbar({
  items,
  saveConfig,
  canSaveConfig,
  saveAsConfig,
  loadConfig,
  clearCanvas,
  selectedVideoExportItem,
  selectedVideoExportCount,
  isExportingSelectedVideo,
  onSelectActiveAudioItem,
  onExportSelectedVideo,
}: HudToolbarProps) {
  const activeAudioItemId = useAudioPlaybackStore((s) => s.activeItemId);
  const itemCountLabel = `${items.length} item${items.length === 1 ? "" : "s"}`;

  const activeAudioItem =
    activeAudioItemId === null
      ? null
      : (items.find(
          (item) => item.id === activeAudioItemId && item.type === "video",
        ) ?? null);
  const activeAudioName = activeAudioItem
    ? getMediaFileName(activeAudioItem.filePath)
    : "";

  return (
    <header
      className="ui-overlay"
      data-tauri-drag-region=""
      data-testid="app-header"
    >
      <div className="hud-leading">
        <HudToolbarActions
          saveConfig={saveConfig}
          canSaveConfig={canSaveConfig}
          saveAsConfig={saveAsConfig}
          loadConfig={loadConfig}
          clearCanvas={clearCanvas}
          hasItems={items.length > 0}
          selectedVideoExportItem={selectedVideoExportItem}
          selectedVideoExportCount={selectedVideoExportCount}
          isExportingSelectedVideo={isExportingSelectedVideo}
          onExportSelectedVideo={onExportSelectedVideo}
        />
      </div>

      <div className="toolbar">
        {activeAudioItem && (
          <HudAudioControl
            activeAudioItem={activeAudioItem}
            activeAudioName={activeAudioName}
            onSelectActiveAudioItem={onSelectActiveAudioItem}
          />
        )}

        <span className="item-count">{itemCountLabel}</span>
      </div>
      <WindowControls />
    </header>
  );
}
