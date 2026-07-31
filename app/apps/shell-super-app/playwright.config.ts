import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  forbidOnly: Boolean(process.env['CI']),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  reporter: 'line',
  retries: process.env['CI'] ? 2 : 0,
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://127.0.0.1:3020',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm exec modern build && pnpm serve',
    reuseExistingServer: !process.env['CI'],
    url: 'http://127.0.0.1:3020/en',
  },
});
