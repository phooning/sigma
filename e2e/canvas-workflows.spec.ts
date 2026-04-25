import { expect, test } from '@playwright/test';
import {
  dropFiles,
  gotoApp,
  mediaItems,
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
