import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:1420',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 1000 },
      },
    },
  ],
  webServer: {
    command: 'pnpm run dev --host 127.0.0.1',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
