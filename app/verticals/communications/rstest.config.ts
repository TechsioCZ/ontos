import { defineConfig } from '@rstest/core';

const swc = {
  jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } },
} as const;

export default defineConfig({
  projects: [
    {
      include: ['tests/unit/**/*.test.ts'],
      name: 'unit',
      root: new URL('.', import.meta.url).pathname,
      testEnvironment: 'node',
      // Four times the slowest unit test measured here, instead of the silent 5000 ms Rstest default.
      testTimeout: 2720,
      tools: { swc },
    },
  ],
  root: new URL('.', import.meta.url).pathname,
});
