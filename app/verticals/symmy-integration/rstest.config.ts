import { defineConfig } from '@rstest/core';

const root = new URL('.', import.meta.url).pathname;
const swc = { jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } } } as const;

export default defineConfig({
  projects: [
    {
      include: ['tests/unit/**/*.test.ts'],
      name: 'unit',
      root,
      testEnvironment: 'node',
      // Slowest unit test measured 454 ms in gates runs 43616061381 and 43844802542; budget is the
      // 2400 ms floor these configs share, not the silent 5000 ms Rstest default.
      testTimeout: 2400,
      tools: { swc },
    },
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      root,
      testEnvironment: 'node',
      tools: { swc },
    },
  ],
  root,
});
