// Real-media browser tier: the production canvas renders real corpus clips
// (served by the Vite dev server) inside Chromium, so playback, seeking,
// visibility lifecycle, preview concurrency and canvas scaling run against
// real decoders. Driven by scripts/media/run-media-suite.ts through
// SIGMA_MEDIA_BROWSER_PLAN; skipped otherwise so `pnpm test:e2e` is unaffected.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { previewWorkloadFailure } from "../src/lib/media-corpus/gates";
import {
  gotoApp,
  itemCountLabel,
  loadCanvasConfig,
  type MediaCorpusMocks,
  startFrameSampler,
  stopFrameSampler,
  waitForAnimationFrames,
} from "./helpers";

type PlanAsset = {
  id: string;
  relativePath: string;
  path: string;
  url: string;
  probe: {
    width: number;
    height: number;
    duration: number;
    frameRate: number;
    size: number;
  };
};

type BrowserPlan = {
  assets: PlanAsset[];
  nodeCounts: number[];
  previewCounts: number[];
  cycles: number;
  outDir: string;
};

const planPath = process.env.SIGMA_MEDIA_BROWSER_PLAN;
const plan: BrowserPlan | null = planPath
  ? (JSON.parse(readFileSync(planPath, "utf8")) as BrowserPlan)
  : null;

const writeResult = (name: string, value: unknown) => {
  if (!plan) return;
  mkdirSync(plan.outDir, { recursive: true });
  writeFileSync(
    join(plan.outDir, `${name}.json`),
    JSON.stringify(value, null, 2),
  );
};

const mocksFor = (assets: PlanAsset[]): MediaCorpusMocks => ({
  urls: Object.fromEntries(assets.map((asset) => [asset.path, asset.url])),
  probes: Object.fromEntries(assets.map((asset) => [asset.path, asset.probe])),
});

const gridItems = (count: number, assets: PlanAsset[], width = 320) =>
  Array.from({ length: count }, (_, index) => {
    // Separate canvas references reuse the same physical files.
    const asset = assets[index % assets.length] as PlanAsset;
    const height = Math.round((asset.probe.height / asset.probe.width) * width);
    return {
      id: `corpus-node-${index}`,
      type: "video",
      filePath: asset.path,
      duration: asset.probe.duration,
      frameRate: asset.probe.frameRate,
      fileSize: asset.probe.size,
      sourceWidth: asset.probe.width,
      sourceHeight: asset.probe.height,
      x: (index % 10) * (width + 40),
      y: Math.floor(index / 10) * (Math.round(width * 1.8) + 40),
      width,
      height,
    };
  });

const cdpHeap = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const usage = (await cdp.send("Runtime.getHeapUsage")) as {
    usedSize: number;
  };
  await cdp.detach();
  return usage.usedSize;
};

/** Seeks the first rendered video and resolves with the seek latency. */
const seekVideo = (page: Page, index: number, target: number) =>
  page.evaluate(
    ({ index, target }) =>
      new Promise<{ ms: number; currentTime: number } | { error: string }>(
        (resolve) => {
          const video = document.querySelectorAll<HTMLVideoElement>(
            "video.media-content",
          )[index];
          if (!video) return resolve({ error: "no video element" });
          const started = performance.now();
          const timer = setTimeout(
            () => resolve({ error: `seek to ${target} timed out` }),
            15_000,
          );
          video.addEventListener(
            "seeked",
            () => {
              clearTimeout(timer);
              resolve({
                ms: performance.now() - started,
                currentTime: video.currentTime,
              });
            },
            { once: true },
          );
          video.currentTime = target;
        },
      ),
    { index, target },
  );

