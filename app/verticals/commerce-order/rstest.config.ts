import { defineConfig } from '@rstest/core';

const swc = { jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } } } as const;
const root = new URL('.', import.meta.url).pathname;

export default defineConfig({
  projects: [
    { include: ['tests/unit/**/*.test.ts'], name: 'unit', root, testEnvironment: 'node', tools: { swc } },
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      root,
      testEnvironment: 'node',
      testTimeout: 120_000,
      tools: { swc },
    },
  ],
  root,
});
