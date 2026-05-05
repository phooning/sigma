import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  clearInvokeCalls,
  dropFiles,
  getInvokeCalls,
  gotoApp,
  mediaItems,
  setOpenDialogResult,
  setSaveDialogResult,
} from "./helpers";

const savedCanvasPath = "/tmp/playwright-canvas-save-state.json";
const droppedVideoPath = "/tmp/playwright-save-state-video.mp4";

const saveButton = (page: Page) =>
  page.getByRole("button", { name: "Save", exact: true });

const saveAsButton = (page: Page) =>
  page.getByRole("button", { name: "Save As", exact: true });

const loadButton = (page: Page) =>
  page.getByRole("button", { name: "Load", exact: true });

async function saveCanvasAs(page: Page, filePath = savedCanvasPath) {
  await setSaveDialogResult(page, filePath);
  await saveAsButton(page).click();
  await expect(page.getByText("Save completed")).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();
}

async function createSavedVideoCanvas(page: Page, filePath = savedCanvasPath) {
  await gotoApp(page);
  await dropFiles(page, [droppedVideoPath]);

  await expect(page.getByText("1 items")).toBeVisible();
  await expect(mediaItems(page)).toHaveCount(1);

  await saveCanvasAs(page, filePath);
}

async function panCanvas(page: Page, dx: number, dy: number) {
  const container = page.locator(".canvas-container");
  const box = await container.boundingBox();
  if (!box) {
    throw new Error("Canvas container is not visible.");
  }

  const startX = box.x + 220;
  const startY = box.y + 220;
  await page.mouse.move(startX, startY);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(startX + dx, startY + dy, { steps: 5 });
  await page.mouse.up({ button: "middle" });
}

async function moveFirstMediaItem(page: Page, dx: number, dy: number) {
  const mediaItem = mediaItems(page).first();
  const box = await mediaItem.boundingBox();
  if (!box) {
    throw new Error("Expected one visible media item to drag.");
  }

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 5 });
  await page.mouse.up();
}

async function readMediaItemPosition(locator: Locator) {
  return locator.evaluate((node) => {
    const element = node as HTMLElement;
    return {
      left: element.style.left,
      top: element.style.top,
    };
  });
}

test.describe("canvas save states", () => {
  test("disables Save after saving a newly placed video with Save As", async ({
    page,
  }) => {
    await createSavedVideoCanvas(page);

    await expect(saveButton(page)).toBeDisabled();
  });

  test("keeps Save disabled after moving only the viewport", async ({
    page,
  }) => {
    await createSavedVideoCanvas(page);

    await expect(saveButton(page)).toBeDisabled();
    await panCanvas(page, 120, 90);

    await expect(saveButton(page)).toBeDisabled();
  });

  test("enables Save after moving an asset item and disables it again after quick save", async ({
    page,
  }) => {
    await createSavedVideoCanvas(page);

    await clearInvokeCalls(page);
    await moveFirstMediaItem(page, 180, 120);

    await expect(saveButton(page)).toBeEnabled();

    await saveButton(page).click();
    await expect(saveButton(page)).toBeDisabled();

    await expect
      .poll(async () => {
        const calls = await getInvokeCalls(page);
        return {
          openedSaveDialog: calls.some(
            (call) => call.cmd === "plugin:dialog|save",
          ),
          wroteCanvasFile: calls.some(
            (call) => call.cmd === "plugin:fs|write_text_file",
          ),
        };
      })
      .toEqual({
        openedSaveDialog: false,
        wroteCanvasFile: true,
      });
  });

  test("restores the saved asset after clearing the canvas and loading the saved file", async ({
    page,
  }) => {
    await createSavedVideoCanvas(page);

    await moveFirstMediaItem(page, 140, 100);
    await expect(saveButton(page)).toBeEnabled();
    const movedPosition = await readMediaItemPosition(mediaItems(page).first());

    await saveButton(page).click();
    await expect(saveButton(page)).toBeDisabled();

    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByText("0 items")).toBeVisible();
    await expect(mediaItems(page)).toHaveCount(0);

    await setOpenDialogResult(page, savedCanvasPath);
    await loadButton(page).click();

    const restoredItem = mediaItems(page).first();
    await expect(page.getByText("1 items")).toBeVisible();
    await expect(restoredItem).toBeVisible();
    await expect(await readMediaItemPosition(restoredItem)).toEqual(
      movedPosition,
    );
  });
});
