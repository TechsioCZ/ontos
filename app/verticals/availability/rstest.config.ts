import { defineConfig } from '@rstest/core';

export default defineConfig({
  projects: [
    {
      include: ['tests/unit/**/*.test.ts'],
      name: 'unit',
      root: new URL('.', import.meta.url).pathname,
      testEnvironment: 'node',
      // Four times the slowest unit test measured here, 635 ms in gates runs 43616061381 and
      // 43844802542, instead of the silent 5000 ms Rstest default.
      testTimeout: 2540,
      tools: { swc: { jsc: { parser: { syntax: 'typescript' } } } },
    },
  ],
  root: new URL('.', import.meta.url).pathname,
});
