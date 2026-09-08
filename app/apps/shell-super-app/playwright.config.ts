import path from 'node:path';

import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';
import { defineConfig, devices } from '@playwright/test';
import { Config, Result, Schema } from 'effect';

const nodeFileSystem = process.getBuiltinModule('node:fs');
const nodeProcess = process.getBuiltinModule('node:process');
const nodeUtilities = process.getBuiltinModule('node:util');
const fileConfig = nodeFileSystem.existsSync(APP_ENV_PATH)
  ? Result.getOrThrow(
      Result.try(() =>
        nodeUtilities.parseEnv(
          nodeFileSystem.readFileSync(APP_ENV_PATH, 'utf-8')
        )
      )
    )
  : {};
const configValues = { ...fileConfig, ...nodeProcess.env };
const playwrightConfigSchema = Schema.Struct({
  CI: Schema.optionalKey(Config.Boolean),
  SHELL_SUPER_APP_PORT: Schema.optionalKey(
    Schema.NumberFromString.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isBetween({ maximum: 65_535, minimum: 1 })
      )
    )
  ),
});
const playwrightConfig = Result.getOrThrow(
  Schema.decodeUnknownResult(playwrightConfigSchema)(configValues)
);
const port = playwrightConfig.SHELL_SUPER_APP_PORT ?? 3020;
const continuousIntegration = playwrightConfig.CI ?? false;
const origin = `http://127.0.0.1:${port}`;
const repositoryRoot = path.resolve(process.cwd(), '../../..');
const e2eSourceRevision = '0000000000000000000000000000000000000001';

export default defineConfig({
  forbidOnly: continuousIntegration,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  reporter: 'line',
  retries: continuousIntegration ? 2 : 0,
  testDir: './tests/e2e',
  use: {
    baseURL: origin,
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: 'pnpm dev',
      cwd: '../../verticals/party-registry',
      env: {
        GIT_CEILING_DIRECTORIES: repositoryRoot,
        ULTRAMODERN_MF_DEV_ORIGIN: origin,
        ULTRAMODERN_SOURCE_REVISION: e2eSourceRevision,
      },
      reuseExistingServer: !continuousIntegration,
      url: 'http://127.0.0.1:4102/en',
    },
    {
      command: 'pnpm dev',
      reuseExistingServer: !continuousIntegration,
      url: `${origin}/en`,
    },
  ],
});
