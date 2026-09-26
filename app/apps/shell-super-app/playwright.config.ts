/// <reference types="node" />
import { availableParallelism } from 'node:os';
import path from 'node:path';

import { APP_ENV_PATH } from '@app/core-runtime/workspace-environment';
import { defineConfig, devices } from '@playwright/test';
import { Result, Schema, SchemaTransformation } from 'effect';

const nodeFileSystem = process.getBuiltinModule('node:fs');
const nodeProcess = process.getBuiltinModule('node:process');
const nodeUtilities = process.getBuiltinModule('node:util');
const fileConfig = nodeFileSystem.existsSync(APP_ENV_PATH)
  ? Result.getOrThrow(Result.try(() => nodeUtilities.parseEnv(nodeFileSystem.readFileSync(APP_ENV_PATH, 'utf-8'))))
  : {};
const configValues = { ...fileConfig, ...nodeProcess.env };
// Same literal set Effect's Config.Boolean accepts; Config itself is Effect-only and this file stays synchronous.
const BooleanFromEnvironmentSchema = Schema.Literals([
  'true',
  'yes',
  'on',
  '1',
  'y',
  'false',
  'no',
  'off',
  '0',
  'n',
]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (value) => value === 'true' || value === 'yes' || value === 'on' || value === '1' || value === 'y',
      encode: (value) => (value ? 'true' : 'false'),
    }),
  ),
);
const playwrightConfigSchema = Schema.Struct({
  CI: Schema.optionalKey(BooleanFromEnvironmentSchema),
  SHELL_SUPER_APP_PORT: Schema.optionalKey(
    Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ maximum: 65_535, minimum: 1 }))),
  ),
});
const playwrightConfig = Result.getOrThrow(Schema.decodeUnknownResult(playwrightConfigSchema)(configValues));
const port = playwrightConfig.SHELL_SUPER_APP_PORT ?? 3020;
const continuousIntegration = playwrightConfig.CI ?? false;
const origin = `http://127.0.0.1:${port}`;
const repositoryRoot = path.resolve(process.cwd(), '../../..');
const e2eSourceRevision = '0000000000000000000000000000000000000001';

export default defineConfig({
  // Preserve one native Core module instance and let Node strip its type-only class fields.
  build: { external: ['**/packages/core-runtime/**'] },
  forbidOnly: continuousIntegration,
  fullyParallel: true,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  reporter: 'line',
  retries: 0,
  testDir: './tests/e2e',
  use: {
    baseURL: origin,
    trace: 'retain-on-failure',
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
      url: 'http://127.0.0.1:4102/party-registry-api/party-registry/readiness',
    },
    {
      command: 'pnpm dev',
      reuseExistingServer: !continuousIntegration,
      url: `${origin}/en`,
    },
  ],
  workers: Math.max(1, availableParallelism() - 1),
});
