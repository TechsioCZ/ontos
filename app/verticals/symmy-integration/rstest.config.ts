import { defineConfig } from '@rstest/core';

const root = new URL('.', import.meta.url).pathname;
const swc = { jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } } } as const;

export default defineConfig({
  projects: [
    { include: ['tests/unit/**/*.test.ts'], name: 'unit', root, testEnvironment: 'node', tools: { swc } },
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