test.describe("real media corpus in the browser", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !plan,
    "SIGMA_MEDIA_BROWSER_PLAN not set (run pnpm test:media:full)",
  );

  test("[browser.playback] every asset becomes ready, plays, pauses and seeks accurately", async ({
    page,
  }) => {
    test.setTimeout(15 * 60_000);
    if (!plan) return;
    await gotoApp(page, { mediaCorpus: mocksFor(plan.assets) });
    const outcomes: Record<string, unknown> = {};
    const startup: number[] = [];
    const seeks: number[] = [];
    const failures: string[] = [];
    for (const asset of plan.assets) {
      await loadCanvasConfig(page, {
        items: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
      const [item] = gridItems(1, [asset], 640);
      const started = Date.now();
      await loadCanvasConfig(page, {
        items: [item],
        viewport: { x: 40, y: 40, zoom: 1 },
      });
      const ready = await page
        .waitForFunction(
          (url) => {
            const video = document.querySelector<HTMLVideoElement>(
              "video.media-content",
            );
            if (!video) return null;
            if (video.error) return { error: video.error.code };
            if (!decodeURI(video.currentSrc).endsWith(decodeURI(url)))
              return null;
            return video.readyState >= 2
              ? { readyState: video.readyState }
              : null;
          },
          asset.url,
          { timeout: 30_000 },
        )
        .then(
          (handle) =>
            handle.jsonValue() as Promise<{
              error?: number;
              readyState?: number;
            }>,
        )
        .catch(() => ({ error: -1 }));
      if (ready.error !== undefined) {
        // MEDIA_ERR_SRC_NOT_SUPPORTED (4) is a platform codec limitation.
        outcomes[asset.id] =
          ready.error === 4 ? "unsupported" : `error:${ready.error}`;
        if (ready.error !== 4)
          failures.push(`${asset.relativePath}: media error ${ready.error}`);
        continue;
      }
      startup.push(Date.now() - started);

      // Autoplay (muted) must advance time, and pausing must stop it.
      const advanced = await page
        .waitForFunction(
          () => {
            const video = document.querySelector<HTMLVideoElement>(
              "video.media-content",
            );
            return !!video && !video.paused && video.currentTime > 0.15;
          },
          undefined,
          { timeout: 15_000 },
        )
        .then(() => true)
        .catch(() => false);
      const paused = await page.evaluate(async () => {
        const video = document.querySelector<HTMLVideoElement>(
          "video.media-content",
        );
        if (!video) return false;
        video.pause();
        const at = video.currentTime;
        await new Promise((ok) => setTimeout(ok, 300));
        return video.paused && Math.abs(video.currentTime - at) < 1e-3;
      });

      const duration = asset.probe.duration;
      const targets = [0.05, duration / 2, Math.max(0, duration - 0.3)];
      const seekErrors: string[] = [];
      for (const target of targets) {
        const result = await seekVideo(page, 0, target);
        if ("error" in result) seekErrors.push(result.error);
        else {
          seeks.push(result.ms);
          // Browsers snap to frame boundaries; allow two frames of slack.
          const slack = 2 / (asset.probe.frameRate || 30) + 0.01;
          if (Math.abs(result.currentTime - target) > slack) {
            seekErrors.push(
              `seek ${target.toFixed(2)} landed at ${result.currentTime.toFixed(3)}`,
            );
          }
        }
      }
      // Rapid scrubbing: only the last of a burst of seeks may win.
      const scrub = await page.evaluate(async (duration) => {
        const video = document.querySelector<HTMLVideoElement>(
          "video.media-content",
        );
        if (!video) return { error: "no video" };
        const targets = Array.from(
          { length: 12 },
          (_, index) => (((index * 7) % 12) / 12) * duration * 0.9,
        );
        const last = duration * 0.37;
        for (const target of targets) video.currentTime = target;
        video.currentTime = last;
        await new Promise<void>((ok) => {
          const check = () => (video.seeking ? setTimeout(check, 20) : ok());
          check();
        });
        return { landed: video.currentTime, last };
      }, duration);
      if ("error" in scrub) seekErrors.push(String(scrub.error));
      else if (
        Math.abs(scrub.landed - scrub.last) >
        2 / (asset.probe.frameRate || 30) + 0.01
      ) {
        seekErrors.push(
          `scrub burst landed at ${scrub.landed.toFixed(3)} not ${scrub.last.toFixed(3)}`,
        );
      }
      const ok = advanced && paused && seekErrors.length === 0;
      outcomes[asset.id] = ok
        ? "ok"
        : `FAIL: advanced=${advanced} paused=${paused} ${seekErrors.join("; ")}`;
      if (!ok)
        failures.push(`${asset.relativePath}: ${String(outcomes[asset.id])}`);
    }
    writeResult("playback", {
      outcomes,
      startupMs: startup,
      seekMs: seeks,
      failures,
    });
    expect(failures).toEqual([]);
  });

  test("[browser.switching] rapid asset switching leaves the node bound to the last asset", async ({
    page,
  }) => {
    test.setTimeout(5 * 60_000);
    if (!plan) return;
    await gotoApp(page, { mediaCorpus: mocksFor(plan.assets) });
    const sequence = Array.from(
      { length: 12 },
      (_, index) => plan.assets[(index * 5) % plan.assets.length] as PlanAsset,
    );
    for (const asset of sequence) {
      const [item] = gridItems(1, [asset], 640);
      await loadCanvasConfig(page, {
        items: [item],
        viewport: { x: 40, y: 40, zoom: 1 },
      });
    }
    const last = sequence[sequence.length - 1] as PlanAsset;
    const bound = await page
      .waitForFunction(
        (url) => {
          const videos = document.querySelectorAll<HTMLVideoElement>(
            "video.media-content",
          );
          const video = videos[0];
          return (
            videos.length === 1 &&
            !!video &&
            decodeURI(video.currentSrc).endsWith(decodeURI(url)) &&
            video.readyState >= 2
          );
        },
        last.url,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    writeResult("switching", { switches: sequence.length, bound });
    expect(bound).toBe(true);
  });

  test("[browser.visibility] pauses offscreen previews and resumes them when visible", async ({
    page,
  }) => {
    test.setTimeout(5 * 60_000);
    if (!plan) return;
    await gotoApp(page, { mediaCorpus: mocksFor(plan.assets) });
    const items = gridItems(2, plan.assets, 480);
    await loadCanvasConfig(page, {
      items,
      viewport: { x: 40, y: 40, zoom: 1 },
    });
    const playing = () =>
      page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLVideoElement>("video.media-content"),
        ].map((video) => !video.paused),
      );
    await expect.poll(playing, { timeout: 30_000 }).toEqual([true, true]);
    // Pan both nodes far off screen.
    await loadCanvasConfig(page, {
      items,
      viewport: { x: -50_000, y: -50_000, zoom: 1 },
    });
    await expect
      .poll(async () => (await playing()).every((isPlaying) => !isPlaying), {
        timeout: 15_000,
      })
      .toBe(true);
    await loadCanvasConfig(page, {
      items,
      viewport: { x: 40, y: 40, zoom: 1 },
    });
    await expect.poll(playing, { timeout: 30_000 }).toEqual([true, true]);
    writeResult("visibility", { ok: true });
  });

  test("[browser.preview-concurrency] measures simultaneous visible previews", async ({
    page,
  }) => {
    test.setTimeout(10 * 60_000);
    if (!plan) return;
    await gotoApp(page, { mediaCorpus: mocksFor(plan.assets) });
    const levels: unknown[] = [];
    for (const count of plan.previewCounts) {
      // Sized so every preview fits in the 1600x1000 viewport at zoom 1.
      const columns = Math.ceil(Math.sqrt(count * 1.6));
      const width = Math.floor(1500 / columns) - 40;
      const items = gridItems(count, plan.assets, width).map((item, index) => ({
        ...item,
        x: (index % columns) * (width + 20),
        y: Math.floor(index / columns) * (Math.round(width * 0.6) + 20),
        height: Math.round(width * 0.5625),
      }));
      await loadCanvasConfig(page, {
        items,
        viewport: { x: 20, y: 20, zoom: 1 },
      });
      await page.waitForFunction(
        (count) =>
          [
            ...document.querySelectorAll<HTMLVideoElement>(
              "video.media-content",
            ),
          ].filter((video) => video.readyState >= 2).length >= count,
        count,
        { timeout: 60_000 },
      );
      await startFrameSampler(page);
      const before = await page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLVideoElement>("video.media-content"),
        ].map((video) => ({
          t: video.currentTime,
          q: (({ droppedVideoFrames, totalVideoFrames }) => ({
            droppedVideoFrames,
            totalVideoFrames,
          }))(video.getVideoPlaybackQuality()),
        })),
      );
      await page.waitForTimeout(2000);
      const after = await page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLVideoElement>("video.media-content"),
        ].map((video) => ({
          t: video.currentTime,
          paused: video.paused,
          ready: video.readyState,
          q: (({ droppedVideoFrames, totalVideoFrames }) => ({
            droppedVideoFrames,
            totalVideoFrames,
          }))(video.getVideoPlaybackQuality()),
        })),
      );
      const sampler = await stopFrameSampler(page);
      const advancing = after.filter(
        (entry, index) =>
          entry.q.totalVideoFrames > (before[index]?.q.totalVideoFrames ?? 0),
      ).length;
      const dropped = after.reduce(
        (sum, entry, index) =>
          sum +
          entry.q.droppedVideoFrames -
          (before[index]?.q.droppedVideoFrames ?? 0),
        0,
      );
      const total = after.reduce(
        (sum, entry, index) =>
          sum +
          entry.q.totalVideoFrames -
          (before[index]?.q.totalVideoFrames ?? 0),
        0,
      );
      const failure = previewWorkloadFailure({
        count,
        mounted: after.length,
        advancing,
        totalFrames: total,
      });
      expect(failure, `preview workload at concurrency ${count}`).toBeNull();
      levels.push({
        count,
        mounted: after.length,
        advancing,
        droppedFrames: dropped,
        totalFrames: total,
        frameDeltas: sampler.frameDeltas,
        longTasks: sampler.longTasks,
      });
    }
    writeResult("preview-concurrency", { levels });
  });

  test("[browser.scaling] measures pan frame time as node count grows", async ({
    page,
  }) => {
    test.setTimeout(15 * 60_000);
    if (!plan) return;
    await gotoApp(page, { mediaCorpus: mocksFor(plan.assets) });
    const results: unknown[] = [];
    for (const count of plan.nodeCounts) {
      const items = gridItems(count, plan.assets, 320);
      const loaded = await loadCanvasConfig(page, {
        items,
        viewport: { x: 0, y: 0, zoom: 1 },
      });
      await expect(page.locator(".ui-overlay .item-count")).toHaveText(
        itemCountLabel(count),
      );
      await waitForAnimationFrames(page, 10);
      await page.mouse.move(800, 500);
      await startFrameSampler(page);
      for (let step = 0; step < 60; step += 1) {
        await page.mouse.wheel(step % 2 === 0 ? 24 : -12, 16);
        await waitForAnimationFrames(page, 1);
      }
      const sampler = await stopFrameSampler(page);
      const mounted = await page.evaluate(() => ({
        videos: document.querySelectorAll("video.media-content").length,
        playing: [
          ...document.querySelectorAll<HTMLVideoElement>("video.media-content"),
        ].filter((video) => !video.paused).length,
      }));
      results.push({
        count,
        loadMs: loaded.loadMs,
        heapBytes: await cdpHeap(page),
        ...mounted,
        frameDeltas: sampler.frameDeltas,
        longTasks: sampler.longTasks,
      });
    }
    writeResult("scaling", { results });
  });

  test("[browser.lifecycle] releases previews across repeated workspace load/unload cycles", async ({
    page,
  }) => {
    test.setTimeout(15 * 60_000);
    if (!plan) return;
    await gotoApp(page, { mediaCorpus: mocksFor(plan.assets) });
    const retained: number[] = [];
    const leftovers: number[] = [];
    const items = gridItems(plan.assets.length, plan.assets, 320);
    for (let cycle = 0; cycle < plan.cycles; cycle += 1) {
      await loadCanvasConfig(page, {
        items,
        viewport: { x: 0, y: 0, zoom: 1 },
      });
      await page
        .waitForFunction(
          () =>
            [
              ...document.querySelectorAll<HTMLVideoElement>(
                "video.media-content",
              ),
            ].some((video) => video.readyState >= 1),
          undefined,
          { timeout: 30_000 },
        )
        .catch(() => undefined);
      await waitForAnimationFrames(page, 5);
      await loadCanvasConfig(page, {
        items: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
      leftovers.push(
        await page.evaluate(() => document.querySelectorAll("video").length),
      );
      retained.push(await cdpHeap(page));
    }
    writeResult("lifecycle", {
      cycles: plan.cycles,
      retainedHeapBytes: retained,
      leftoverVideoElements: leftovers,
    });
    expect(leftovers.every((count) => count === 0)).toBe(true);
  });
});
