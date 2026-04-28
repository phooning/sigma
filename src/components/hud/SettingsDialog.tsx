import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useDevStore } from "../../stores/useDevStore";
import {
  type CanvasBackgroundPattern,
  useSettingsStore,
} from "../../stores/useSettingsStore";
import type { SettingsMenuItem } from "../HudActions";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { SETTINGS_PANEL_DESCRIPTIONS } from "./constants";
import { AboutSettings } from "./settings/AboutSettings";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { DebugSettings } from "./settings/DebugSettings";
import { GeneralSettings } from "./settings/GeneralSettings";
import { HotkeysSettings } from "./settings/HotkeysSettings";

type SettingsDialogProps = {
  settingsMenuItems: readonly SettingsMenuItem[];
  settingsVersion: string;
};

export function SettingsDialog({
  settingsMenuItems,
  settingsVersion,
}: SettingsDialogProps) {
  const [activeSettingsMenuItem, setActiveSettingsMenuItem] =
    useState<SettingsMenuItem>(settingsMenuItems[0]);
  const { devMode, toggleDevMode } = useDevStore();
  const isSettingsOpen = useSettingsStore((state) => state.isSettingsOpen);
  const screenshotDirectory = useSettingsStore(
    (state) => state.screenshotDirectory,
  );
  const canvasBackgroundPattern = useSettingsStore(
    (state) => state.canvasBackgroundPattern,
  );
  const openSettings = useSettingsStore((state) => state.openSettings);
  const closeSettings = useSettingsStore((state) => state.closeSettings);
  const setScreenshotDirectory = useSettingsStore(
    (state) => state.setScreenshotDirectory,
  );
  const setCanvasBackgroundPattern = useSettingsStore(
    (state) => state.setCanvasBackgroundPattern,
  );

  const chooseScreenshotDirectory = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose screenshot directory",
      defaultPath: screenshotDirectory || undefined,
    });

    if (typeof selected === "string") {
      setScreenshotDirectory(selected);
    }
  };

  const renderSettingsPanel = (menuItem: SettingsMenuItem) => {
    switch (menuItem) {
      case "General":
        return (
          <GeneralSettings
            screenshotDirectory={screenshotDirectory}
            onChooseScreenshotDirectory={chooseScreenshotDirectory}
            onClearScreenshotDirectory={() => setScreenshotDirectory("")}
          />
        );
      case "Appearance":
        return (
          <AppearanceSettings
            canvasBackgroundPattern={canvasBackgroundPattern}
            onCanvasBackgroundPatternChange={(value: CanvasBackgroundPattern) =>
              setCanvasBackgroundPattern(value)
            }
          />
        );
      case "Hotkeys":
        return <HotkeysSettings />;
      case "Debug":
        return (
          <DebugSettings devMode={devMode} onToggleDevMode={toggleDevMode} />
        );
      case "About":
        return <AboutSettings />;
    }
  };

  return (
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
                    <CardContent>{renderSettingsPanel(menuItem)}</CardContent>
                  </Card>
                </TabsContent>
              ))}
            </div>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
