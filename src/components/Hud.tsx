import { useState } from "react";
import type { MediaItem } from "../utils/media.types";
import type { SettingsMenuItem } from "./HudActions";
import { useDevStore } from "../stores/useDevStore";
import { Button } from "./ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "./ui/field";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { Switch } from "./ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export interface ISelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

const SETTINGS_PANEL_DESCRIPTIONS: Record<SettingsMenuItem, string> = {
  General: "Core workspace preferences and file locations.",
  Appearance: "Theme, canvas background, density, and visual preferences.",
  Hotkeys: "Keyboard and pointer shortcuts for canvas interaction.",
  Debug: "Diagnostics and development-only controls.",
  About: "Version and application details.",
};

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
  const { devMode, toggleDevMode } = useDevStore();

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

      <Dialog
        open={isSettingsOpen}
        onOpenChange={(open) => {
          if (open) {
            openSettings();
            return;
          }

          closeSettings();
        }}
      >
        <DialogContent
          className="flex h-[min(38.75rem,calc(100dvh-3rem))] min-h-0 w-[min(57.5rem,calc(100dvw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>
              Tune the canvas, media, interaction, and development controls.
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={activeSettingsMenuItem}
            onValueChange={(value) =>
              setActiveSettingsMenuItem(value as SettingsMenuItem)
            }
            orientation="vertical"
            className="min-h-0 flex-1 gap-0 md:flex-row"
          >
            <aside className="flex border-b bg-muted/30 p-3 md:w-[var(--settings-sidebar-width)] md:flex-col md:border-r md:border-b-0">
              <ScrollArea className="min-w-0 flex-1">
                <TabsList className="h-auto w-full flex-row justify-start gap-1 bg-transparent p-0 md:flex-col">
                  {settingsMenuItems.map((menuItem) => (
                    <TabsTrigger
                      key={menuItem}
                      value={menuItem}
                      onClick={() => setActiveSettingsMenuItem(menuItem)}
                      className="min-h-8 justify-start px-3"
                    >
                      {menuItem}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </ScrollArea>
              <Separator className="my-3 hidden md:block" />
              <p className="hidden px-3 text-xs font-medium text-muted-foreground md:block">
                Version {settingsVersion}
              </p>
            </aside>

            <ScrollArea className="min-h-0 flex-1">
              <div className="p-5 md:p-7">
                {settingsMenuItems.map((menuItem) => (
                  <TabsContent key={menuItem} value={menuItem} className="m-0">
                    <Card>
                      <CardHeader>
                        <CardTitle>{menuItem}</CardTitle>
                        <CardDescription>
                          {SETTINGS_PANEL_DESCRIPTIONS[menuItem]}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {menuItem === "General" ? (
                          <FieldGroup>
                            <Field orientation="responsive">
                              <FieldContent>
                                <FieldLabel>Screenshot Directory</FieldLabel>
                                <FieldDescription className="truncate">
                                  {screenshotDirectory ||
                                    "Choose a folder before the first screenshot."}
                                </FieldDescription>
                              </FieldContent>
                              <div className="flex shrink-0 gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={chooseScreenshotDirectory}
                                >
                                  Choose
                                </Button>
                                {screenshotDirectory ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={clearScreenshotDirectory}
                                  >
                                    Clear
                                  </Button>
                                ) : null}
                              </div>
                            </Field>
                          </FieldGroup>
                        ) : null}

                        {menuItem === "Debug" ? (
                          <FieldGroup>
                            <Field orientation="horizontal">
                              <FieldContent>
                                <FieldLabel htmlFor="development-mode">
                                  Development Mode
                                </FieldLabel>
                                <FieldDescription>
                                  Show development diagnostics while working on
                                  the canvas.
                                </FieldDescription>
                              </FieldContent>
                              <Switch
                                id="development-mode"
                                checked={devMode}
                                onCheckedChange={toggleDevMode}
                              />
                            </Field>
                          </FieldGroup>
                        ) : null}

                        {menuItem === "About" ? (
                          <FieldGroup>
                            <Field>
                              <FieldTitle>
                                Developed with daily use and passion for
                                usability and performance.
                              </FieldTitle>
                              <FieldDescription>
                                <a
                                  href="https://github.com/phooning/sigma"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-medium text-primary underline underline-offset-4"
                                >
                                  GitHub source code
                                </a>
                              </FieldDescription>
                            </Field>

                            <p className="mt-4 text-sm text-muted-foreground">
                              SIGMA Media Canvas: Community Version
                            </p>
                          </FieldGroup>
                        ) : null}
                      </CardContent>
                    </Card>
                  </TabsContent>
                ))}
              </div>
            </ScrollArea>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  );
};

export { Hud };
