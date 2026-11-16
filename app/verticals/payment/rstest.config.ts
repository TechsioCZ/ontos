import { defineConfig } from '@rstest/core';

const swc = {
  jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } },
} as const;

export default defineConfig({
  projects: [
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      root: new URL('.', import.meta.url).pathname,
      setupFiles: [new URL('../../scripts/ci/integration-worker-setup.mts', import.meta.url).pathname],
      testEnvironment: 'node',
      testTimeout: 30_000,
      tools: { swc },
    },
    {
      // Opt-in provider sandbox conformance (#1159 level 4). Without ONTOS_C17_SANDBOX_* credentials
      // every scenario is skipped as NOT RUN; the unit and integration globs never include these files.
      include: ['tests/sandbox/**/*.test.ts'],
      name: 'sandbox',
      root: new URL('.', import.meta.url).pathname,
      testEnvironment: 'node',
      testTimeout: 120_000,
      tools: { swc },
    },
    {
      include: ['tests/unit/**/*.test.ts'],
      name: 'unit',
      root: new URL('.', import.meta.url).pathname,
      testEnvironment: 'node',
      // Four times the slowest unit test measured here, 680 ms in gates runs 43616061381 and
      // 43844802542, instead of the silent 5000 ms Rstest default.
      testTimeout: 2720,
      tools: { swc },
    },
  ],
  root: new URL('.', import.meta.url).pathname,
});
