import path from 'node:path';
import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';
import { defineConfig, devices } from '@playwright/test';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: APP_ENV_PATH, quiet: true });

const port = Number(process.env.SHELL_SUPER_APP_PORT ?? 3020);
const origin = `http://127.0.0.1:${port}`;
const repositoryRoot = path.resolve(process.cwd(), '../../..');
const e2eSourceRevision = '0000000000000000000000000000000000000001';

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  reporter: 'line',
  retries: process.env.CI ? 2 : 0,
  testDir: './tests/e2e',
  use: {
    baseURL: origin,
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'pnpm dev',
      cwd: '../../verticals/contacts',
      env: {
        GIT_CEILING_DIRECTORIES: repositoryRoot,
        ULTRAMODERN_MF_DEV_ORIGIN: origin,
        ULTRAMODERN_SOURCE_REVISION: e2eSourceRevision,
      },
      reuseExistingServer: !process.env.CI,
      url: 'http://127.0.0.1:4101/en',
    },
    {
      command: 'pnpm dev',
      reuseExistingServer: !process.env.CI,
      url: `${origin}/en`,
    },
  ],
});
