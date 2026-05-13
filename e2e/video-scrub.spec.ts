import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { dropFiles, gotoApp, waitForAnimationFrames } from "./helpers";

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

test("keeps a selected video paused while arrow-key frame scrubbing", async ({
  page,
}) => {
  await gotoApp(page);
  await dropFiles(page, [videoFixturePath]);

  const mediaItem = page.locator(".media-item").first();
  await expect(mediaItem).toBeVisible();
  await mediaItem.click();

  const video = mediaItem.locator("video");
  await waitForVideoReady(video);
  await waitForVideoPlaybackState(video, false);

  await page.keyboard.press("Space");
  await waitForVideoPlaybackState(video, true);

  const pausedTime = await video.evaluate((node) => {
    return (node as HTMLVideoElement).currentTime;
  });

  await page.keyboard.press("ArrowRight");
  await waitForAnimationFrames(page, 4);
  await waitForVideoPlaybackState(video, true);

  const scrubbedTime = await video.evaluate((node) => {
    return (node as HTMLVideoElement).currentTime;
  });
  expect(scrubbedTime).toBeGreaterThan(pausedTime);

  await page.waitForTimeout(150);
  await waitForAnimationFrames(page, 4);
  await waitForVideoPlaybackState(video, true);

  const settledTime = await video.evaluate((node) => {
    return (node as HTMLVideoElement).currentTime;
  });
  expect(settledTime).toBeCloseTo(scrubbedTime, 3);
});
