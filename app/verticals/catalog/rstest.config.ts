import { defineConfig } from '@rstest/core';

const swc = { jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } } } as const;

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
      tools: { swc },
    },
  ],
  root: new URL('.', import.meta.url).pathname,
});
