/// <reference types="node" />
import { availableParallelism } from 'node:os';

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
  SHELL_E2E_COMPOSITION_PORT: Schema.optionalKey(
    Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ maximum: 65_535, minimum: 1 }))),
  ),
  SHELL_SUPER_APP_PORT: Schema.optionalKey(
    Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ maximum: 65_535, minimum: 1 }))),
  ),
});
const playwrightConfig = Result.getOrThrow(Schema.decodeUnknownResult(playwrightConfigSchema)(configValues));
const port = playwrightConfig.SHELL_SUPER_APP_PORT ?? 3020;
const continuousIntegration = playwrightConfig.CI ?? false;
const origin = `http://127.0.0.1:${port}`;
const compositionPort = playwrightConfig.SHELL_E2E_COMPOSITION_PORT ?? 3021;
const compositionOrigin = `http://127.0.0.1:${compositionPort}`;
const compositionEnvironment = {
  ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN: '',
  ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `${compositionOrigin}/active`,
  SHELL_E2E_COMPOSITION_PORT: String(compositionPort),
  SHELL_SUPER_APP_PORT: String(port),
};

export default defineConfig({
  // Preserve one native Core module instance and let Node strip its type-only class fields.
  build: { external: ['**/packages/core-runtime/**'] },
  forbidOnly: continuousIntegration,
  fullyParallel: true,
  metadata: { activeApplicationCompositionUrl: `${compositionOrigin}/active` },
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
        ...compositionEnvironment,
        ULTRAMODERN_MF_DEV_ORIGIN: origin,
      },
      reuseExistingServer: false,
      url: 'http://127.0.0.1:4102/party-registry-api/party-registry/readiness',
    },
    {
      command: 'pnpm dev',
      cwd: '../../verticals/inventory',
      env: {
        ...compositionEnvironment,
        ULTRAMODERN_MF_DEV_ORIGIN: origin,
      },
      reuseExistingServer: false,
      url: 'http://127.0.0.1:4110/inventory-api/inventory/readiness',
    },
    {
      command: 'pnpm dev',
      env: compositionEnvironment,
      reuseExistingServer: false,
      url: `${origin}/en`,
    },
    {
      command: 'node tests/e2e/composition-fixture.mts',
      env: compositionEnvironment,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 40_000 },
      reuseExistingServer: false,
      url: `${compositionOrigin}/active`,
    },
  ],
  workers: Math.max(1, availableParallelism() - 1),
});
