import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  clearInvokeCalls,
  dropFiles,
  getInvokeCalls,
  gotoApp,
  loadCanvasConfig,
  mediaItems,
  setInvokeFailure,
  setOpenDialogResult,
  waitForAnimationFrames,
} from "./helpers";

const selectAllShortcut =
  process.platform === "darwin" ? "Meta+A" : "Control+A";

const videoFixturePath = path.resolve("fixtures/generated-lod-test-1080p.mp4");

async function waitForVideoPlaybackState(locator: Locator, paused: boolean) {
  await expect
    .poll(async () => {
      return locator.evaluate((node) => (node as HTMLVideoElement).paused);
    })
    .toBe(paused);
}

async function waitForVideoReady(locator: Locator) {
  await locator.evaluate(async (node) => {
    const video = node as HTMLVideoElement;
    if (video.readyState >= 2) return;

    await new Promise<void>((resolve) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
    });
  });
}

async function dispatchZoomWheel(page: Page, deltaY: number) {
  const container = page.locator(".canvas-container");
  const box = await container.boundingBox();
  if (!box) {
    throw new Error("Canvas container is not visible.");
  }

  await container.evaluate(
    (element, eventInit) => {
      element.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: eventInit.deltaY,
          clientX: eventInit.clientX,
          clientY: eventInit.clientY,
        }),
      );
    },
    {
      deltaY,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    },
  );
}

test("surfaces probe_media failures and still recovers to a playable video item", async ({
  page,
}) => {
  const failingPath = "/tmp/failing-probe.mp4";

  await gotoApp(page);
  await setInvokeFailure(page, "probe_media", {
    path: failingPath,
    message: "probe_media exploded",
  });

  await dropFiles(page, [failingPath]);

  await expect(page.getByText("Video metadata probe failed")).toBeVisible();
  await expect(
    page.getByText("Using fallback dimensions for failing-probe.mp4."),
  ).toBeVisible();
  await expect(page.getByText("1 items")).toBeVisible();
  await expect(page.locator("video.media-content")).toHaveCount(1);
});

test("upgrades image LOD requests as the user zooms in through real browser layout", async ({
  page,
}) => {
  await gotoApp(page, { disableNativeImageSurface: true });

  await loadCanvasConfig(page, {
    items: [
      {
        id: "lod-image",
        type: "image",
        filePath: "/tmp/lod-image.png",
        sourceWidth: 1920,
        sourceHeight: 1080,
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
      },
    ],
    viewport: { x: 0, y: 0, zoom: 0.15 },
  });

  const image = page.locator("img.media-content").first();
  await expect(image).toHaveClass(/image-lod-preview/);

  await expect
    .poll(async () => {
      const calls = await getInvokeCalls(page);
      return calls.some(
        (call) =>
          call.cmd === "request_decode" &&
          (call.args as { lod?: number }).lod === 256,
      );
    })
    .toBe(true);

  await clearInvokeCalls(page);
  await dispatchZoomWheel(page, -1800);
  await waitForAnimationFrames(page, 3);

  await expect
    .poll(async () => {
      const calls = await getInvokeCalls(page);
      return calls.some(
        (call) =>
          call.cmd === "request_decode" &&
          (call.args as { lod?: number }).lod === 1024,
      );
    })
    .toBe(true);
  await expect(page.getByText("1 items")).toBeVisible();
});

test("toggles a selected video's playback with the spacebar", async ({
  page,
}) => {
  await gotoApp(page);
  await dropFiles(page, [videoFixturePath]);

  const mediaItem = mediaItems(page).first();
  const video = page.locator("video.media-content").first();

  await waitForVideoReady(video);
  await waitForVideoPlaybackState(video, false);

  await mediaItem.click({ position: { x: 400, y: 200 } });
  await expect(mediaItem).toHaveClass(/selected/);

  await page.keyboard.press("Space");
  await waitForVideoPlaybackState(video, true);

  await page.keyboard.press("Space");
  await waitForVideoPlaybackState(video, false);
});

