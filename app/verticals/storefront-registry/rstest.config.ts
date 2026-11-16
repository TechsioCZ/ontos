import { defineConfig } from '@rstest/core';

const swc = { jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } } } as const;

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
      include: ['tests/unit/**/*.test.ts'],
      name: 'unit',
      root: new URL('.', import.meta.url).pathname,
      testEnvironment: 'node',
      // No unit test here reached the runner's 300 ms slow report in gates runs 43616061381 or
      // 43844802542; budget is the 2400 ms floor these configs share, not the silent 5000 ms default.
      testTimeout: 2400,
      tools: { swc },
    },
  ],
  root: new URL('.', import.meta.url).pathname,
});
