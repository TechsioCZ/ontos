import { createRequire } from 'node:module';

import { withModernConfig } from '@modern-js/adapter-rstest';
import { defineConfig } from '@rstest/core';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

// Migration scripts contain generic arrows in .mts files, supported by TypeScript.
const swc = {
  jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } },
} as const;

const workerCycleIntegrationTest = 'tests/integration/party-identity-runtime.test.ts';

export default defineConfig({
  // Both integration projects mutate one database; serialize them even when invoked directly.
  pool: { maxWorkers: 1 },
  projects: [
    {
      name: 'component',
      clearMocks: true,
      extends: withModernConfig({
        configPath: './modern.rstest.config.ts',
      }),
      include: ['tests/components/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
      output: {
        module: true,
      },
      restoreMocks: true,
      testEnvironment: 'happy-dom',
    },
    {
      name: 'integration',
      testEnvironment: 'node',
      setupFiles: ['./tests/integration/application-composition.setup.ts'],
      include: ['tests/integration/**/*.test.ts'],
      exclude: [workerCycleIntegrationTest],
      testTimeout: 30_000,
    },
    {
      // Party worker cycles claim outbox work across every tenant, so this file
      // must never run alongside the other integration files.
      name: 'integration-worker-cycle',
      testEnvironment: 'node',
      setupFiles: ['./tests/integration/application-composition.setup.ts'],
      include: [workerCycleIntegrationTest],
      testTimeout: 30_000,
    },
    {
      name: 'unit',
      testEnvironment: 'node',
      include: ['tests/unit/**/*.test.ts'],
      tools: { swc },
    },
  ],
});
