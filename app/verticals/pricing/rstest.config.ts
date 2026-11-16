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
      testEnvironment: 'node',
      testTimeout: 30_000,
      tools: { swc },
    },
    {
      include: ['tests/unit/**/*.test.ts'],
      name: 'unit',
      root: new URL('.', import.meta.url).pathname,
      testEnvironment: 'node',
      // Four times the slowest unit test measured here, 3_430 ms in gates runs 43616061381 and
      // 43844802542. The silent 5000 ms Rstest default left that test only 1.5x headroom.
      testTimeout: 13_720,
      tools: { swc },
    },
  ],
  root: new URL('.', import.meta.url).pathname,
});
