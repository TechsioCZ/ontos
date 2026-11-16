import { defineConfig } from '@rstest/core';

const swc = { jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } } } as const;
const root = new URL('.', import.meta.url).pathname;

export default defineConfig({
  projects: [
    {
      include: ['tests/unit/**/*.test.ts'],
      name: 'unit',
      root,
      testEnvironment: 'node',
      // Four times the slowest unit test measured here, 1_620 ms in gates runs 43616061381 and
      // 43844802542, instead of the silent 5000 ms Rstest default.
      testTimeout: 6480,
      tools: { swc },
    },
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      root,
      setupFiles: ['../../scripts/ci/integration-worker-setup.mts'],
      testEnvironment: 'node',
      testTimeout: 120_000,
      tools: { swc },
    },
  ],
  root,
});
