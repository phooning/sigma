import { expect, test } from '@playwright/test';
import {
  dropFiles,
  gotoApp,
  mediaItems,
  seedCanvasItems,
  setSaveDialogResult,
} from './helpers';

test('adds media through drag and drop, selects it, and deletes it with the keyboard', async ({
  page,
}) => {
  await gotoApp(page);
  await dropFiles(page, ['/tmp/moodboard-frame.png']);

  await expect(page.getByText('1 items')).toBeVisible();
  await expect(mediaItems(page)).toHaveCount(1);

  const mediaItem = mediaItems(page).first();
  await mediaItem.click({ position: { x: 400, y: 200 } });
  await expect(mediaItem).toHaveClass(/selected/);

  await page.keyboard.press('Delete');

  await expect(page.getByText('0 items')).toBeVisible();
  await expect(mediaItems(page)).toHaveCount(0);
});

test('keeps media locked to the drop position after a drag release', async ({
  page,
}) => {
  await gotoApp(page);
  await seedCanvasItems(page, 1, 'image');

  const mediaItem = mediaItems(page).first();
  const box = await mediaItem.boundingBox();
  if (!box) {
    throw new Error('Expected one visible media item to drag.');
  }

  const samplesPromise = page.evaluate(() => {
    return new Promise<
      Array<{
        x: number;
        y: number;
        transform: string;
        transition: string;
      }>
    >((resolve, reject) => {
      const item = document.querySelector('.media-item');
      const container = document.querySelector('.canvas-container');

      if (
        !(item instanceof HTMLElement) ||
        !(container instanceof HTMLElement)
      ) {
        reject(new Error('Canvas drag targets were not found.'));
        return;
      }

      const samples: Array<{
        x: number;
        y: number;
        transform: string;
        transition: string;
      }> = [];

      const sample = () => {
        const rect = item.getBoundingClientRect();
        const style = getComputedStyle(item);
        samples.push({
          x: rect.x,
          y: rect.y,
          transform: style.transform,
          transition: style.transition,
        });

        if (samples.length >= 18) {
          resolve(samples);
          return;
        }

        requestAnimationFrame(sample);
      };

      container.addEventListener(
        'pointerup',
        () => requestAnimationFrame(sample),
        { once: true },
      );
    });
  });

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const endX = startX + 620;
  const endY = startY + 330;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 2 });
  await page.mouse.up();

  const samples = await samplesPromise;
  const first = samples[0];
  const sampledPositions = new Set(
    samples.map((sample) => `${sample.x.toFixed(3)},${sample.y.toFixed(3)}`),
  );
  const animatedTransformSamples = samples.filter(
    (sample) =>
      sample.transition.includes('transform') ||
      sample.transform !== first.transform,
  );

  expect(sampledPositions.size).toBe(1);
  expect(animatedTransformSamples).toHaveLength(0);
});

test('shows audio controls and exports the currently selected video', async ({
  page,
}) => {
  await gotoApp(page);
  await dropFiles(page, ['/tmp/selects/rough-cut.mp4']);

  await expect(page.getByText('1 items')).toBeVisible();

  const mediaItem = mediaItems(page).first();
  await mediaItem.click({ position: { x: 400, y: 200 } });

  await expect(
    page.getByRole('button', { name: 'Export selected video' }),
  ).toBeVisible();

  await mediaItem.getByRole('button', { name: 'Enable audio playback' }).click();

  await expect(
    page.getByRole('button', { name: 'Mute audio' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Audio clip: rough-cut.mp4' }),
  ).toBeVisible();
  await expect(
    page.getByRole('slider', { name: 'Volume for rough-cut.mp4' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Mute audio' }).click();
  await expect(
    page.getByRole('button', { name: 'Unmute audio' }),
  ).toBeVisible();

  await setSaveDialogResult(page, '/tmp/playwright-export');
  await page.getByRole('button', { name: 'Export selected video' }).click();

  await expect(page.getByText('Export complete')).toBeVisible();
  await expect(page.getByText('/tmp/playwright-export.mp4')).toBeVisible();
});
