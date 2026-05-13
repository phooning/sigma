import { expect, test } from "@playwright/test";
import {
  gotoApp,
  itemCountLabel,
  openSettings,
  seedCanvasItems,
} from "./helpers";

test("opens the settings dialog from the HUD and closes it with Escape", async ({
  page,
}) => {
  await gotoApp(page);
  await openSettings(page);

  await expect(page.getByRole("tab", { name: "General" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Appearance" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Hotkeys" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Debug" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "About" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
});

test("uses the HUD as the draggable header and keeps its buttons non-draggable", async ({
  page,
}) => {
  await gotoApp(page);

  const header = page.getByTestId("app-header");
  const controls = page.getByRole("toolbar", { name: "Canvas controls" });
  const buttons = controls.getByRole("button");

  await expect(header).toHaveAttribute("data-tauri-drag-region", "");
  await expect(buttons).toHaveCount(5);
  await expect(buttons).toHaveText(["", "Clear", "Load", "", "Save"]);
  await expect(buttons.nth(0)).toHaveAttribute("aria-label", "Open settings");
  await expect(buttons.nth(3)).toHaveAttribute("aria-label", "Save As");
  for (const index of [0, 1, 2, 3, 4]) {
    await expect(buttons.nth(index)).toHaveAttribute(
      "data-tauri-drag-region",
      "false",
    );
  }
});

test("uses singular and plural item-count labels in the HUD", async ({
  page,
}) => {
  await gotoApp(page);
  await expect(page.locator(".ui-overlay .item-count").first()).toHaveText(
    itemCountLabel(0),
  );

  await seedCanvasItems(page, 1, "image");
  await expect(page.locator(".ui-overlay .item-count").first()).toHaveText(
    itemCountLabel(1),
  );
});

test("persists the selected canvas background pattern across reloads", async ({
  page,
}) => {
  await gotoApp(page);
  await openSettings(page);

  await page.getByRole("tab", { name: "Appearance" }).click();
  await page.getByRole("radio", { name: "Grid background" }).click();

  await expect(page.locator(".canvas-background.grid")).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".ui-overlay .item-count")).toHaveText("0 items");

  await expect(page.locator(".canvas-background.grid")).toBeVisible();
  await openSettings(page);
  await page.getByRole("tab", { name: "Appearance" }).click();
  await expect(
    page.getByRole("radio", { name: "Grid background" }),
  ).toHaveAttribute("data-state", "on");
});

test("shows the development overlay when debug mode is enabled", async ({
  page,
}) => {
  await gotoApp(page);
  await openSettings(page);

  await page.getByRole("tab", { name: "Debug" }).click();
  await page.getByRole("switch", { name: /development mode/i }).click();

  await expect(page.getByLabel("Development stats")).toBeVisible();
  await expect(page.getByText("FPS")).toBeVisible();
  await expect(page.getByText("CPU frame time")).toBeVisible();
  await expect(page.getByText("Rust backend frame/update time")).toBeVisible();
  await expect(page.getByText("GPU usage")).toBeVisible();
});

test("renders a minimap summary after media is loaded", async ({ page }) => {
  await gotoApp(page);
  await seedCanvasItems(page, 6, "image");

  const minimap = page.locator(".canvas-minimap");
  const canvas = page.locator(".canvas-minimap__canvas");

  await expect(minimap).toBeVisible();
  await expect(minimap.locator(".canvas-minimap__label")).toHaveText("1.00x");
  await expect(minimap.locator(".canvas-minimap__count")).toHaveText(
    "0 of 6 selected",
  );
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveCSS("width", "220px");
  await expect(canvas).toHaveCSS("height", "160px");
});
