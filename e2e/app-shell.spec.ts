import { expect, test } from '@playwright/test';
import { gotoApp, openSettings } from './helpers';

test('opens the settings dialog from the HUD and closes it with Escape', async ({
  page,
}) => {
  await gotoApp(page);
  await openSettings(page);

  await expect(page.getByRole('tab', { name: 'General' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Appearance' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Hotkeys' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Debug' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'About' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
});

test('persists the selected canvas background pattern across reloads', async ({
  page,
}) => {
  await gotoApp(page);
  await openSettings(page);

  await page.getByRole('tab', { name: 'Appearance' }).click();
  await page.getByRole('radio', { name: 'Grid background' }).click();

  await expect(page.locator('.canvas-background.grid')).toBeVisible();

  await page.reload({ waitUntil: 'networkidle' });

  await expect(page.locator('.canvas-background.grid')).toBeVisible();
  await openSettings(page);
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await expect(page.getByRole('radio', { name: 'Grid background' })).toHaveAttribute(
    'data-state',
    'on',
  );
});

test('shows the development overlay when debug mode is enabled', async ({
  page,
}) => {
  await gotoApp(page);
  await openSettings(page);

  await page.getByRole('tab', { name: 'Debug' }).click();
  await page.getByRole('switch', { name: /development mode/i }).click();

  await expect(page.getByLabel('Development stats')).toBeVisible();
  await expect(page.getByText('FPS')).toBeVisible();
  await expect(page.getByText('GPU usage')).toBeVisible();
});
