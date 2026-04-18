import { useEffect, useRef, useState } from "react";
import type { MediaItem } from "../utils/media.types";
import type { SettingsMenuItem } from "./HudActions";
import { useDevStore } from "../stores/useDevStore";

export interface ISelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

const Hud = ({
  items,
  saveConfig,
  loadConfig,
  settingsMenuItems,
  settingsVersion,
  screenshotDirectory,
  chooseScreenshotDirectory,
  clearScreenshotDirectory,
  isSettingsOpen,
  openSettings,
  closeSettings,
}: {
  items: MediaItem[];
  saveConfig: () => void;
  loadConfig: () => void;
  settingsMenuItems: readonly SettingsMenuItem[];
  settingsVersion: string;
  screenshotDirectory: string;
  chooseScreenshotDirectory: () => void;
  clearScreenshotDirectory: () => void;
  isSettingsOpen: boolean;
  openSettings: () => void;
  closeSettings: () => void;
}) => {
  const [activeSettingsMenuItem, setActiveSettingsMenuItem] =
    useState<SettingsMenuItem>(settingsMenuItems[0]);
  const settingsDialogRef = useRef<HTMLDivElement>(null);
  const { devMode, toggleDevMode } = useDevStore();

  useEffect(() => {
    if (isSettingsOpen) {
      settingsDialogRef.current?.focus();
    }
  }, [isSettingsOpen]);

  return (
    <>
      <div className="ui-overlay">
        <div className="hud-title">SIGMA Media Canvas</div>

        <div className="toolbar">
          <button className="hud-btn" onClick={saveConfig}>
            <svg
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
          <button className="hud-btn" onClick={loadConfig}>
            <svg
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

          <span className="item-count">{items.length} items</span>
        </div>
      </div>

      {isSettingsOpen ? (
        <div
          className="settings-modal-backdrop"
          onPointerDown={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget) {
              closeSettings();
            }
          }}
          onWheel={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <div
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            ref={settingsDialogRef}
            tabIndex={-1}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeSettings();
              }
            }}
          >
            <div className="settings-modal-header">
              <h2 id="settings-title">Settings</h2>
              <button
                className="settings-close-btn"
                onClick={closeSettings}
                aria-label="Close settings"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>

            <div className="settings-modal-body">
              <aside className="settings-sidebar" aria-label="Settings menu">
                <nav className="settings-nav">
                  {settingsMenuItems.map((menuItem) => (
                    <button
                      key={menuItem}
                      className={`settings-nav-item ${
                        activeSettingsMenuItem === menuItem ? "active" : ""
                      }`}
                      onClick={() => setActiveSettingsMenuItem(menuItem)}
                      aria-pressed={activeSettingsMenuItem === menuItem}
                    >
                      {menuItem}
                    </button>
                  ))}
                </nav>
                <div className="settings-version">Version {settingsVersion}</div>
              </aside>

              <section
                className="settings-panel"
                aria-labelledby="settings-panel-title"
              >
                <h3 id="settings-panel-title">{activeSettingsMenuItem}</h3>
                {activeSettingsMenuItem === "General" ? (
                  <div className="settings-field-row">
                    <div className="settings-field-copy">
                      <span>Screenshot Directory</span>
                      <small>
                        {screenshotDirectory ||
                          "Choose a folder before the first screenshot."}
                      </small>
                    </div>
                    <div className="settings-field-actions">
                      <button
                        type="button"
                        className="settings-action-btn"
                        onClick={chooseScreenshotDirectory}
                      >
                        Choose
                      </button>
                      {screenshotDirectory ? (
                        <button
                          type="button"
                          className="settings-action-btn"
                          onClick={clearScreenshotDirectory}
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {activeSettingsMenuItem === "Debug" ? (
                  <label className="settings-toggle-row">
                    <span>Development Mode</span>
                    <input
                      type="checkbox"
                      checked={devMode}
                      onChange={toggleDevMode}
                    />
                  </label>
                ) : null}
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};

export { Hud };
