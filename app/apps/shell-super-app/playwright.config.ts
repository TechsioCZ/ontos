import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env['SHELL_SUPER_APP_PORT'] ?? 3020);
const origin = `http://127.0.0.1:${port}`;

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
    baseURL: origin,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm exec modern build && pnpm serve',
    reuseExistingServer: !process.env['CI'],
    url: `${origin}/en`,
  },
});
