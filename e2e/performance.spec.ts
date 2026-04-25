import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  deleteAllItems,
  dropFiles,
  gotoApp,
  mediaItems,
  seedCanvasItems,
  startFrameSampler,
  stopFrameSampler,
  waitForAnimationFrames,
  type FrameSamplerResult,
} from './helpers';

type TransformLatencyResult = {
  changed: boolean;
  latencyMs: number | null;
  mutationCount: number;
  transform: string;
};

type FrameBudgetSummary = {
  averageFrameMs: number;
  fps: number;
  frameCount: number;
  jankLongTasks: number;
  longTaskDurations: number[];
  maxFrameMs: number;
  observationMs: number;
  p50FrameMs: number;
  p99FrameMs: number;
};

type ScalabilityMetric = FrameBudgetSummary & {
  count: number;
  kind: 'image' | 'deferredVideo';
  loadMs: number;
};

test.describe('canvas performance', () => {
  test.describe.configure({ mode: 'serial' });

  test('tracks frame timing while dragging a media item under interaction load', async (
    { page },
    testInfo,
  ) => {
    test.slow();

    await gotoApp(page);
    await seedCanvasItems(page, 200, 'image');

    const mediaItem = mediaItems(page).first();
    const box = await mediaItem.boundingBox();
    if (!box) {
      throw new Error('Expected at least one visible media item to drag.');
    }

    await startFrameSampler(page);
    await page.evaluate(
      async ({ startX, startY, endX, endY }) => {
        const container = document.querySelector('.canvas-container');
        const item = document.querySelector('.media-item');

        if (!(container instanceof HTMLDivElement) || !(item instanceof HTMLDivElement)) {
          throw new Error('Canvas drag targets were not found.');
        }

        const noop = () => {};
        const originalSetPointerCapture = container.setPointerCapture.bind(container);
        const originalReleasePointerCapture =
          container.releasePointerCapture.bind(container);

        container.setPointerCapture = noop;
        container.releasePointerCapture = noop;

        item.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            buttons: 1,
            clientX: startX,
            clientY: startY,
            pointerId: 1,
          }),
        );

        for (let index = 1; index <= 140; index += 1) {
          const progress = index / 140;
          container.dispatchEvent(
            new PointerEvent('pointermove', {
              bubbles: true,
              button: 0,
              buttons: 1,
              clientX: startX + (endX - startX) * progress,
              clientY: startY + (endY - startY) * progress,
              pointerId: 1,
            }),
          );
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }

        container.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            buttons: 0,
            clientX: endX,
            clientY: endY,
            pointerId: 1,
          }),
        );

        container.setPointerCapture = originalSetPointerCapture;
        container.releasePointerCapture = originalReleasePointerCapture;
      },
      {
        startX: box.x + box.width / 2,
        startY: box.y + box.height / 2,
        endX: box.x + box.width / 2 + 520,
        endY: box.y + box.height / 2 + 260,
      },
    );

    await waitForAnimationFrames(page, 2);

    const summary = summarizeFrameSampler(await stopFrameSampler(page));
    await attachJson(testInfo, 'drag-frame-budget', summary);

    expect(summary.frameCount).toBeGreaterThan(20);
    expect(summary.p50FrameMs).toBeLessThan(33.4);
    expect(summary.maxFrameMs).toBeLessThan(100);
    expect(summary.jankLongTasks).toBeLessThan(10);
  });

  test('applies viewport transform changes within one frame for zoom and combined wheel input', async (
    { page },
    testInfo,
  ) => {
    await gotoApp(page);
    await seedCanvasItems(page, 500, 'image');

    const zoomOnly = await measureTransformLatency(page, [
      { deltaY: -500, ctrlKey: true },
    ]);
    const combined = await measureTransformLatency(page, [
      { deltaY: -120, ctrlKey: true },
      { deltaX: 50, deltaY: 30 },
    ]);

    const metrics = {
      zoomOnly,
      zoomOnlyScale: extractScale(zoomOnly.transform),
      combined,
      combinedScale: extractScale(combined.transform),
      combinedTranslate: extractTranslate(combined.transform),
    };
    await attachJson(testInfo, 'viewport-transform-latency', metrics);

    expect(zoomOnly.changed).toBe(true);
    expect(zoomOnly.latencyMs).not.toBeNull();
    expect(zoomOnly.latencyMs ?? Number.POSITIVE_INFINITY).toBeLessThan(34);
    expect(extractScale(zoomOnly.transform)).toBeGreaterThan(1);

    expect(combined.changed).toBe(true);
    expect(combined.latencyMs).not.toBeNull();
    expect(combined.latencyMs ?? Number.POSITIVE_INFINITY).toBeLessThan(34);
    expect(extractScale(combined.transform)).toBeGreaterThan(1);
    expect(combined.mutationCount).toBeLessThanOrEqual(2);

    const combinedTranslate = extractTranslate(combined.transform);
    expect(Math.abs(combinedTranslate.x) + Math.abs(combinedTranslate.y)).toBeGreaterThan(
      0,
    );
  });

  test('records scalability metrics across item-count thresholds', async (
    { page },
    testInfo,
  ) => {
    test.slow();

    await gotoApp(page);

    const ttiFixture = await seedCanvasItems(page, 100, 'image');
    const results: ScalabilityMetric[] = [];

    for (const kind of ['image', 'deferredVideo'] as const) {
      for (const count of [50, 200, 500, 1000]) {
        const seeded = await seedCanvasItems(page, count, kind);
        const summary = await measureWheelPanPerformance(page);

        const metric = {
          count,
          kind,
          loadMs: seeded.loadMs,
          ...summary,
        };
        results.push(metric);

        expect(metric.fps).toBeGreaterThan(20);
        expect(metric.maxFrameMs).toBeLessThan(200);
      }
    }

    await attachJson(testInfo, 'scalability-metrics', {
      loadConfig100ItemsMs: ttiFixture.loadMs,
      results,
    });

    expect(ttiFixture.loadMs).toBeLessThan(1000);
  });

  test('keeps heap growth bounded across repeated add/delete cycles', async (
    { page },
    testInfo,
  ) => {
    test.slow();

    await gotoApp(page);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Runtime.enable');
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');

    const initialHeap = (await cdp.send('Runtime.getHeapUsage')).usedSize as number;
    const heapSamples = [initialHeap];

    for (let cycle = 0; cycle < 10; cycle += 1) {
      const paths = Array.from({ length: 20 }, (_, index) => {
        return `/tmp/e2e/leak-cycle-${cycle}-${index}.png`;
      });

      await dropFiles(page, paths);
      await expect(page.getByText('20 items')).toBeVisible();
      await waitForAnimationFrames(page, 2);

      await deleteAllItems(page);
      await cdp.send('HeapProfiler.collectGarbage');
      heapSamples.push((await cdp.send('Runtime.getHeapUsage')).usedSize as number);
    }

    await cdp.send('HeapProfiler.collectGarbage');
    const finalHeap = (await cdp.send('Runtime.getHeapUsage')).usedSize as number;
    const growthRatio = finalHeap / initialHeap;

    await attachJson(testInfo, 'heap-growth', {
      finalHeap,
      growthRatio,
      heapSamples,
      initialHeap,
    });

    expect(growthRatio).toBeLessThan(1.3);
  });
});

