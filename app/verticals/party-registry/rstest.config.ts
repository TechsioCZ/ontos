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
      plugins: [
        {
          name: 'ontos:component-without-ssr-compilation',
          remove: ['@modern-js/builder-plugin-ssr'],
          setup() {
            // Browser component tests do not compile production SSR output.
          },
        },
      ],
      restoreMocks: true,
      testEnvironment: 'happy-dom',
    },
    {
      name: 'integration',
      testEnvironment: 'node',
      setupFiles: [
        '../../scripts/ci/integration-worker-setup.mts',
        './tests/integration/application-composition.setup.ts',
      ],
      // A negated include pattern, not `exclude`: a command-line --exclude (the shard tasks of
      // scripts/ci/run-integration-suites.sh) replaces a project's exclude list, so this file would rejoin the suite.
      include: ['tests/integration/**/*.test.ts', `!${workerCycleIntegrationTest}`],
      testTimeout: 30_000,
      tools: { swc },
    },
    {
      // Party worker cycles claim outbox work across every tenant, so this file
      // must never run alongside the other integration files.
      name: 'integration-worker-cycle',
      testEnvironment: 'node',
      setupFiles: [
        '../../scripts/ci/integration-worker-setup.mts',
        './tests/integration/application-composition.setup.ts',
      ],
      include: [workerCycleIntegrationTest],
      testTimeout: 30_000,
      tools: { swc },
    },
    {
      name: 'unit',
      testEnvironment: 'node',
      include: ['tests/unit/**/*.test.ts'],
      // Four times the slowest unit test without its own budget, 748 ms in gates runs 43616061381
      // and 43844802542, instead of the silent 5000 ms Rstest default.
      testTimeout: 2992,
      tools: { swc },
    },
  ],
});