test("toggles playback for every selected video with the spacebar", async ({
  page,
}) => {
  await gotoApp(page);
  await loadCanvasConfig(page, {
    items: [
      {
        id: "video-a",
        type: "video",
        filePath: videoFixturePath,
        sourceWidth: 1920,
        sourceHeight: 1080,
        duration: 8,
        x: 0,
        y: 0,
        width: 640,
        height: 360,
      },
      {
        id: "video-b",
        type: "video",
        filePath: videoFixturePath,
        sourceWidth: 1920,
        sourceHeight: 1080,
        duration: 8,
        x: 720,
        y: 0,
        width: 640,
        height: 360,
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  });

  const videos = page.locator("video.media-content");
  await expect(videos).toHaveCount(2);
  await waitForVideoReady(videos.nth(0));
  await waitForVideoReady(videos.nth(1));
  await waitForAnimationFrames(page, 2);

  await expect
    .poll(async () =>
      videos.evaluateAll((nodes) =>
        nodes.every((node) => !(node as HTMLVideoElement).paused),
      ),
    )
    .toBe(true);

  await page.keyboard.press(selectAllShortcut);
  await expect(mediaItems(page).first()).toHaveClass(/selected/);
  await expect(mediaItems(page).nth(1)).toHaveClass(/selected/);

  await page.keyboard.press("Space");
  await expect
    .poll(async () =>
      videos.evaluateAll((nodes) =>
        nodes.every((node) => (node as HTMLVideoElement).paused),
      ),
    )
    .toBe(true);

  await page.keyboard.press("Space");
  await expect
    .poll(async () =>
      videos.evaluateAll((nodes) =>
        nodes.every((node) => !(node as HTMLVideoElement).paused),
      ),
    )
    .toBe(true);
});

test("does not delete a selected item while an editable element owns focus", async ({
  page,
}) => {
  await gotoApp(page);
  await dropFiles(page, ["/tmp/focus-guard.png"]);

  const mediaItem = mediaItems(page).first();
  await mediaItem.click({ position: { x: 400, y: 200 } });
  await expect(mediaItem).toHaveClass(/selected/);

  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "e2e-focus-guard";
    document.body.append(input);
    input.focus();
  });

  await page.keyboard.press("Backspace");
  await expect(page.getByText("1 items")).toBeVisible();

  await page.evaluate(() => {
    (
      document.getElementById("e2e-focus-guard") as HTMLInputElement | null
    )?.blur();
  });

  await page.keyboard.press("Delete");
  await expect(page.getByText("0 items")).toBeVisible();
});

test("passes a real non-zero currentTime when saving a video screenshot", async ({
  page,
}) => {
  await gotoApp(page);
  await setOpenDialogResult(page, "/tmp/screenshots");
  await dropFiles(page, [videoFixturePath]);

  const mediaItem = mediaItems(page).first();
  const video = page.locator("video.media-content").first();

  await waitForVideoReady(video);
  await mediaItem.click({ position: { x: 400, y: 200 } });
  await expect(mediaItem).toHaveClass(/selected/);

  await video.evaluate(async (node, targetTime) => {
    const videoElement = node as HTMLVideoElement;
    if (videoElement.readyState < 1) {
      await new Promise<void>((resolve) => {
        videoElement.addEventListener("loadedmetadata", () => resolve(), {
          once: true,
        });
      });
    }

    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        reject(new Error("Timed out waiting for video seek."));
      }, 5000);

      videoElement.addEventListener(
        "seeked",
        () => {
          window.clearTimeout(timeoutId);
          resolve();
        },
        { once: true },
      );

      videoElement.currentTime = targetTime;
    });
  }, 2.25);

  await clearInvokeCalls(page);
  await page.getByRole("button", { name: "Save screenshot" }).click();

  await expect(page.getByText("Screenshot saved")).toBeVisible();

  const calls = await getInvokeCalls(page);
  const screenshotCall = calls.find(
    (call) => call.cmd === "save_media_screenshot",
  );
  expect(screenshotCall).toBeTruthy();
  expect((screenshotCall?.args as { path?: string }).path).toBe(
    videoFixturePath,
  );
  expect(
    (screenshotCall?.args as { currentTime?: number }).currentTime ?? 0,
  ).toBeGreaterThan(2);
});

test("keeps playback aligned after dragging the playhead during active playback", async ({
  page,
}) => {
  await gotoApp(page);
  await dropFiles(page, [videoFixturePath]);

  const mediaItem = mediaItems(page).first();
  const video = page.locator("video.media-content").first();
  const timeline = page.getByRole("slider", { name: /video timeline/i });

  await waitForVideoReady(video);
  await waitForVideoPlaybackState(video, false);
  await mediaItem.click({ position: { x: 400, y: 200 } });
  await expect(mediaItem).toHaveClass(/selected/);
  await expect(timeline).toBeVisible();

  const box = await timeline.boundingBox();
  if (!box) {
    throw new Error("Video timeline is not visible.");
  }

  await expect
    .poll(async () =>
      video.evaluate((node) => (node as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(0.2);

  const duration = await video.evaluate(
    (node) => (node as HTMLVideoElement).duration,
  );
  const targetRatio = 0.65;
  const targetTime = duration * targetRatio;
  const y = box.y + box.height / 2;
  const startX = box.x + box.width * 0.2;
  const targetX = box.x + box.width * targetRatio;

  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(targetX, y, { steps: 8 });

  await expect
    .poll(async () =>
      Number((await timeline.getAttribute("aria-valuenow")) ?? "0"),
    )
    .toBeGreaterThan(targetTime - 0.4);

  await page.mouse.up();

  await expect
    .poll(async () =>
      video.evaluate((node) => (node as HTMLVideoElement).paused),
    )
    .toBe(false);

  await expect
    .poll(async () =>
      video.evaluate((node) => (node as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(targetTime - 0.5);

  const settledTime = await video.evaluate(
    (node) => (node as HTMLVideoElement).currentTime,
  );
  expect(settledTime).toBeGreaterThan(targetTime - 0.5);

  await waitForAnimationFrames(page, 12);

  await expect
    .poll(async () =>
      video.evaluate((node) => (node as HTMLVideoElement).currentTime),
    )
    .toBeGreaterThan(settledTime + 0.1);
});