async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
}

async function measureWheelPanPerformance(page: Page) {
  await startFrameSampler(page);

  await page.evaluate(async () => {
    const container = document.querySelector('.canvas-container');
    if (!(container instanceof HTMLElement)) {
      throw new Error('Canvas container was not found.');
    }

    for (let index = 0; index < 60; index += 1) {
      container.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: 900,
          clientY: 520,
          deltaX: 18,
          deltaY: 12,
        }),
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });

  await waitForAnimationFrames(page, 2);

  return summarizeFrameSampler(await stopFrameSampler(page));
}

async function measureTransformLatency(
  page: Page,
  events: Array<{
    ctrlKey?: boolean;
    deltaX?: number;
    deltaY?: number;
  }>,
) {
  return page.evaluate((wheelEvents) => {
    const container = document.querySelector('.canvas-container');
    const world = document.querySelector('.canvas-world');

    if (!(container instanceof HTMLElement) || !(world instanceof HTMLElement)) {
      throw new Error('Canvas elements were not found.');
    }

    const startingTransform = world.style.transform;

    return new Promise<TransformLatencyResult>((resolve) => {
      const startedAt = performance.now();
      let firstMutationAt: number | null = null;
      let mutationCount = 0;

      const observer = new MutationObserver(() => {
        if (world.style.transform === startingTransform) return;

        mutationCount += 1;
        if (firstMutationAt === null) {
          firstMutationAt = performance.now();
        }
      });
      observer.observe(world, {
        attributes: true,
        attributeFilter: ['style'],
      });

      for (const event of wheelEvents) {
        container.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: 800,
            clientY: 480,
            ctrlKey: event.ctrlKey ?? false,
            deltaX: event.deltaX ?? 0,
            deltaY: event.deltaY ?? 0,
          }),
        );
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          observer.disconnect();
          resolve({
            changed: world.style.transform !== startingTransform,
            latencyMs:
              firstMutationAt === null ? null : firstMutationAt - startedAt,
            mutationCount,
            transform: world.style.transform,
          });
        });
      });
    });
  }, events);
}

function summarizeFrameSampler(result: FrameSamplerResult): FrameBudgetSummary {
  const frameDeltas = result.frameDeltas.filter((value) => Number.isFinite(value) && value > 0);
  if (frameDeltas.length === 0) {
    return {
      averageFrameMs: 0,
      fps: 0,
      frameCount: 0,
      jankLongTasks: result.longTasks.length,
      longTaskDurations: result.longTasks,
      maxFrameMs: 0,
      observationMs: result.observationMs,
      p50FrameMs: 0,
      p99FrameMs: 0,
    };
  }

  const sorted = [...frameDeltas].sort((left, right) => left - right);
  const averageFrameMs =
    frameDeltas.reduce((sum, value) => sum + value, 0) / frameDeltas.length;

  return {
    averageFrameMs,
    fps: averageFrameMs > 0 ? 1000 / averageFrameMs : 0,
    frameCount: frameDeltas.length,
    jankLongTasks: result.longTasks.filter((duration) => duration >= 50).length,
    longTaskDurations: result.longTasks,
    maxFrameMs: sorted[sorted.length - 1],
    observationMs: result.observationMs,
    p50FrameMs: percentile(sorted, 0.5),
    p99FrameMs: percentile(sorted, 0.99),
  };
}

function percentile(sortedValues: number[], fraction: number) {
  if (sortedValues.length === 0) return 0;

  const index = Math.min(
    sortedValues.length - 1,
    Math.floor(sortedValues.length * fraction),
  );
  return sortedValues[index];
}

function extractScale(transform: string) {
  const match = /scale\(([^)]+)\)/.exec(transform);
  return match ? Number(match[1]) : 1;
}

function extractTranslate(transform: string) {
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(transform);

  return {
    x: match ? Number(match[1]) : 0,
    y: match ? Number(match[2]) : 0,
  };
}
