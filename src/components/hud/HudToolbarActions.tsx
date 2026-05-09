import { useSettingsStore } from "../../stores/useSettingsStore";
import type { MediaItem } from "../../utils/media.types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { getMediaFileName } from "./utils";

function ActionTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

type HudToolbarActionsProps = {
  saveConfig: () => void;
  canSaveConfig: boolean;
  saveAsConfig: () => void;
  loadConfig: () => void;
  clearCanvas: () => void;
  hasItems: boolean;
  selectedVideoExportItem: MediaItem | null;
  selectedVideoExportCount: number;
  isExportingSelectedVideo: boolean;
  onExportSelectedVideo: () => void;
};

export function HudToolbarActions({
  saveConfig,
  canSaveConfig,
  saveAsConfig,
  loadConfig,
  clearCanvas,
  hasItems,
  selectedVideoExportItem,
  selectedVideoExportCount,
  isExportingSelectedVideo,
  onExportSelectedVideo,
}: HudToolbarActionsProps) {
  const openSettings = useSettingsStore((state) => state.openSettings);
  const selectedVideoExportName = selectedVideoExportItem
    ? getMediaFileName(selectedVideoExportItem.filePath)
    : "";
  const isExportDisabled =
    isExportingSelectedVideo || selectedVideoExportCount !== 1;
  const exportTitle =
    selectedVideoExportCount > 1
      ? "Select one video to export"
      : selectedVideoExportName
        ? `Export ${selectedVideoExportName}`
        : "Export selected video";

  return (
    <TooltipProvider delayDuration={0} skipDelayDuration={0}>
      <div className="hud-btn-cluster">
        <button
          type="button"
          className="hud-btn"
          onClick={saveConfig}
          disabled={!canSaveConfig}
        >
          <svg
            aria-hidden="true"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>{" "}
          Save
        </button>
        <ActionTooltip label="Save As">
          <button
            type="button"
            className="hud-btn hud-icon-btn"
            onClick={saveAsConfig}
            aria-label="Save As"
          >
            <svg
              aria-hidden="true"
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 10l5-5 5 5" />
              <path d="M12 15V5" />
            </svg>
          </button>
        </ActionTooltip>
      </div>
      <button type="button" className="hud-btn" onClick={loadConfig}>
        <svg
          aria-hidden="true"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 15v4c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-4M17 9l-5 5-5-5M12 12.8V2.5" />
        </svg>{" "}
        Load
      </button>
      <button
        type="button"
        className="hud-btn hud-btn-destructive"
        onClick={clearCanvas}
        disabled={!hasItems}
      >
        <svg
          aria-hidden="true"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 6h18" />
          <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
        </svg>{" "}
        Clear
      </button>
      {selectedVideoExportCount > 0 && (
        <button
          type="button"
          className="hud-btn"
          onClick={onExportSelectedVideo}
          disabled={isExportDisabled}
          aria-label="Export selected video"
          title={exportTitle}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>{" "}
          {isExportingSelectedVideo ? "Exporting" : "Export"}
        </button>
      )}
      <button
        type="button"
        className="hud-btn hud-icon-btn"
        onClick={openSettings}
        aria-label="Open settings"
        title="Settings"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 8a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 16 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.4.6.7 1 .9.3.1.7.1 1.1.1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>
    </TooltipProvider>
  );
}
